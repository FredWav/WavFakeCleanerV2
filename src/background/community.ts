/**
 * Community voting — submit votes after scanning, lookup community scores.
 *
 * Only licensed users (with a communityToken) can submit votes.
 * Lookup is open to anyone (no auth required server-side).
 *
 * Every outcome (sent, queued, dropped, token invalid) is recorded through
 * community-events.ts — nothing on this path fails silently anymore.
 */

import {
  COMMUNITY_VOTE_URL,
  COMMUNITY_REPORT_SIGHTINGS_URL,
  COMMUNITY_CHECK_SIGHTINGS_URL,
  COMMUNITY_TOKEN_CHECK_URL,
} from "@shared/constants";
import type { CommunityStatus, CommunityTokenStatus } from "@shared/types";
import { getLicense } from "./storage";
import {
  recordCommunityEvent,
  recordReplaySummary,
  setTokenStatus,
  getCommunityStatusSnapshot,
} from "./community-events";

// ── Crypto helpers ──

async function sha256Hex(str: string): Promise<string> {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomNonce(): string {
  // 16 octets (128 bits) → 32 hex (S-M3). 8 octets (64 bits) exposaient au
  // paradoxe des anniversaires : collisions possibles à mesure que la table
  // `nonces` se remplit, rejetant à tort un vote légitime (nonce_replayed).
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Licence gate ──

async function getActiveCommunityToken(): Promise<string | null> {
  const license = await getLicense();
  if (!license.active) return null;
  // Use communityToken if available, otherwise fall back to the Stripe session ID directly
  const token = license.communityToken || license.key;
  if (!token) return null;
  // Owner/beta licences (Ed25519, validated locally) have no Worker-issued
  // community token — their "owner-<id>" handle is not in the tokens table,
  // so every submit would 403. Skip community features for them entirely.
  if (token.startsWith("owner-")) return null;
  return token;
}

// ── Persisted retry queue ──
// Network failures, 5xx and 429 responses go here; the alarm in
// service-worker.ts replays them every 15 min. Other 4xx responses
// (auth/validation) are dropped — they'd fail forever. The queue is capped to
// bound storage growth even in pathological scenarios (offline for days, or a
// misconfigured Worker), and entries expire after a TTL.

const QUEUE_KEY = "wfc_community_queue";
export const QUEUE_MAX_ENTRIES = 500;
export const QUEUE_MAX_ATTEMPTS = 5;
export const QUEUE_TTL_MS = 7 * 24 * 3_600_000; // 7 days
export const SIGHTINGS_BATCH_MAX = 50; // Worker-side cap on /report-sightings

interface QueuedVote {
  kind: "vote";
  body: { targetHash: string; communityToken: string; verdict: string; score: number; ts: number; nonce: string };
  attempts: number;
  enqueuedAt: number;
}

interface QueuedSightings {
  kind: "sightings";
  body: { communityToken: string; targetHashes: string[]; ts: number; nonce: string };
  attempts: number;
  enqueuedAt: number;
}

type QueuedItem = QueuedVote | QueuedSightings;

/** Contributions represented by one queue item (vote = 1, sightings = batch size). */
function itemCount(item: Pick<QueuedItem, "kind" | "body">): number {
  return item.kind === "vote" ? 1 : (item.body as QueuedSightings["body"]).targetHashes.length;
}

function dropKind(item: Pick<QueuedItem, "kind">): "vote_dropped" | "sightings_dropped" {
  return item.kind === "vote" ? "vote_dropped" : "sightings_dropped";
}

async function readQueue(): Promise<QueuedItem[]> {
  try {
    const result = await chrome.storage.local.get(QUEUE_KEY);
    const items = result[QUEUE_KEY];
    return Array.isArray(items) ? items as QueuedItem[] : [];
  } catch {
    await recordCommunityEvent({ kind: "storage_error", reason: "read" });
    return [];
  }
}

async function writeQueue(items: QueuedItem[]): Promise<{ ok: boolean; trimmed: number }> {
  // FIFO cap: drop oldest entries if we hit the ceiling. The caller reports
  // the trim so the loss is counted instead of silent.
  const trimmed = items.slice(-QUEUE_MAX_ENTRIES);
  const trimmedCount = items.length - trimmed.length;
  try {
    await chrome.storage.local.set({ [QUEUE_KEY]: trimmed });
    return { ok: true, trimmed: trimmedCount };
  } catch {
    // chrome.storage.local quota exhausted — the write is lost; the previous
    // queue state stays in storage.
    return { ok: false, trimmed: trimmedCount };
  }
}

/**
 * Add an item to the retry queue, deduplicating against what's already there:
 *   - votes: an older queued vote for the same target is replaced (last vote
 *     wins — matches the Worker's upsert semantics);
 *   - sightings: hashes merge into an existing batch when the union stays
 *     within the Worker's batch cap.
 */
async function enqueue(item: Omit<QueuedVote, "attempts" | "enqueuedAt"> | Omit<QueuedSightings, "attempts" | "enqueuedAt">): Promise<"queued" | "dropped_quota"> {
  const queue = await readQueue();
  let next: QueuedItem[];

  if (item.kind === "vote") {
    const targetHash = item.body.targetHash;
    next = queue.filter((q) => !(q.kind === "vote" && q.body.targetHash === targetHash));
    next.push({ ...item, attempts: 0, enqueuedAt: Date.now() });
  } else {
    next = [...queue];
    const incoming = item.body.targetHashes;
    const host = next.find(
      (q): q is QueuedSightings =>
        q.kind === "sightings" &&
        new Set([...q.body.targetHashes, ...incoming]).size <= SIGHTINGS_BATCH_MAX,
    );
    if (host) {
      host.body.targetHashes = Array.from(new Set([...host.body.targetHashes, ...incoming]));
      // New content deserves fresh delivery attempts and a fresh TTL.
      host.attempts = 0;
      host.enqueuedAt = Date.now();
    } else {
      next.push({ ...item, attempts: 0, enqueuedAt: Date.now() });
    }
  }

  const res = await writeQueue(next);
  if (!res.ok) {
    await recordCommunityEvent({ kind: dropKind(item), reason: "quota", count: itemCount(item), stage: "submit" });
    return "dropped_quota";
  }
  if (res.trimmed > 0) {
    await recordCommunityEvent({ kind: "queue_overflow", count: res.trimmed, stage: "submit" });
  }
  return "queued";
}

/**
 * Decide if a failed response should be retried later.
 *
 * Network errors (no response), 5xx and 429 → retry. 429 is transient by
 * definition (hourly rate-limit window) — dropping those votes was data loss.
 * Other 4xx → drop (auth invalid, malformed payload, replayed nonce).
 * 2xx → don't enqueue (already succeeded).
 */
export function shouldRetry(status: number | null): boolean {
  if (status === null) return true;       // network error
  if (status === 429) return true;        // rate-limited — window resets hourly
  if (status >= 500 && status < 600) return true;
  return false;
}

async function postJson(url: string, body: unknown): Promise<number | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.status;
  } catch {
    return null; // network error
  }
}

