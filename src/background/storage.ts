/**
 * Storage layer — IndexedDB for followers/logs + chrome.storage for settings/state.
 *
 * Uses the `idb` library for a clean async IndexedDB API.
 */

import { openDB, type IDBPDatabase } from "idb";
import type {
  FollowerRecord,
  ActionLogRecord,
  ScanSessionRecord,
  Settings,
  PipelineState,
  Stats,
  FollowerStatus,
} from "@shared/types";
import { DEFAULT_SETTINGS } from "@shared/constants";

// ── IndexedDB schema ──
//
// Schema versioning convention (since v2.1):
//   - Each bump adds a case to upgrade(); never modify a past case.
//   - Stores and indexes are created idempotently (existence checks).
//   - Field additions don't need a version bump (just default in code) UNLESS
//     a new index is required.
//
// Version history:
//   v1: initial — followers, actionLog, scanSessions stores
//   v2: no schema change; placeholder establishing the upgrade chain so
//       future migrations have an obvious template to extend.

const DB_NAME = "wavfakecleaner";
const DB_VERSION = 2;

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        // v0 → v1: initial stores
        if (oldVersion < 1) {
          if (!db.objectStoreNames.contains("followers")) {
            const store = db.createObjectStore("followers", { keyPath: "username" });
            store.createIndex("status", "status");
            store.createIndex("score", "score");
            store.createIndex("scanned", "scanned");
            store.createIndex("isFake", "isFake");
          }
          if (!db.objectStoreNames.contains("actionLog")) {
            const store = db.createObjectStore("actionLog", {
              keyPath: "id",
              autoIncrement: true,
            });
            store.createIndex("createdAt", "createdAt");
            store.createIndex("actionType", "actionType");
          }
          if (!db.objectStoreNames.contains("scanSessions")) {
            const store = db.createObjectStore("scanSessions", {
              keyPath: "id",
              autoIncrement: true,
            });
            store.createIndex("status", "status");
          }
        }
        // v1 → v2: schema unchanged; reserved for future field/index additions.
        if (oldVersion < 2) {
          // No-op for now. Add new indexes or stores here when needed.
        }
      },
    }).catch((err) => {
      // Connexion échouée — reset pour permettre un nouvel essai au prochain appel
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

// ── Follower CRUD ──

export async function upsertFollowers(records: FollowerRecord[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("followers", "readwrite");
  try {
    // Fire all puts without awaiting each (idiomatic idb batching): requests
    // queue inside the transaction and tx.done surfaces any failure. Awaiting
    // per-put serializes on each round trip for no extra safety.
    for (const record of records) {
      void tx.store.put(record);
    }
    await tx.done;
  } catch (e) {
    try { tx.store.transaction.abort(); } catch { /* already aborted */ }
    throw e;
  }
}

export async function getFollower(username: string): Promise<FollowerRecord | undefined> {
  const db = await getDb();
  return db.get("followers", username);
}

export async function getAllFollowerUsernames(): Promise<Set<string>> {
  const db = await getDb();
  const keys = await db.getAllKeys("followers");
  return new Set(keys as string[]);
}

export async function getFollowers(filter?: {
  status?: string;
  limit?: number;
  search?: string;
}): Promise<FollowerRecord[]> {
  const db = await getDb();
  let results: FollowerRecord[];

  if (filter?.status) {
    const statusMap: Record<string, () => Promise<FollowerRecord[]>> = {
      pending: () => db.getAllFromIndex("followers", "status", "pending"),
      fake: () => db.getAllFromIndex("followers", "isFake", 1 as unknown as IDBValidKey),
      removed: () => db.getAllFromIndex("followers", "status", "removed"),
      review: async () => {
        const all = await db.getAll("followers");
        return all.filter((f) => f.toReview && !f.removed && !f.approved);
      },
      ok: async () => {
        const all = await db.getAll("followers");
        return all.filter((f) => f.scanned && !f.isFake && !f.toReview && !f.removed);
      },
    };
    const getter = statusMap[filter.status];
    results = getter ? await getter() : await db.getAll("followers");
  } else {
    results = await db.getAll("followers");
  }

  // Search filter (before sort/limit so we search the full DB)
  if (filter?.search) {
    const q = filter.search.toLowerCase();
    results = results.filter(
      (f) => f.username.toLowerCase().includes(q) || (f.fullName || "").toLowerCase().includes(q)
    );
  }

  // Sort by score descending (nulls last)
  results.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

  if (filter?.limit) {
    results = results.slice(0, filter.limit);
  }

  return results;
}

export async function updateFollower(
  username: string,
  updates: Partial<FollowerRecord>
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("followers", "readwrite");
  const existing = await tx.store.get(username);
  if (existing) {
    await tx.store.put({ ...existing, ...updates });
  }
  await tx.done;
}

export async function getFollowersPending(limit: number): Promise<FollowerRecord[]> {
  const db = await getDb();
  const all = await db.getAllFromIndex("followers", "status", "pending");
  return all.slice(0, limit);
}

/**
 * One-shot cleanup for the historical "owner-sub-page" bug (≤ 2.1.0):
 * the DOM fetch fallback used to ingest links like /@user/media as the
 * username "usermedia" because the slash was stripped before the
 * sub-page guard. Removes any persisted entry whose username matches
 * the pattern owner+<tab-suffix> (or the owner itself). Safe no-op when
 * no junk is present.
 */
export async function purgeOwnerSubPageFakes(ownerUsername: string): Promise<number> {
  if (!ownerUsername) return 0;
  const owner = ownerUsername.toLowerCase();
  const tabSuffixes = [
    "media", "replies", "tagged", "reposts", "saved",
    "followers", "following", "liked",
  ];
  const db = await getDb();
  const all = await db.getAll("followers");
  const tx = db.transaction("followers", "readwrite");
  let removed = 0;
  for (const f of all) {
    const u = (f.username || "").toLowerCase();
    if (u === owner || tabSuffixes.some((sfx) => u === owner + sfx)) {
      await tx.store.delete(f.username);
      removed++;
    }
  }
  await tx.done;
  return removed;
}

export async function resetScannedFollowers(): Promise<number> {
  const db = await getDb();
  const all = await db.getAll("followers");
  const tx = db.transaction("followers", "readwrite");
  let count = 0;
  for (const f of all) {
    if (f.scanned && !f.removed) {
      await tx.store.put({
        ...f,
        scanned: false,
        scannedAt: null,
        score: null,
        scoreBreakdown: null,
        isFake: null,
        toReview: false,
        approved: false,
        scanError: null,
        status: "pending" as FollowerStatus,
      });
      count++;
    }
  }
  await tx.done;
  return count;
}

// ── Action log ──

export async function addActionLog(log: Omit<ActionLogRecord, "id">): Promise<void> {
  const db = await getDb();
  await db.add("actionLog", log);
}

// ── Scan sessions ──

export async function createScanSession(
  session: Omit<ScanSessionRecord, "id">
): Promise<number> {
  const db = await getDb();
  return (await db.add("scanSessions", session)) as number;
}

export async function updateScanSession(
  id: number,
  updates: Partial<ScanSessionRecord>
): Promise<void> {
  const db = await getDb();
  const existing = await db.get("scanSessions", id);
  if (existing) {
    await db.put("scanSessions", { ...existing, ...updates });
  }
}

// ── Stats computation ──

export async function computeStats(isRunning: boolean, rateStats: Stats["rate"]): Promise<Stats> {
  const db = await getDb();
  const all = await db.getAll("followers");

  const totalFollowers = all.length;
  const pending = all.filter((f) => !f.scanned && !f.removed).length;
  const scanned = all.filter((f) => f.scanned).length;
  const fakes = all.filter((f) => f.isFake && !f.removed).length;
  const toReview = all.filter((f) => f.toReview && !f.removed && !f.approved).length;
  const removed = all.filter((f) => f.removed).length;

  // Surface the pipeline's last user-facing error so the side panel can show it.
  const pipelineState = await getPipelineState();
  const lastError = pipelineState?.lastError ?? null;
  const pausedUntil = pipelineState?.pausedUntil ?? null;
  const pauseReason = pipelineState?.pauseReason ?? null;

  return {
    totalFollowers,
    pending,
    scanned,
    fakes,
    toReview,
    removed,
    isRunning,
    lastError,
    pausedUntil,
    pauseReason,
    rate: rateStats,
  };
}

// ── Chrome storage for settings & state ──

export async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(result.settings || {}) };
}

export async function saveSettings(settings: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const updated = { ...current, ...settings };
  await chrome.storage.local.set({ settings: updated });
  return updated;
}

export async function getPipelineState(): Promise<PipelineState | null> {
  const result = await chrome.storage.local.get("pipelineState");
  return result.pipelineState || null;
}

export async function savePipelineState(state: PipelineState): Promise<void> {
  await chrome.storage.local.set({ pipelineState: state });
}

// ── Rate state (persisted for service worker restart recovery) ──

export interface RateState {
  hourlyCount: number;
  hourKey: string;
  consecutiveErrors: number;
  recentResults: boolean[];
}

export async function getRateState(): Promise<RateState> {
  const result = await chrome.storage.local.get("rateState");
  return (
    result.rateState || {
      hourlyCount: 0,
      hourKey: "",
      consecutiveErrors: 0,
      recentResults: [],
    }
  );
}

export async function saveRateState(state: RateState): Promise<void> {
  await chrome.storage.local.set({ rateState: state });
}

// ── License ──

import type { LicenseInfo } from "@shared/types";

// ── License: dual-storage with auto-restore ──
//
// Why two storages?
//   - chrome.storage.local survives normal use but is wiped if the user
//     uninstalls + reinstalls the browser (or the extension).
//   - chrome.storage.sync (≈ 100 KB total quota) is mirrored across the
//     user's Chrome instances via their Google account. Surviving a browser
//     reinstall requires only that the user signs back into Chrome with the
//     same account.
//
// We treat .local as the authoritative copy and .sync as a recovery mirror.
// On every save we write both. On read, if .local is empty but .sync has a
// licence, we restore it back into .local (so the next read is fast).

// Depuis 2026-07 : plus de paiement ni de licence. Tout le monde a l'accès
// COMPLET, gratuitement. getLicense() renvoie donc toujours un accès actif.
// Le seul reliquat est un identifiant anonyme stable qui sert de « jeton
// communautaire » (le Worker accepte les votes publics, rate-limités par ce
// jeton + l'IP). Aucune vérification, aucun déblocage conditionnel.
export async function getLicense(): Promise<LicenseInfo> {
  return {
    active: true,
    key: "free",
    activatedAt: 0,
    communityToken: await getAnonCommunityToken(),
    recoveryToken: null,
  };
}

// Jeton communautaire anonyme, généré une fois par installation et stable
// ensuite. Préfixe « anon- » (jamais « owner- », qui est filtré côté vote).
async function getAnonCommunityToken(): Promise<string> {
  const KEY = "wfc_anon_community_id";
  try {
    const r = await chrome.storage.local.get(KEY);
    if (typeof r[KEY] === "string" && r[KEY]) return r[KEY] as string;
    const id = "anon-" + crypto.randomUUID();
    await chrome.storage.local.set({ [KEY]: id });
    return id;
  } catch {
    return "anon-public";
  }
}

export async function saveLicense(license: LicenseInfo): Promise<void> {
  await chrome.storage.local.set({ license });
  // Best-effort mirror to sync. If the user is signed out of Chrome or the
  // sync quota is full (~100 KB), the mirror silently fails — the local
  // copy still works for this device.
  try {
    await chrome.storage.sync.set({ license });
  } catch {
    // sync unavailable — proceed with local-only persistence
  }
}

// ── License export / import (file-based recovery) ──
//
// The user can download a `.wfc-license.json` file containing the full
// licence record. They can re-import it after a browser reinstall, on
// another device, or send it to support if they need help.

const LICENSE_FILE_TYPE = "wfc-license-backup";
const LICENSE_FILE_VERSION = 1;

export interface LicenseBackup {
  type: typeof LICENSE_FILE_TYPE;
  version: number;
  savedAt: string;
  license: LicenseInfo;
}

/**
 * Build the backup payload the user can save as a JSON file. Returns null
 * if there's no licence to back up (user hasn't activated yet).
 *
 * The backup includes the recoveryToken (the original cs_live_… or
 * wfc_lic_… input) so re-activation works on any device.
 */
export async function exportLicenseBackup(): Promise<LicenseBackup | null> {
  const license = await getLicense();
  if (!license.active || !license.key) return null;
  return {
    type: LICENSE_FILE_TYPE,
    version: LICENSE_FILE_VERSION,
    savedAt: new Date().toISOString(),
    license,
  };
}

/**
 * Validate a backup payload (loaded from a user-supplied file) and return
 * the embedded activation token — caller passes it to ACTIVATE_LICENSE so
 * the normal verification path runs (Stripe re-check or Ed25519 sig check).
 *
 * Prefers `recoveryToken` (the original signed/checkout input). Falls back
 * to `key` for backups produced by older clients that didn't yet store the
 * recovery token. Returns null on any malformed input. Never trusts the
 * backup blindly — activation is what marks the licence valid.
 */
export function readLicenseBackup(payload: unknown): { key: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p.type !== LICENSE_FILE_TYPE) return null;
  if (typeof p.version !== "number" || p.version > LICENSE_FILE_VERSION) return null;
  const lic = p.license as Record<string, unknown> | undefined;
  if (!lic) return null;
  const recovery = typeof lic.recoveryToken === "string" ? lic.recoveryToken : "";
  const key = typeof lic.key === "string" ? lic.key : "";
  const chosen = recovery || key;
  if (!chosen) return null;
  return { key: chosen };
}

// ── Daily usage counters (for free tier limits) ──

interface DailyUsage {
  dayKey: string;
  cycles: number;
}

export async function getDailyUsage(): Promise<DailyUsage> {
  const result = await chrome.storage.local.get("dailyUsage");
  const today = new Date().toISOString().slice(0, 10);
  const usage = result.dailyUsage as DailyUsage | undefined;
  if (!usage || usage.dayKey !== today) {
    return { dayKey: today, cycles: 0 };
  }
  return usage;
}

export async function incrementDailyUsage(
  field: "cycles",
  count = 1
): Promise<DailyUsage> {
  const usage = await getDailyUsage();
  usage[field] += count;
  await chrome.storage.local.set({ dailyUsage: usage });
  return usage;
}
