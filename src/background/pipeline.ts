/**
 * Pipeline — orchestrates Fetch → Score → Clean automation.
 *
 * Ported from backend/engine/pipeline.py.
 * Runs in the service worker, delegates DOM work to content scripts.
 */

import type {
  FollowerRecord,
} from "@shared/types";
import type { ContentFollowerMeta, ContentProfileData } from "@shared/messages";
import {
  CYCLE_SIZE,
  INTER_CYCLE_PAUSE,
  CONTINUOUS_SESSION_MAX_HOURS,
  CONTINUOUS_LONG_BREAK,
  CONTINUOUS_IDLE_PAUSE,
  HARD_429_PAUSE,
} from "@shared/constants";
import { FREE_LIMITS } from "@shared/types";
import { scoreProfile, preScoreFromMetadata } from "./scorer";
import {
  upsertFollowers,
  getFollower,
  getFollowers,
  updateFollower,
  getFollowersPending,
  getAllFollowerUsernames,
  getSettings,
  addActionLog,
  createScanSession,
  updateScanSession,
  getLicense,
  getDailyUsage,
  incrementDailyUsage,
} from "./storage";
import { RateTracker } from "./rate-tracker";
import { HumanPacer, sleep } from "./pacer";
import { startKeepAlive, stopKeepAlive } from "./keepalive";
import { submitVote, checkSightings, reportSightings } from "./community";
import { reportTelemetry } from "./telemetry";
// ── Pipeline sub-modules (extracted for v2.1) ──
import { loadLang, m, fetchErrorToUserMessage } from "./pipeline/i18n";
import {
  configureStateProviders,
  log,
  broadcastStats,
  updateState,
} from "./pipeline/state";
import {
  getOrCreateBackgroundTab,
  closeBackgroundTab,
  waitForTabLoad,
  clearBackgroundTabId,
  getBackgroundTabId,
  tearDownBackgroundTab,
} from "./pipeline/tab-manager";
import {
  ensureContentScript,
  isChannelLostError,
  isTabGoneError,
} from "./pipeline/messenger";
import {
  markFake,
  markToReview,
  markOk,
  markRemoved,
  markNotFound,
  markScanError,
} from "./pipeline/follower-updater";
import { PROFILE_VISIT, COOLDOWN, PACER } from "./pipeline/timings";
import { span, coarseBucket } from "./pipeline/perf";

// ── Pipeline i18n / state / tab-mgmt / messenger / follower-updater ──
// All extracted to ./pipeline/* sub-modules in v2.1.
// Imports above expose: loadLang, m, fetchErrorToUserMessage,
// log, broadcastStats, updateState, configureStateProviders,
// getOrCreateBackgroundTab, closeBackgroundTab, waitForTabLoad,
// clearBackgroundTabId, getBackgroundTabId, tearDownBackgroundTab,
// ensureContentScript, isChannelLostError, isTabGoneError,
// markFake, markToReview, markOk, markRemoved, markNotFound, markScanError,
// PROFILE_VISIT, COOLDOWN, PACER timings.

// ── Pipeline singleton ──

let abortController: AbortController | null = null;
const rateTracker = new RateTracker();
const pacer = new HumanPacer(15, 30);

// ── Verrou pipeline — empêche les opérations concurrentes ──
let pipelineLock: Promise<void> = Promise.resolve();

function withPipelineLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = pipelineLock.then(fn, fn);
  pipelineLock = next.then(() => {}, () => {});
  return next;
}

function isRunning(): boolean {
  return abortController !== null && !abortController.signal.aborted;
}

/**
 * Persist a batch of fetched followers to IndexedDB.
 * Used by both runFetchInternal (final reconciliation) and the FOLLOWERS_PAGE
 * incremental save handler in service-worker.ts. Returns the number of NEW
 * records inserted (existing rows are updated in place with metadata only).
 */
export async function persistFollowerPage(
  users: Record<string, ContentFollowerMeta>,
  ownerUsername: string,
): Promise<number> {
  const persistSpan = span("persist_page");
  const now = Date.now();
  const newRecords: FollowerRecord[] = [];
  let newCount = 0;

  for (const [pseudo, meta] of Object.entries(users)) {
    if (!pseudo || pseudo === ownerUsername) continue;

    const existing = await getFollower(pseudo);
    if (existing) {
      await updateFollower(pseudo, {
        fullName: meta.fullName || existing.fullName,
        followersCount: meta.followerCount ?? existing.followersCount,
        followingCount: meta.followingCount ?? existing.followingCount,
        isPrivate: meta.isPrivate,
        isVerified: meta.isVerified,
        hasProfilePic: meta.hasProfilePic,
        bio: meta.biography || existing.bio,
      });
    } else {
      newCount++;
      newRecords.push({
        username: pseudo,
        fullName: meta.fullName,
        bio: meta.biography,
        followersCount: meta.followerCount,
        followingCount: meta.followingCount,
        postsCount: null,
        hasProfilePic: meta.hasProfilePic,
        isPrivate: meta.isPrivate,
        isVerified: meta.isVerified,
        score: null,
        scoreBreakdown: null,
        isFake: null,
        toReview: false,
        approved: false,
        status: "pending",
        scanned: false,
        removed: false,
        scanError: null,
        createdAt: now,
        scannedAt: null,
        removedAt: null,
      });
    }
  }

  if (newRecords.length > 0) {
    await upsertFollowers(newRecords);
  }
  persistSpan.end({ users: Object.keys(users).length, inserted: newCount });
  return newCount;
}