/** Shared outcome handling for first-try submissions (vote or sightings). */
async function handleSubmitOutcome(
  status: number | null,
  item: Omit<QueuedVote, "attempts" | "enqueuedAt"> | Omit<QueuedSightings, "attempts" | "enqueuedAt">,
): Promise<void> {
  const count = itemCount(item);

  if (status !== null && status >= 200 && status < 300) {
    await recordCommunityEvent({
      kind: item.kind === "vote" ? "vote_sent" : "sightings_sent",
      count,
      stage: "submit",
    });
    return;
  }

  if (shouldRetry(status)) {
    const outcome = await enqueue(item);
    if (outcome === "queued") {
      await recordCommunityEvent({
        kind: item.kind === "vote" ? "vote_enqueued" : "sightings_enqueued",
        reason: status === null ? "network" : `http_${status}`,
        httpStatus: status,
        count,
        stage: "submit",
      });
    }
    return;
  }

  await recordCommunityEvent({
    kind: dropKind(item),
    reason: status === 403 ? "http_403" : "http_4xx",
    httpStatus: status,
    count,
    stage: "submit",
  });
  if (status === 403) {
    void checkTokenHealth(true);
  }
}

// ── Submit vote ──
// Fire-and-forget: caller should .catch(() => {}) this.

export async function submitVote(
  username: string,
  verdict: "fake" | "ok" | "review",
  score: number,
): Promise<void> {
  const token = await getActiveCommunityToken();
  if (!token) return;

  const targetHash = await sha256Hex(username.toLowerCase());
  const body = {
    targetHash,
    communityToken: token,
    verdict,
    score,
    ts: Date.now(),
    nonce: randomNonce(),
  };

  const status = await postJson(COMMUNITY_VOTE_URL, body);
  await handleSubmitOutcome(status, { kind: "vote", body });
}

