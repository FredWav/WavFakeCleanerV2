/**
 * Community voting — submit votes after scanning, lookup community scores.
 *
 * Only licensed users (with a communityToken) can submit votes.
 * Lookup is open to anyone (no auth required server-side).
 */

import { COMMUNITY_VOTE_URL, COMMUNITY_REPORT_SIGHTINGS_URL, COMMUNITY_CHECK_SIGHTINGS_URL } from "@shared/constants";
import { getLicense } from "./storage";

// ── Crypto helpers ──

async function sha256Hex(str: string): Promise<string> {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomNonce(): string {
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Persisted retry queue ──
// Network failures and 5xx responses go here; the alarm in service-worker.ts
// replays them every 15 min. 4xx responses (auth/validation) are dropped —
// they'd fail forever. The queue is capped to bound storage growth even in
// pathological scenarios (offline for days, or a misconfigured Worker).

const QUEUE_KEY = "wfc_community_queue";
const QUEUE_MAX_ENTRIES = 500;
const QUEUE_MAX_ATTEMPTS = 5;

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

async function readQueue(): Promise<QueuedItem[]> {
  try {
    const result = await chrome.storage.local.get(QUEUE_KEY);
    const items = result[QUEUE_KEY];
    return Array.isArray(items) ? items as QueuedItem[] : [];
  } catch {
    return [];
  }
}

async function writeQueue(items: QueuedItem[]): Promise<void> {
  try {
    // FIFO cap: drop oldest entries if we hit the ceiling. The drop is
    // silent — the original action is already lost from the user's POV.
    const trimmed = items.slice(-QUEUE_MAX_ENTRIES);
    await chrome.storage.local.set({ [QUEUE_KEY]: trimmed });
  } catch {
    // chrome.storage.local quota exhausted — give up; nothing else to do
  }
}

async function enqueue(item: Omit<QueuedItem, "attempts" | "enqueuedAt">): Promise<void> {
  const queue = await readQueue();
  queue.push({ ...item, attempts: 0, enqueuedAt: Date.now() } as QueuedItem);
  await writeQueue(queue);
}

/**
 * Decide if a failed response should be retried later.
 *
 * Network errors (no response) and 5xx → retry.
 * 4xx → drop (auth invalid, rate-limited, malformed payload, replay nonce).
 * 2xx → don't enqueue (already succeeded).
 */
function shouldRetry(status: number | null): boolean {
  if (status === null) return true;       // network error
  if (status >= 500 && status < 600) return true;
  return false;
}

// ── Submit vote ──
// Fire-and-forget: caller should .catch(() => {}) this.

export async function submitVote(
  username: string,
  verdict: "fake" | "ok" | "review",
  score: number,
): Promise<void> {
  const license = await getLicense();
  if (!license.active) return;
  // Use communityToken if available, otherwise fall back to the Stripe session ID directly
  const token = license.communityToken || license.key;
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

  let status: number | null = null;
  try {
    const res = await fetch(COMMUNITY_VOTE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    status = res.status;
  } catch {
    // network error — fall through to retry decision
  }

  if (status === null || !(status >= 200 && status < 300)) {
    if (shouldRetry(status)) {
      await enqueue({ kind: "vote", body });
    }
  }
}

// ── Report sightings (manual fake confirmations) ──
// Fire-and-forget: caller should .catch(() => {}) this.

export async function reportSightings(usernames: string[]): Promise<void> {
  if (usernames.length === 0) return;

  const license = await getLicense();
  if (!license.active) return;
  const token = license.communityToken || license.key;
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

  let status: number | null = null;
  try {
    const res = await fetch(COMMUNITY_REPORT_SIGHTINGS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    status = res.status;
  } catch {
    // network error
  }

  if (status === null || !(status >= 200 && status < 300)) {
    if (shouldRetry(status)) {
      await enqueue({ kind: "sightings", body });
    }
  }
}

// ── Replay queued community calls ──
// Wired to a chrome.alarms tick in service-worker.ts. Best-effort: drains
// the queue while items succeed; transient failures stay queued for the
// next tick; persistent failures (4xx) are dropped after the first retry.

export async function processCommunityQueue(): Promise<{ replayed: number; dropped: number; remaining: number }> {
  const queue = await readQueue();
  if (queue.length === 0) return { replayed: 0, dropped: 0, remaining: 0 };

  const surviving: QueuedItem[] = [];
  let replayed = 0;
  let dropped = 0;

  for (const item of queue) {
    const url = item.kind === "vote" ? COMMUNITY_VOTE_URL : COMMUNITY_REPORT_SIGHTINGS_URL;
    // Refresh freshness fields before replay. The Worker rejects any ts older
    // than 5 min, but this alarm only fires every 15 min — so replaying the
    // original (stale) ts would ALWAYS fail validation (timestamp_expired → 4xx)
    // and the item would be dropped. The original request never reached the
    // server, so a fresh ts + nonce is a legitimate retry (vote = idempotent
    // upsert, sighting = INSERT OR IGNORE — a rare double-delivery is harmless).
    item.body.ts = Date.now();
    item.body.nonce = randomNonce();
    let status: number | null = null;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item.body),
      });
      status = res.status;
    } catch {
      // network error
    }

    if (status !== null && status >= 200 && status < 300) {
      replayed++;
      continue;
    }

    // Drop on 4xx (won't retry on next tick) OR after too many attempts
    const nextAttempts = item.attempts + 1;
    if (!shouldRetry(status) || nextAttempts >= QUEUE_MAX_ATTEMPTS) {
      dropped++;
      continue;
    }
    surviving.push({ ...item, attempts: nextAttempts });
  }

  await writeQueue(surviving);
  return { replayed, dropped, remaining: surviving.length };
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
    if (!res.ok) return result;

    const data = (await res.json()) as { results: Record<string, number> };
    for (const [hash, count] of Object.entries(data.results || {})) {
      const username = hashToUsername.get(hash);
      if (username) result.set(username, count);
    }
  } catch {
    // Network error — non-critical
  }

  return result;
}