export function stopPipeline(): void {
  abortController?.abort();
  abortController = null;
  // tab-manager handles STOP_CONTENT broadcast + remove + state clear
  void tearDownBackgroundTab();
}

// Configure the providers used by pipeline/state.ts to compute live stats.
// Done once at module load so log/broadcastStats can reach back into the
// running pipeline for current rate stats.
configureStateProviders({
  isRunning,
  rateStats: () => rateTracker.getStats(),
});

// ── Background tab management ──
// All extracted to ./pipeline/tab-manager.ts (state owner) and
// ./pipeline/messenger.ts (content-script comms) in v2.1.

// ── Fetch phase ──

export function runFetch(): Promise<void> {
  return withPipelineLock(async () => {
    if (isRunning()) return;
    abortController = new AbortController();
    await startKeepAlive();
    try {
      await runFetchInternal(abortController.signal);
    } finally {
      await stopKeepAlive();
      abortController = null;
    }
  });
}

async function runFetchInternal(signal: AbortSignal): Promise<void> {
  await loadLang();
  await rateTracker.load();

  const settings = await getSettings();
  const username = settings.threadsUsername;
  if (!username) {
    log("ERROR", "pipeline", m("no_username"));
    return;
  }

  log("INFO", "fetch", m("fetch_start", username));
  const fetchSpan = span("fetch_run");
  // Clear any previous error when starting a fresh run.
  await updateState({ stage: "fetching", lastError: null, pausedUntil: null, pauseReason: null });

  try {
    // Force-close any existing background tab (stale content script after extension reload)
    await closeBackgroundTab();

    // Use background tab on user's profile page (needs auth context + bridge)
    const tabId = await getOrCreateBackgroundTab();
    const profileUrl = `https://www.threads.com/@${encodeURIComponent(username)}`;
    await chrome.tabs.update(tabId, { url: profileUrl });
    await waitForTabLoad(tabId, signal);
    await sleep(3, signal);
    await ensureContentScript(tabId);

    // Retry logic: message channel can close after extension reload
    // Race with abort signal so Stop actually interrupts the fetch
    const abortPromise = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(new Error("aborted"));
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    });

    // Send known usernames so the content script can stop early
    const knownUsernames = await getAllFollowerUsernames();
    const knownArray = knownUsernames.size > 0 ? [...knownUsernames] : [];

    type FetchSuccess = { collected: Record<string, ContentFollowerMeta>; method: string; truncated?: boolean; truncReason?: string };
    type FetchError = { error: string; reason?: string; linksFound?: number };
    type FetchAny = FetchSuccess | FetchError | null;

    const sendFetch = async (): Promise<FetchAny> => {
      let r: FetchAny = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (signal.aborted) break;
        try {
          r = await Promise.race([
            chrome.tabs.sendMessage(tabId, {
              type: "FETCH_FOLLOWERS",
              payload: { username, knownUsernames: knownArray },
            }),
            abortPromise,
          ]) as FetchAny;
          break;
        } catch (msgErr) {
          const errMsg = String(msgErr);
          if (errMsg.includes("aborted")) break;
          if (errMsg.includes("message channel closed") || errMsg.includes("Receiving end does not exist")) {
            log("WARNING", "pipeline", m("msg_channel_err", attempt + 1));
            await sleep(2, signal);
            if (signal.aborted) break;
            // Re-navigate and re-inject (returns to the profile page)
            await chrome.tabs.update(tabId, { url: profileUrl });
            await waitForTabLoad(tabId, signal);
            await sleep(3, signal);
            await ensureContentScript(tabId);
          } else {
            throw msgErr;
          }
        }
      }
      return r;
    };

    let result: FetchAny = await sendFetch();

    // Fallback: if the modal-based detection failed (either the Followers
    // button couldn't be clicked, or the scroll container never appeared after
    // clicking), retry once on the dedicated /@user/followers page. Threads
    // sometimes routes there instead of opening a modal, and the page-level
    // scroller works reliably without needing the click step at all.
    if (
      result &&
      "error" in result &&
      (result.error === "scroll_container_not_found" ||
        result.error === "followers_button_not_found") &&
      !signal.aborted
    ) {
      const followersUrl = `https://www.threads.com/@${encodeURIComponent(username)}/followers`;
      const detail =
        result.error === "scroll_container_not_found"
          ? `scroll_container_not_found (reason=${result.reason ?? "unknown"}, links=${result.linksFound ?? 0})`
          : "followers_button_not_found";
      log("WARNING", "pipeline", `${detail} — retrying on dedicated /followers page`);
      await chrome.tabs.update(tabId, { url: followersUrl });
      await waitForTabLoad(tabId, signal);
      await sleep(3, signal);
      await ensureContentScript(tabId);
      if (!signal.aborted) {
        result = await sendFetch();
      }
    }

    if (!result) {
      log("ERROR", "pipeline", m("fetch_retry_fail"));
      await updateState({ stage: "idle", lastError: m("err_msg_channel") });
      reportTelemetry({ category: "fetch", errorCode: "message_channel_closed", stage: "fetching" });
      return;
    }

    const fetchResult = result;

    if ("error" in fetchResult) {
      const code = fetchResult.error;
      const reason = fetchResult.reason;
      const userMsg = fetchErrorToUserMessage(code, reason);
      const techDetail = reason ? `${code} (${reason})` : code;
      log("ERROR", "pipeline", m("fetch_failed", techDetail));
      await updateState({ stage: "idle", lastError: userMsg });
      reportTelemetry({ category: "fetch", errorCode: code, reason, stage: "fetching" });
      return;
    }

    const successResult = fetchResult as FetchSuccess;
    const total = Object.keys(successResult.collected).length;
    log("INFO", "fetch", m("fetch_found", total));
    await updateState({ stage: "fetching", total, progress: 0 });

    // Final reconciliation pass — pages were already persisted incrementally
    // via FOLLOWERS_PAGE messages while the content script was running, but we
    // re-upsert here as a safety net (idempotent) in case the final batch
    // arrived in this response and not via fire-and-forget.
    const newCount = await persistFollowerPage(successResult.collected, username);

    log("INFO", "fetch", m("fetch_done", total, newCount));

    // Perf summary: one human line + one coarse telemetry event. Detailed
    // spans live in chrome.storage.session (local-only ring buffer).
    const fetchSeconds = Math.round(fetchSpan.end({ followers: total, inserted: newCount }) / 1000);
    log("INFO", "perf", m("perf_fetch_summary", fetchSeconds, total, newCount));
    reportTelemetry({
      category: "perf",
      errorCode: "fetch_complete",
      reason: `followers_${coarseBucket(total, [500, 2000, 5000])}`,
      value: fetchSeconds,
    }).catch(() => {});

    // If the scroll fetch hit the single-pass cap (~5000) or the 30-min timeout,
    // the follower list is truncated — say so instead of silently pretending we
    // got everyone. Surfaced via lastError (shown in ControlPanel once the run
    // ends) plus a WARNING log line.
    if (successResult.truncated) {
      const notice = m("fetch_truncated", total);
      log("WARNING", "fetch", notice);
      await updateState({ lastError: notice });
    }
  } catch (e) {
    log("ERROR", "pipeline", m("fetch_error", String(e)));
    await updateState({ stage: "idle", lastError: String(e) });
    reportTelemetry({ category: "fetch", errorCode: "exception", reason: String(e).slice(0, 80), stage: "fetching" });
  } finally {
    await updateState({ stage: "idle" });
    await broadcastStats();
  }
}

