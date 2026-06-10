/**
 * Community events — single funnel for every outcome of the community
 * submission path (votes, sightings, retry queue, token health, lookups).
 *
 * Before v3 every failure on this path died in an empty catch block; the only
 * trace was a console.log in the service worker. This module makes each
 * outcome visible three ways:
 *   1. Rolling counters + last-replay snapshot persisted under
 *      chrome.storage.local["wfc_community_status"] (drives the sidepanel
 *      community card and GET_COMMUNITY_STATUS).
 *   2. A LOG_EVENT broadcast so the LogConsole shows drops/replays live.
 *   3. An anonymous telemetry event (gated on Settings.telemetry) so the
 *      operator can see field-wide failure rates without user reports.
 *
 * Never throws: it is called from catch paths that must stay safe.
 */

import type {
  CommunityFailureReason,
  CommunityReplaySummary,
  CommunityTokenStatus,
} from "@shared/types";
import { reportTelemetry } from "./telemetry";
import { loadLang, m } from "./pipeline/i18n";

export const COMMUNITY_STATUS_KEY = "wfc_community_status";

export type CommunityEventKind =
  | "vote_sent"
  | "vote_enqueued"
  | "vote_dropped"
  | "sightings_sent"
  | "sightings_enqueued"
  | "sightings_dropped"
  | "queue_overflow"
  | "replay_summary"
  | "token_invalid"
  | "lookup_failed"
  | "storage_error";

export interface CommunityEvent {
  kind: CommunityEventKind;
  /** CommunityFailureReason for drops; free-form code otherwise. */
  reason?: string;
  httpStatus?: number | null;
  /** Contributions affected (votes = 1, sightings = batch size). Default 1. */
  count?: number;
  stage?: "submit" | "replay" | "scan" | "sidepanel" | "check";
  /** Only for kind "replay_summary". */
  replay?: { replayed: number; dropped: number; remaining: number };
}

/** Stored shape — CommunityStatus minus the live queueLength. */
export interface StoredCommunityStatus {
  sent: number;
  enqueued: number;
  dropped: number;
  droppedByReason: Partial<Record<CommunityFailureReason, number>>;
  lastDropReason: CommunityFailureReason | null;
  lastReplay: CommunityReplaySummary | null;
  tokenStatus: CommunityTokenStatus;
  tokenCheckedAt: number | null;
  updatedAt: number;
}

// Fresh object per call — a shared nested droppedByReason would be mutated
// in place by every event and leak counts across snapshots.
function emptyStatus(): StoredCommunityStatus {
  return {
    sent: 0,
    enqueued: 0,
    dropped: 0,
    droppedByReason: {},
    lastDropReason: null,
    lastReplay: null,
    tokenStatus: "unknown",
    tokenCheckedAt: null,
    updatedAt: 0,
  };
}

export async function getCommunityStatusSnapshot(): Promise<StoredCommunityStatus> {
  try {
    const result = await chrome.storage.local.get(COMMUNITY_STATUS_KEY);
    const stored = (result[COMMUNITY_STATUS_KEY] || {}) as Partial<StoredCommunityStatus>;
    return {
      ...emptyStatus(),
      ...stored,
      droppedByReason: { ...(stored.droppedByReason || {}) },
    };
  } catch {
    return emptyStatus();
  }
}

// ── Serialized writes ──
// Events can fire concurrently (pipeline votes while the alarm replays the
// queue). chrome.storage has no transactions, so a lost update would silently
// swallow counter increments. A promise chain serializes all writers within
// this SW instance — the only writer that exists.

let writeChain: Promise<void> = Promise.resolve();

function enqueueWrite(fn: () => Promise<void>): Promise<void> {
  const next = writeChain.then(fn).catch(() => {});
  writeChain = next;
  return next;
}

// ── Log throttling ──
// Visibility without spam: an offline clean cycle enqueues ~50 votes and a
// replay can drop hundreds of items at once. Counters always tally; the
// LogConsole gets at most one line per key per window.

const lastLogAt = new Map<string, number>();

function shouldLog(key: string, minIntervalMs: number): boolean {
  const now = Date.now();
  const last = lastLogAt.get(key) ?? 0;
  if (now - last < minIntervalMs) return false;
  lastLogAt.set(key, now);
  return true;
}

async function broadcastLog(level: "INFO" | "WARNING", message: string): Promise<void> {
  try {
    await loadLang();
  } catch {
    // keep default lang
  }
  const entry = {
    ts: new Date().toISOString(),
    level,
    category: "community",
    message,
  };
  try {
    await chrome.runtime.sendMessage({ type: "LOG_EVENT", payload: entry });
  } catch {
    // no listener (sidepanel closed) — normal
  }
}

const DROP_REASONS: CommunityFailureReason[] = [
  "http_403",
  "http_4xx",
  "max_attempts",
  "overflow",
  "quota",
  "expired",
  "network",
];