// ── Report sightings (manual fake confirmations) ──
// Fire-and-forget: caller should .catch(() => {}) this.

export async function reportSightings(usernames: string[]): Promise<void> {
  if (usernames.length === 0) return;

  const token = await getActiveCommunityToken();
  if (!token) return;

  const targetHashes: string[] = [];
  for (const u of usernames) {
    targetHashes.push(await sha256Hex(u.toLowerCase()));
  }

  const body = {
    communityToken: token,
    targetHashes,
    ts: Date.now(),
    nonce: randomNonce(),
  };

  const status = await postJson(COMMUNITY_REPORT_SIGHTINGS_URL, body);
  await handleSubmitOutcome(status, { kind: "sightings", body });
}

// ── Replay queued community calls ──
// Wired to a chrome.alarms tick in service-worker.ts (and to the sidepanel's
// "retry now" button via COMMUNITY_REPLAY_NOW). Best-effort: drains the queue
// while items succeed; transient failures stay queued for the next tick;
// persistent failures (4xx) and expired items are dropped — visibly.

export async function processCommunityQueue(): Promise<{ replayed: number; dropped: number; remaining: number }> {
  const queue = await readQueue();
  if (queue.length === 0) return { replayed: 0, dropped: 0, remaining: 0 };

  const surviving: QueuedItem[] = [];
  let replayed = 0;
  let dropped = 0;
  let tokenCheckTriggered = false;

  for (const item of queue) {
    const count = itemCount(item);

    // Items past their TTL are stale — drop before wasting a request.
    if (Date.now() - item.enqueuedAt > QUEUE_TTL_MS) {
      dropped++;
      await recordCommunityEvent({ kind: dropKind(item), reason: "expired", count, stage: "replay" });
      continue;
    }

    const url = item.kind === "vote" ? COMMUNITY_VOTE_URL : COMMUNITY_REPORT_SIGHTINGS_URL;
    // Refresh freshness fields before replay. The Worker rejects any ts older
    // than 5 min, but this alarm only fires every 15 min — so replaying the
    // original (stale) ts would ALWAYS fail validation (timestamp_expired → 4xx)
    // and the item would be dropped. The original request never reached the
    // server, so a fresh ts + nonce is a legitimate retry (vote = idempotent
    // upsert, sighting = INSERT OR IGNORE — a rare double-delivery is harmless).
    item.body.ts = Date.now();
    item.body.nonce = randomNonce();

    const status = await postJson(url, item.body);

    if (status !== null && status >= 200 && status < 300) {
      replayed++;
      await recordCommunityEvent({
        kind: item.kind === "vote" ? "vote_sent" : "sightings_sent",
        count,
        stage: "replay",
      });
      continue;
    }

    // Drop on non-retryable 4xx (won't improve on next tick) OR after too many attempts
    const nextAttempts = item.attempts + 1;
    if (!shouldRetry(status) || nextAttempts >= QUEUE_MAX_ATTEMPTS) {
      dropped++;
      const reason = !shouldRetry(status)
        ? (status === 403 ? "http_403" : "http_4xx")
        : "max_attempts";
      await recordCommunityEvent({ kind: dropKind(item), reason, httpStatus: status, count, stage: "replay" });
      if (status === 403 && !tokenCheckTriggered) {
        tokenCheckTriggered = true;
        void checkTokenHealth(true);
      }
      continue;
    }
    surviving.push({ ...item, attempts: nextAttempts });
  }

  const writeRes = await writeQueue(surviving);
  if (!writeRes.ok) {
    // The updated queue couldn't be persisted — stale items will replay again
    // next tick (harmless: the server dedups), but record the storage issue.
    await recordCommunityEvent({ kind: "storage_error", reason: "quota", stage: "replay" });
  }

  const summary = { replayed, dropped, remaining: surviving.length };
  await recordReplaySummary(summary);
  return summary;
}