// ── Clean cycle (scan + remove in one pass) ──

export function runCleanCycle(): Promise<void> {
  return withPipelineLock(async () => {
    if (isRunning()) return;
    abortController = new AbortController();
    await startKeepAlive();
    try {
      await runCleanCycleInternal(abortController.signal);
    } finally {
      await closeBackgroundTab();
      await stopKeepAlive();
      abortController = null;
    }
  });
}

// ── Analyse-only flow for the "Analyser mon compte" button ──
// One lock, one abort signal: fetch the followers, then run the same thorough
// scan as a clean cycle but FLAG fakes only (never remove). The user reviews
// them, then removal is an explicit second step (runRemoveFlagged).
//
// Logs IMMEDIATELY on entry — before acquiring the lock — so a click can never
// be silent (the previous fetch()→analyze() chaining could return with no log
// when the pipeline lock/isRunning guard short-circuited). Also surfaces an
// "already running" message and never swallows errors.
export function runAnalyze(): Promise<void> {
  log("INFO", "clean", m("analyze_start"));
  return withPipelineLock(async () => {
    if (isRunning()) {
      log("WARNING", "clean", m("already_running"));
      return;
    }
    abortController = new AbortController();
    await startKeepAlive();
    try {
      await runFetchInternal(abortController.signal);
      if (!abortController.signal.aborted) {
        await runCleanCycleInternal(abortController.signal, false);
      }
    } catch (e) {
      log("ERROR", "clean", m("fetch_error", e instanceof Error ? e.message : String(e)));
    } finally {
      await closeBackgroundTab();
      await stopKeepAlive();
      abortController = null;
      await broadcastStats();
    }
  });
}

// ── Remove-only pass over already-flagged fakes ──
// Second step of the guided flow: deletes exactly the accounts already flagged
// "fake" (and shown to the user in the Faux list). No scanning/scoring here.
export function runRemoveFlagged(): Promise<void> {
  return withPipelineLock(async () => {
    if (isRunning()) return;
    abortController = new AbortController();
    await startKeepAlive();
    try {
      await runRemoveFlaggedInternal(abortController.signal);
    } finally {
      await closeBackgroundTab();
      await stopKeepAlive();
      abortController = null;
    }
  });
}