function asDropReason(reason?: string): CommunityFailureReason {
  return DROP_REASONS.includes(reason as CommunityFailureReason)
    ? (reason as CommunityFailureReason)
    : "http_4xx";
}

/**
 * Record one community outcome. Fire-and-forget safe: never rejects.
 */
export function recordCommunityEvent(evt: CommunityEvent): Promise<void> {
  return enqueueWrite(async () => {
    const status = await getCommunityStatusSnapshot();
    const count = evt.count ?? 1;

    switch (evt.kind) {
      case "vote_sent":
      case "sightings_sent":
        status.sent += count;
        // A successful authenticated submit proves the token works.
        status.tokenStatus = "ok";
        break;

      case "vote_enqueued":
      case "sightings_enqueued":
        status.enqueued += count;
        if (shouldLog("enqueued", 5 * 60_000)) {
          await broadcastLog("INFO", m("community_enqueued"));
        }
        break;

      case "vote_dropped":
      case "sightings_dropped":
      case "queue_overflow": {
        const reason = evt.kind === "queue_overflow" ? "overflow" : asDropReason(evt.reason);
        status.dropped += count;
        status.droppedByReason[reason] = (status.droppedByReason[reason] ?? 0) + count;
        status.lastDropReason = reason;
        // Replay-stage drops are summarized by the replay_summary line;
        // logging each would flood the console when a stale queue drains.
        if (evt.stage !== "replay" && shouldLog(`dropped:${reason}`, 60_000)) {
          await broadcastLog("WARNING", m("community_dropped", reason));
        }
        await reportTelemetry({
          category: "community",
          errorCode: evt.kind,
          reason,
          stage: evt.stage,
        });
        break;
      }

      case "replay_summary": {
        const r = evt.replay ?? { replayed: 0, dropped: 0, remaining: 0 };
        status.lastReplay = { ts: Date.now(), ...r };
        if (r.replayed > 0 || r.dropped > 0) {
          await broadcastLog("INFO", m("community_replay", r.replayed, r.dropped, r.remaining));
          await reportTelemetry({
            category: "community",
            errorCode: "replay_summary",
            reason: r.dropped > 0 ? "partial" : "ok",
            stage: "replay",
          });
        }
        break;
      }

      case "token_invalid":
        status.tokenStatus = "invalid";
        status.tokenCheckedAt = Date.now();
        if (shouldLog("token_invalid", 10 * 60_000)) {
          await broadcastLog("WARNING", m("community_token_invalid"));
        }
        await reportTelemetry({
          category: "community",
          errorCode: "token_invalid",
          reason: evt.reason ?? "check",
        });
        break;

      case "lookup_failed":
        if (shouldLog("lookup_failed", 5 * 60_000)) {
          await broadcastLog("WARNING", m("community_lookup_failed", evt.reason ?? "network"));
        }
        await reportTelemetry({
          category: "community",
          errorCode: "lookup_failed",
          reason: evt.reason,
          stage: evt.stage,
        });
        break;

      case "storage_error":
        if (shouldLog("storage_error", 10 * 60_000)) {
          await broadcastLog("WARNING", m("community_storage_error"));
        }
        await reportTelemetry({
          category: "community",
          errorCode: "storage_error",
          reason: evt.reason,
          stage: evt.stage,
        });
        break;
    }

    status.updatedAt = Date.now();
    try {
      await chrome.storage.local.set({ [COMMUNITY_STATUS_KEY]: status });
    } catch {
      // Quota exhausted while recording — nothing left to record it with.
    }
    pingStatusUpdated();
  });
}

// Cheap "something changed" ping for the sidepanel CommunityCard. Rejects
// harmlessly when no panel is open.
function pingStatusUpdated(): void {
  try {
    void chrome.runtime.sendMessage({ type: "COMMUNITY_STATUS_UPDATED" }).catch(() => {});
  } catch {
    // ignore
  }
}

export function recordReplaySummary(replay: {
  replayed: number;
  dropped: number;
  remaining: number;
}): Promise<void> {
  return recordCommunityEvent({ kind: "replay_summary", replay });
}

/**
 * Persist the result of a token health check. "unknown" (network failure)
 * deliberately does NOT stamp tokenCheckedAt, so the next trigger retries
 * instead of being silenced for 24 h by an inconclusive check.
 */
export function setTokenStatus(tokenStatus: CommunityTokenStatus): Promise<void> {
  return enqueueWrite(async () => {
    const status = await getCommunityStatusSnapshot();
    status.tokenStatus = tokenStatus;
    if (tokenStatus !== "unknown") {
      status.tokenCheckedAt = Date.now();
    }
    status.updatedAt = Date.now();
    try {
      await chrome.storage.local.set({ [COMMUNITY_STATUS_KEY]: status });
    } catch {
      // ignore
    }
    pingStatusUpdated();
  });
}
