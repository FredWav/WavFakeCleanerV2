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

const DB_NAME = "wavfakecleaner";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // Followers store
        if (!db.objectStoreNames.contains("followers")) {
          const store = db.createObjectStore("followers", { keyPath: "username" });
          store.createIndex("status", "status");
          store.createIndex("score", "score");
          store.createIndex("scanned", "scanned");
          store.createIndex("isFake", "isFake");
        }
        // Action log store
        if (!db.objectStoreNames.contains("actionLog")) {
          const store = db.createObjectStore("actionLog", {
            keyPath: "id",
            autoIncrement: true,
          });
          store.createIndex("createdAt", "createdAt");
          store.createIndex("actionType", "actionType");
        }
        // Scan sessions store
        if (!db.objectStoreNames.contains("scanSessions")) {
          const store = db.createObjectStore("scanSessions", {
            keyPath: "id",
            autoIncrement: true,
          });
          store.createIndex("status", "status");
        }
      },
    });
  }
  return dbPromise;
}

// ── Follower CRUD ──

export async function upsertFollower(record: FollowerRecord): Promise<void> {
  const db = await getDb();
  await db.put("followers", record);
}

export async function upsertFollowers(records: FollowerRecord[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("followers", "readwrite");
  for (const record of records) {
    await tx.store.put(record);
  }
  await tx.done;
}

export async function getFollower(username: string): Promise<FollowerRecord | undefined> {
  const db = await getDb();
  return db.get("followers", username);
}

export async function getFollowers(filter?: {
  status?: string;
  limit?: number;
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
  const existing = await db.get("followers", username);
  if (existing) {
    await db.put("followers", { ...existing, ...updates });
  }
}

export async function getFollowersPending(limit: number): Promise<FollowerRecord[]> {
  const db = await getDb();
  const all = await db.getAllFromIndex("followers", "status", "pending");
  return all.slice(0, limit);
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

export async function getFollowersFake(): Promise<FollowerRecord[]> {
  const db = await getDb();
  const all = await db.getAll("followers");
  return all.filter((f) => f.isFake && !f.removed && !f.approved);
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

  return {
    totalFollowers,
    pending,
    scanned,
    fakes,
    toReview,
    removed,
    isRunning,
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

export async function getPipelineState(): Promise<PipelineState> {
  const result = await chrome.storage.local.get("pipelineState");
  return (
    result.pipelineState || {
      stage: "idle",
      sessionId: null,
      progress: 0,
      total: 0,
      lastError: null,
    }
  );
}

export async function savePipelineState(state: PipelineState): Promise<void> {
  await chrome.storage.local.set({ pipelineState: state });
}

// ── Rate state (persisted for service worker restart recovery) ──

export interface RateState {
  hourlyCount: number;
  dailyCount: number;
  hourKey: string;
  dayKey: string;
  consecutiveErrors: number;
  recentResults: boolean[];
}

export async function getRateState(): Promise<RateState> {
  const result = await chrome.storage.local.get("rateState");
  return (
    result.rateState || {
      hourlyCount: 0,
      dailyCount: 0,
      hourKey: "",
      dayKey: "",
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

export async function getLicense(): Promise<LicenseInfo> {
  const result = await chrome.storage.local.get("license");
  return result.license || { active: false, key: null, activatedAt: null };
}

export async function saveLicense(license: LicenseInfo): Promise<void> {
  await chrome.storage.local.set({ license });
}

// ── Daily usage counters (for free tier limits) ──

interface DailyUsage {
  dayKey: string;
  scans: number;
  removals: number;
}

export async function getDailyUsage(): Promise<DailyUsage> {
  const result = await chrome.storage.local.get("dailyUsage");
  const today = new Date().toISOString().slice(0, 10);
  const usage = result.dailyUsage as DailyUsage | undefined;
  if (!usage || usage.dayKey !== today) {
    return { dayKey: today, scans: 0, removals: 0 };
  }
  return usage;
}

export async function incrementDailyUsage(
  field: "scans" | "removals",
  count = 1
): Promise<DailyUsage> {
  const usage = await getDailyUsage();
  usage[field] += count;
  await chrome.storage.local.set({ dailyUsage: usage });
  return usage;
}