async function runRemoveFlaggedInternal(signal: AbortSignal): Promise<void> {
  await loadLang();
  await rateTracker.load();

  const fakes = (await getFollowers({ status: "fake" })).filter((f) => !f.removed);
  if (fakes.length === 0) {
    log("INFO", "clean", m("cycle_no_pending"));
    return;
  }

  await updateState({
    stage: "cleaning", total: fakes.length, progress: 0,
    lastError: null, pausedUntil: null, pauseReason: null,
  });

  let removed = 0;
  let consecutiveBlocked = 0;
  for (const follower of fakes) {
    if (signal.aborted) break;
    if (consecutiveBlocked >= 5) {
      log("WARNING", "clean", m("scan_slowdown"));
      await pausedSleep(300, "slowdown", signal).catch(() => {});
      consecutiveBlocked = 0;
      if (signal.aborted) break;
    }
    try {
      const tabId = await getOrCreateBackgroundTab();
      const profileUrl = `https://www.threads.com/@${encodeURIComponent(follower.username)}`;
      log("INFO", "clean", m("cycle_visit", follower.username));

      await chrome.tabs.update(tabId, { url: profileUrl });
      await waitForTabLoad(tabId, signal);
      await sleep(6 + Math.random() * 8, signal);
      await ensureContentScript(tabId);

      const pageCheck = await chrome.tabs.sendMessage(tabId, { type: "CHECK_PAGE" }) as
        { ok: boolean; errorPage: boolean } | null;
      if (pageCheck?.errorPage && !pageCheck.ok) {
        log("WARNING", "clean", m("threads_error_page_skip", follower.username));
        continue;
      }

      const removeResult = await chrome.tabs.sendMessage(tabId, {
        type: "REMOVE_FOLLOWER",
        payload: { username: follower.username },
      }) as { success: boolean; action: string; error?: string; blocked?: boolean };

      if (removeResult.success) {
        await markRemoved(follower.username);
        removed++;
        log("INFO", "clean", m("cycle_fake_removed", follower.username, follower.score ?? 0));
        await addActionLog({
          actionType: "remove", target: follower.username,
          status: "ok", errorDetail: null, durationMs: null, createdAt: Date.now(),
        });
      } else {
        log("WARNING", "clean", m("cycle_fake_fail", follower.username, follower.score ?? 0, removeResult.error ?? ""));
        if (removeResult.blocked) consecutiveBlocked++;
      }

      await updateState({ stage: "cleaning", progress: removed, total: fakes.length });
      await broadcastStats();
      await sleep(pacer.nextPause(), signal);
    } catch (e) {
      log("ERROR", "clean", m("scan_error", follower.username, e instanceof Error ? e.message : String(e)));
      await sleep(2, signal).catch(() => {});
    }
  }

  await updateState({ stage: "idle" });
  await broadcastStats();
  log("INFO", "clean", m("cycle_done", 0, removed, 0));
}