// ── Token health ──
// A revoked/expired licence used to mean every vote 403'd and was dropped —
// forever, silently. This check makes that state visible (the sidepanel card
// shows "re-activate your licence").

const TOKEN_CHECK_MIN_INTERVAL_MS = 24 * 3_600_000; // lazy checks at most 1/day

export async function checkTokenHealth(force = false): Promise<CommunityTokenStatus> {
  const token = await getActiveCommunityToken();
  if (!token) return "unknown";

  if (!force) {
    const snapshot = await getCommunityStatusSnapshot();
    if (snapshot.tokenCheckedAt && Date.now() - snapshot.tokenCheckedAt < TOKEN_CHECK_MIN_INTERVAL_MS) {
      return snapshot.tokenStatus;
    }
  }

  let outcome: CommunityTokenStatus = "unknown";
  try {
    const res = await fetch(COMMUNITY_TOKEN_CHECK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ communityToken: token }),
    });
    if (res.ok) {
      const data = (await res.json()) as { valid?: boolean };
      outcome = data.valid ? "ok" : "invalid";
    }
    // non-2xx (rate-limited, 5xx) → inconclusive
  } catch {
    // network error → inconclusive
  }

  if (outcome === "invalid") {
    await recordCommunityEvent({ kind: "token_invalid", reason: "check" });
  } else if (outcome === "ok") {
    await setTokenStatus("ok");
  }
  // "unknown" is deliberately not persisted: a transient network failure must
  // not erase a known-good (or known-bad) status.
  return outcome;
}

// ── Status for the UI ──

export async function getCommunityStatus(): Promise<CommunityStatus> {
  const snapshot = await getCommunityStatusSnapshot();
  const queue = await readQueue();
  return { ...snapshot, queueLength: queue.length };
}

// ── Check sightings (no auth) ──

export async function checkSightings(usernames: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (usernames.length === 0) return result;

  const hashToUsername = new Map<string, string>();
  const targetHashes: string[] = [];
  for (const u of usernames) {
    const hash = await sha256Hex(u.toLowerCase());
    hashToUsername.set(hash, u);
    targetHashes.push(hash);
  }

  try {
    const res = await fetch(COMMUNITY_CHECK_SIGHTINGS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetHashes }),
    });
    if (!res.ok) {
      await recordCommunityEvent({
        kind: "lookup_failed",
        reason: `http_${res.status}`,
        httpStatus: res.status,
        stage: "scan",
      });
      return result;
    }

    const data = (await res.json()) as { results: Record<string, number> };
    for (const [hash, count] of Object.entries(data.results || {})) {
      const username = hashToUsername.get(hash);
      if (username) result.set(username, count);
    }
  } catch {
    await recordCommunityEvent({ kind: "lookup_failed", reason: "network", stage: "scan" });
  }

  return result;
}