// When removeFlagged is false the cycle scans + flags fakes but never deletes
// (the "Analyser mon compte" flow) — the user removes them in an explicit step.
async function runCleanCycleInternal(signal: AbortSignal, removeFlagged = true): Promise<number> {
  await loadLang();
  await rateTracker.load();

  const settings = await getSettings();
  // Check free tier: 1 cycle/day
  const licence = await getLicense();
  if (!licence.active) {
    const usage = await getDailyUsage();
    if (usage.cycles >= FREE_LIMITS.cyclesPerDay) {
      log("WARNING", "clean", m("cycle_limit"));
      return 0;
    }
  }

  const pending = await getFollowersPending(CYCLE_SIZE);
  if (pending.length === 0) {
    log("INFO", "clean", m("cycle_no_pending"));
    return 0;
  }

  // Reset error counters from previous runs
  await rateTracker.resetErrors();

  log("INFO", "clean", m("cycle_start", pending.length));
  const cycleSpan = span("clean_cycle");
  // Net work time (navigation, scan, removal) — pacing sleeps excluded, so
  // the summary separates what we control from deliberate anti-block waits.
  let workMs = 0;
  // Clear any previous error when starting a fresh cycle.
  await updateState({ stage: "cleaning", total: pending.length, progress: 0, lastError: null, pausedUntil: null, pauseReason: null });

  const sessionId = await createScanSession({
    status: "running",
    totalFollowers: pending.length,
    scannedCount: 0,
    fakeCount: 0,
    removedCount: 0,
    errors429: 0,
    errorsTimeout: 0,
    startedAt: Date.now(),
    finishedAt: null,
  });

  // Free-tier cycle counting happens at the END of the cycle (gated on work
  // actually done) so an immediate hard-429 no longer burns the 1 free cycle/day.

  // Check cross-user sightings (batch, non-blocking)
  let sightingsMap = new Map<string, number>();
  try {
    const pendingUsernames = pending.map((f) => f.username);
    sightingsMap = await checkSightings(pendingUsernames.slice(0, 200));
  } catch { /* non-critical */ }

  // Sort by suspicion: pre-score from metadata, most suspicious first
  const preSorted = pending.map((f) => {
    const hasBio = (f.bio || "").length >= 3;
    const seenBy = sightingsMap.get(f.username);
    const { score, details } = preScoreFromMetadata(
      f.username, f.followersCount, f.isPrivate, f.fullName,
      f.hasProfilePic, hasBio, f.isVerified, f.followingCount, seenBy
    );
    return { follower: f, metaScore: score, metaDetails: details, seenByCount: seenBy };
  });

  // ── Phase 1 : trier les followers en 3 catégories ──
  let autoSkipped = 0;
  let fakesFound = 0; // fakes NEWLY detected this cycle (distinct from removed)
  const needsVisit: typeof preSorted = [];
  const needsRemoveOnly: FollowerRecord[] = []; // Déjà scorés fake, juste supprimer

  // Sightings à reporter au pool communautaire en fin de cycle (batch).
  // On accumule pour faire UN seul appel /report-sightings au lieu d'un par fake
  // (ça respecte le rate limit 20 batches/h du worker).
  const cycleSightings = new Set<string>();

  for (const entry of preSorted) {
    const { follower, metaScore, metaDetails } = entry;

    // Cas A : déjà scanné et marqué fake (crash/429 avant suppression) → supprimer directement
    if (follower.isFake && follower.score !== null && follower.scanned) {
      if (removeFlagged) needsRemoveOnly.push(follower);
      continue;
    }

    // Cas B : pré-score évident fake → marquer sans visiter, MAIS supprimer dans le même cycle
    if (metaScore !== null && metaScore >= 80) {
      const updates = {
        score: metaScore,
        scoreBreakdown: JSON.stringify(metaDetails),
        isFake: true,
        scanned: true,
        status: "fake" as const,
        scannedAt: Date.now(),
      };
      await updateFollower(follower.username, updates);
      autoSkipped++;
      // Critique pour les users free (1 cycle/jour) : on doit ABSOLUMENT supprimer
      // dans le même cycle, sinon ces fakes restent flaggés "fake" en DB et ne sont
      // jamais ré-attrapés (getFollowersPending ne renvoie que les "pending").
      if (removeFlagged) needsRemoveOnly.push({ ...follower, ...updates });
      cycleSightings.add(follower.username);
      fakesFound++;
    } else if (follower.isVerified && follower.followersCount !== null && follower.followersCount >= 500) {
      // Cas C : vérifié + beaucoup de followers → légitime
      await updateFollower(follower.username, {
        score: 0,
        scoreBreakdown: JSON.stringify(["auto:verified+500abn"]),
        isFake: false,
        toReview: false,
        scanned: true,
        status: "scanned",
        scannedAt: Date.now(),
      });
      autoSkipped++;
    } else {
      needsVisit.push(entry);
    }
  }

  if (autoSkipped > 0) {
    log("INFO", "clean", m("cycle_auto_skip", autoSkipped));
  }

  // ── Phase 2 : supprimer les profils déjà scorés fake (retry après crash/429) ──
  let removed = 0;
  if (removeFlagged && needsRemoveOnly.length > 0) {
    log("INFO", "clean", m("cycle_remove_only", needsRemoveOnly.length));

    // Need a tab for removals
    let rmTabId = await getOrCreateBackgroundTab();
    for (const follower of needsRemoveOnly) {
      if (signal.aborted) break;

      const profileUrl = `https://www.threads.com/@${encodeURIComponent(follower.username)}`;
      log("INFO", "clean", m("cycle_visit", follower.username));

      const rmNavSpan = span("profile_nav");
      await chrome.tabs.update(rmTabId, { url: profileUrl });
      await waitForTabLoad(rmTabId, signal);
      workMs += rmNavSpan.end();
      await sleep(8 + Math.random() * 12, signal);
      await ensureContentScript(rmTabId);

      // Check for error page
      const pageCheck = await chrome.tabs.sendMessage(rmTabId, { type: "CHECK_PAGE" }) as
        { ok: boolean; errorPage: boolean } | null;
      if (pageCheck?.errorPage && !pageCheck.ok) {
        log("WARNING", "clean", m("threads_error_page_skip", follower.username));
        continue;
      }

      const rmSpan = span("profile_remove");
      const removeResult = await chrome.tabs.sendMessage(rmTabId, {
        type: "REMOVE_FOLLOWER",
        payload: { username: follower.username },
      }) as { success: boolean; action: string; error?: string; blocked?: boolean };
      workMs += rmSpan.end();

      if (removeResult.success) {
        await updateFollower(follower.username, {
          removed: true, status: "removed", removedAt: Date.now(),
        });
        removed++;
        log("INFO", "clean", m("cycle_fake_removed", follower.username, follower.score ?? 0));
      } else {
        log("WARNING", "clean", m("cycle_fake_fail", follower.username, follower.score ?? 0, removeResult.error ?? ""));
        if (removeResult.blocked) break;
      }

      await sleep(pacer.nextPause(), signal);
    }
  }

  const sorted = needsVisit
    .map((e) => ({ follower: e.follower, metaScore: e.metaScore ?? 50, seenByCount: e.seenByCount }))
    .sort((a, b) => b.metaScore - a.metaScore);

  let scanned = autoSkipped;
  let reviewed = 0;
  let consecutiveBlocked = 0;
  let consecutiveErrorPages = 0;
  let tabId: number | null = null;

  async function ensureTab(): Promise<number> {
    if (tabId !== null) {
      try {
        await chrome.tabs.get(tabId);
        return tabId;
      } catch {
        log("WARNING", "pipeline", m("tab_recreated", tabId));
        tabId = null;
        clearBackgroundTabId();
      }
    }
    tabId = await getOrCreateBackgroundTab();
    return tabId;
  }

  for (const entry of sorted) {
    const { follower } = entry;
    if (signal.aborted) break;
    if (!rateTracker.canAct()) {
      const rs = rateTracker.getStats();
      log("WARNING", "pipeline", m("rate_limited", rs.actionsThisHour, rs.limitHour));
      break;
    }

    const { stop, reason } = rateTracker.shouldStop();
    if (stop) {
      log("WARNING", "pipeline", m("auto_stop", reason));
      break;
    }

    // Detect if Threads is blocking us
    if (consecutiveBlocked >= 5) {
      log("WARNING", "clean", m("scan_slowdown"));
      await pausedSleep(300, "slowdown", signal).catch(() => {});
      consecutiveBlocked = 0;
      if (signal.aborted) break;
    }

    try {
      const currentTabId = await ensureTab();
      const profileUrl = `https://www.threads.com/@${encodeURIComponent(follower.username)}`;
      log("INFO", "clean", m("cycle_visit", follower.username));

      // 1. Navigate to profile
      const navSpan = span("profile_nav");
      await chrome.tabs.update(currentTabId, { url: profileUrl });
      await waitForTabLoad(currentTabId, signal);
      workMs += navSpan.end();
      // Laisse React hydrater puis simule une lecture humaine rapide
      await sleep(6 + Math.random() * 8, signal);
      await ensureContentScript(currentTabId);

      // 1b. Check if Threads returned an error page instead of the profile
      const pageCheck = await chrome.tabs.sendMessage(currentTabId, { type: "CHECK_PAGE" }) as
        { ok: boolean; errorPage: boolean } | null;

      if (pageCheck?.errorPage) {
        consecutiveErrorPages++;
        if (!pageCheck.ok) {
          // Recovery failed — Threads is rate-limiting page loads hard.
          if (consecutiveErrorPages >= 3) {
            // 3+ consecutive error pages = hard 429 → long pause (1–1.5 hours)
            const hardPause = randomBetween(...HARD_429_PAUSE);
            const pauseMin = Math.round(hardPause / 60);
            log("WARNING", "clean", m("threads_hard_429", pauseMin));
            await closeBackgroundTab();
            await pausedSleep(hardPause, "hard_429", signal);
            if (signal.aborted) break;
            consecutiveErrorPages = 0;
            // Recreate tab and retry this follower
            tabId = null;
            clearBackgroundTabId();
            const freshTabId = await ensureTab();
            await chrome.tabs.update(freshTabId, { url: profileUrl });
            await waitForTabLoad(freshTabId, signal);
            await sleep(10 + Math.random() * 10, signal);
            await ensureContentScript(freshTabId);
          } else {
            // 1-2 error pages → shorter pause, escalating
            const cooldown = consecutiveErrorPages * 120; // 2min, 4min
            log("WARNING", "clean", m("threads_error_page", follower.username, cooldown));
            await pausedSleep(cooldown, "error_page", signal);
            if (signal.aborted) break;

            // Re-navigate from scratch
            await chrome.tabs.update(currentTabId, { url: profileUrl });
            await waitForTabLoad(currentTabId, signal);
            await sleep(10 + Math.random() * 10, signal);
            await ensureContentScript(currentTabId);

            // Check again
            const recheck = await chrome.tabs.sendMessage(currentTabId, { type: "CHECK_PAGE" }) as
              { ok: boolean; errorPage: boolean } | null;
            if (recheck?.errorPage && !recheck.ok) {
              log("WARNING", "clean", m("threads_error_page_skip", follower.username));
              await updateFollower(follower.username, { scanError: "error_page", status: "pending" });
              continue; // Skip, will be retried next cycle
            }
          }
        }
        // Recovered — slow down the pace for subsequent profiles
        pacer.addFatigue(consecutiveErrorPages * 5);
      } else {
        if (consecutiveErrorPages > 0) {
          consecutiveErrorPages = Math.max(0, consecutiveErrorPages - 1);
          pacer.reduceFatigue(2);
        }
      }

      // 2. Scan profile
      const scanSpan = span("profile_scan");
      const rawProfileData = await chrome.tabs.sendMessage(currentTabId, {
        type: "SCAN_PROFILE",
        payload: { username: follower.username },
      });
      workMs += scanSpan.end();

      // Validation minimale de la réponse du content script
      if (!rawProfileData || typeof rawProfileData !== "object" || !("username" in rawProfileData)) {
        consecutiveBlocked++;
        await rateTracker.recordError();
        log("WARNING", "clean", m("scan_no_data", follower.username));
        continue;
      }

      const profileData = rawProfileData as ContentProfileData;

      if (profileData.error === "429_RATE_LIMIT") {
        consecutiveBlocked++;
        await rateTracker.recordError();
        log("WARNING", "clean", m("scan_rate_limit", follower.username, consecutiveBlocked));
        await sleep(30 + Math.random() * 30, signal);
        continue;
      }

      consecutiveBlocked = 0;

      // 3. Handle not found (404)
      if (profileData.notFound) {
        // Remove not-found profile directly
        await markNotFound(follower.username);
        scanned++;
        removed++;
        fakesFound++;
        log("INFO", "clean", m("cycle_not_found", follower.username));
        // Community : compte introuvable = fake confirmé pour le pool
        submitVote(follower.username, "fake", 100).catch(() => {});
        cycleSightings.add(follower.username);
      } else {
        // 4. Score the profile (passer followingCount + cross-user sightings)
        const scored = scoreProfile(profileData, settings.scoreThreshold, !!settings.privateAlwaysReview, follower.followingCount, entry.seenByCount);
        const score = scored.score;

        // Community vote: submit our verdict (fire and forget — non-critical)
        const communityVerdict = scored.isFake ? "fake" : scored.toReview ? "review" : "ok";
        submitVote(follower.username, communityVerdict, score).catch(() => {});
        // Si verdict fake, alimenter le pool de sightings (utilise par les autres
        // utilisateurs pour booster leur pre-score via /check-sightings).
        if (scored.isFake) {
          cycleSightings.add(follower.username);
        }

        if (scored.isFake) {
          // FAKE — mark scanned then remove immediately
          await markFake(follower, scored, profileData);
          fakesFound++;

          if (removeFlagged) {
          // Simule la réflexion humaine avant de cliquer supprimer (3-8s)
          await sleep(3 + Math.random() * 5, signal);

          // Retry logic for REMOVE_FOLLOWER: menu_not_found is often a timing issue
          // (page not fully rendered after SCAN_PROFILE tab navigation).
          // Retry once on same page, then re-navigate as last resort.
          type RemoveOutcome = { success: boolean; action: string; error?: string; blocked?: boolean };
          let removeResult: RemoveOutcome | null = null;

          const removeSpan = span("profile_remove");
          for (let removeAttempt = 0; removeAttempt < 3; removeAttempt++) {
            if (signal.aborted) break;

            if (removeAttempt === 2) {
              // Last resort: re-navigate to the profile page to get a fresh DOM
              log("INFO", "clean", m("cycle_remove_retry_nav", follower.username));
              await chrome.tabs.update(currentTabId, { url: profileUrl });
              await waitForTabLoad(currentTabId, signal);
              await sleep(10 + Math.random() * 8, signal);
              await ensureContentScript(currentTabId);
            } else if (removeAttempt === 1) {
              // Second attempt: wait a bit for DOM to settle
              await sleep(5 + Math.random() * 4, signal);
            }

            removeResult = await chrome.tabs.sendMessage(currentTabId, {
              type: "REMOVE_FOLLOWER",
              payload: { username: follower.username },
            }) as RemoveOutcome | null;

            if (removeResult && (removeResult.success || removeResult.error !== "menu_not_found")) {
              break; // Success or non-retryable error
            }

            if (removeAttempt < 2) {
              log("WARNING", "clean", m("cycle_remove_retry", follower.username, removeAttempt + 1));
            }
          }
          workMs += removeSpan.end();

          // Stop pressed (or no verdict ever returned) before any removal attempt
          // completed → removeResult is still null. Do NOT dereference it (that was
          // a latent TypeError that spuriously bumped the blocked/error counters).
          // Leave the follower marked fake/pending; it'll be retried next cycle.
          if (!removeResult) {
            break;
          }

          if (removeResult.success) {
            await markRemoved(follower.username);
            removed++;
            log("INFO", "clean", m("cycle_fake_removed", follower.username, score));
            await addActionLog({
              actionType: "remove", target: follower.username,
              status: "ok", errorDetail: null, durationMs: null, createdAt: Date.now(),
            });
          } else {
            if (removeResult.blocked || removeResult.error === "threads_blocked") {
              consecutiveBlocked++;
              log("WARNING", "clean", m("clean_blocked_user", follower.username));
            } else {
              log("WARNING", "clean", m("cycle_fake_fail", follower.username, score, removeResult.error ?? ""));
            }
            await addActionLog({
              actionType: "remove", target: follower.username,
              status: removeResult.blocked ? "error_429" : "error_other",
              errorDetail: removeResult.error || null, durationMs: null, createdAt: Date.now(),
            });
          }
          } // end if (removeFlagged)
          scanned++;
        } else if (scored.toReview) {
          // TO REVIEW
          await markToReview(follower, scored, profileData);
          scanned++;
          reviewed++;
          log("INFO", "clean", m("cycle_review", follower.username, score));
        } else {
          // OK
          await markOk(follower, scored, profileData);
          scanned++;
          log("INFO", "clean", m("cycle_ok", follower.username, score));
        }
      }

      await rateTracker.recordAction();
      if (!profileData.notFound && profileData.error !== "429_RATE_LIMIT") {
        await rateTracker.recordSuccess();
      }

      await updateState({ stage: "cleaning", progress: scanned, total: pending.length });
      await broadcastStats();

      // Human-like delay before next profile
      const delay = pacer.nextPause();
      await sleep(delay, signal);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);

      if (isTabGoneError(e)) {
        // Tab was closed externally
        log("WARNING", "clean", m("scan_tab_lost", follower.username, errMsg));
        tabId = null;
        clearBackgroundTabId();
        await markScanError(follower.username, "tab_lost");
      } else if (isChannelLostError(e)) {
        // Content script died mid-operation (Threads error page, navigation, reload).
        // The tab still exists but the content script context is gone.
        // Re-navigate, re-inject, and leave this follower as pending for retry.
        log("WARNING", "clean", m("scan_channel_lost", follower.username));
        try {
          const tid = tabId ?? getBackgroundTabId();
          if (tid !== null) {
            await chrome.tabs.update(tid, { url: `https://www.threads.com/@${encodeURIComponent(follower.username)}` });
            await waitForTabLoad(tid, signal);
            await sleep(3, signal);
            await ensureContentScript(tid);
          }
        } catch {
          // Tab might be gone too — will be recreated on next iteration
          tabId = null;
          clearBackgroundTabId();
        }
        await markScanError(follower.username, "channel_lost");
      } else {
        consecutiveBlocked++;
        await rateTracker.recordError();
        log("ERROR", "clean", m("scan_error", follower.username, errMsg));
      }
      await sleep(2, signal).catch(() => {});
    }
  }

  // Free tier: only count this cycle against the daily limit if it actually did
  // something — an immediate hard-429 (0 processed) must not burn the free cycle.
  if (!licence.active && (scanned > 0 || removed > 0 || reviewed > 0)) {
    await incrementDailyUsage("cycles");
  }

  await updateScanSession(sessionId, {
    status: signal.aborted ? "stopped" : "completed",
    scannedCount: scanned,
    fakeCount: fakesFound,
    removedCount: removed,
    finishedAt: Date.now(),
  });

  log("INFO", "clean", m("cycle_done", scanned, removed, reviewed));

  // Perf summary: net work vs wall time. Wall time includes the deliberate
  // pacing — the gap between the two is the anti-block budget, by design.
  const wallSeconds = Math.round(cycleSpan.end({ scanned, removed }) / 1000);
  const workSeconds = Math.round(workMs / 1000);
  log("INFO", "perf", m("perf_cycle_summary", scanned, workSeconds, wallSeconds));
  reportTelemetry({
    category: "perf",
    errorCode: "clean_cycle_complete",
    reason: `profiles_${coarseBucket(scanned, [10, 25, 50])}`,
    value: workSeconds,
  }).catch(() => {});

  // Push tous les fakes du cycle au pool communautaire (1 seul batch).
  // Le worker rate-limite a 20 batches/h donc on rentre largement.
  // Free users : reportSightings() bypass tout seul si licence inactive.
  if (cycleSightings.size > 0) {
    const batch = [...cycleSightings].slice(0, 50); // worker accepte max 50 par batch
    reportSightings(batch).catch(() => {});
  }

  // Notification Chrome pour les utilisateurs free quand des fakes sont detectes
  const notifLicence = await getLicense();
  if (!notifLicence.active && removed > 0) {
    try {
      chrome.notifications.create("wfc-scan-done", {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "Wav Fake Cleaner",
        message: m("notification_fakes_found", removed),
      });
    } catch { /* notifications may not be available */ }
  }

  await updateState({ stage: "idle" });
  await broadcastStats();
  return removed;
}

// ── Continuous mode (replaces Autopilot) ──

export function runContinuous(): Promise<void> {
  return withPipelineLock(async () => {
    if (isRunning()) return;
    abortController = new AbortController();
    const signal = abortController.signal;

    await startKeepAlive();
    await loadLang();
    log("INFO", "pipeline", m("continuous_start"));
    await updateState({ stage: "cleaning" });

    let sessionStartedAt = Date.now();
    let cyclesInSession = 0;

    try {
      while (!signal.aborted) {
        // ── Session time guard: mandatory long break after N hours ──
        // This is the ONLY automatic break in continuous mode. After the pause
        // the loop resumes by itself — it never exits until the user clicks Stop.
        const sessionHours = (Date.now() - sessionStartedAt) / (3600 * 1000);
        if (sessionHours >= CONTINUOUS_SESSION_MAX_HOURS) {
          const breakDuration = randomBetween(...CONTINUOUS_LONG_BREAK);
          const breakMin = Math.round(breakDuration / 60);
          log("WARNING", "pipeline", m("continuous_session_break", breakMin, cyclesInSession));
          await closeBackgroundTab();
          await pausedSleep(breakDuration, "session_break", signal);
          if (signal.aborted) break;
          // Reset session counters after the break and resume
          sessionStartedAt = Date.now();
          cyclesInSession = 0;
          log("INFO", "pipeline", m("continuous_session_resume"));
        }

        // Run a clean cycle
        await runCleanCycleInternal(signal);
        if (signal.aborted) break;
        cyclesInSession++;

        // Check if there are more pending followers
        let remaining = await getFollowersPending(1);
        if (remaining.length === 0) {
          // No more pending — re-fetch to pick up newly-gained followers
          log("INFO", "pipeline", m("continuous_fetch"));
          await runFetchInternal(signal);
          if (signal.aborted) break;
          remaining = await getFollowersPending(1);
        }

        if (remaining.length === 0) {
          // Account is clean: nothing left to scan/remove. Spinning empty cycles
          // would reopen a background tab every few minutes for no work, so idle
          // for a long stretch then loop back to re-fetch/scan later (continuous
          // mode still catches future fake followers).
          const idle = randomBetween(...CONTINUOUS_IDLE_PAUSE);
          log("INFO", "pipeline", m("continuous_idle", Math.round(idle / 60)));
          await closeBackgroundTab();
          await pausedSleep(idle, "idle", signal);
          continue;
        }

        // ── Adaptive inter-cycle pause: longer as the session ages ──
        const ageFactor = 1 + sessionHours * 0.15; // +15% per hour
        const basePause = randomBetween(...INTER_CYCLE_PAUSE);
        const pause = basePause * ageFactor;
        log("INFO", "pipeline", m("continuous_pause", Math.round(pause)));
        await pausedSleep(pause, "inter_cycle", signal);
      }
    } finally {
      log("INFO", "pipeline", m("continuous_stop"));
      await closeBackgroundTab();
      await updateState({ stage: "idle" });
      await broadcastStats();
      await stopKeepAlive();
      abortController = null;
    }
  });
}

// ── Helpers ──

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Sleep through a long anti-block pause while telling the UI when we'll resume.
 * Sets pausedUntil/pauseReason in the pipeline state (so ControlPanel can show a
 * live countdown instead of a frozen progress bar), then clears them when the
 * pause ends or is aborted.
 */
async function pausedSleep(seconds: number, reason: string, signal: AbortSignal): Promise<void> {
  await updateState({ pausedUntil: Date.now() + seconds * 1000, pauseReason: reason });
  await broadcastStats();
  try {
    await sleep(seconds, signal);
  } finally {
    await updateState({ pausedUntil: null, pauseReason: null });
    await broadcastStats();
  }
}

// ── Exports for service worker ──

export { isRunning, rateTracker };
