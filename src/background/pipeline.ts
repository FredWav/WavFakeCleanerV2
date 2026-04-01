/**
 * Pipeline — orchestrates Fetch → Score → Clean automation.
 *
 * Ported from backend/engine/pipeline.py.
 * Runs in the service worker, delegates DOM work to content scripts.
 */

import type {
  FollowerRecord,
  PipelineState,
  Settings,
  LogEntry,
} from "@shared/types";
import type { ContentFollowerMeta, ContentProfileData, BroadcastMessage } from "@shared/messages";
import { AUTOPILOT } from "@shared/constants";
import { FREE_LIMITS } from "@shared/types";
import { scoreProfile, preScoreFromMetadata } from "./scorer";
import {
  upsertFollowers,
  getFollower,
  updateFollower,
  getFollowersPending,
  getFollowersFake,
  getSettings,
  savePipelineState,
  computeStats,
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

// ── Pipeline singleton ──

let abortController: AbortController | null = null;
const rateTracker = new RateTracker();
const pacer = new HumanPacer();

function isRunning(): boolean {
  return abortController !== null && !abortController.signal.aborted;
}

export function stopPipeline(): void {
  abortController?.abort();
  abortController = null;
}

function broadcast(msg: BroadcastMessage): void {
  chrome.runtime.sendMessage(msg).catch(() => {
    // sidepanel may not be open
  });
}

function log(level: LogEntry["level"], category: string, message: string): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    category,
    message,
  };
  broadcast({ type: "LOG_EVENT", payload: entry });
}

async function broadcastStats(): Promise<void> {
  const stats = await computeStats(isRunning(), rateTracker.getStats());
  broadcast({ type: "STATS_UPDATED", payload: stats });
}

async function updateState(state: Partial<PipelineState>): Promise<void> {
  const full: PipelineState = {
    stage: "idle",
    sessionId: null,
    progress: 0,
    total: 0,
    lastError: null,
    ...state,
  };
  await savePipelineState(full);
  broadcast({ type: "PIPELINE_STATE", payload: full });
}

// ── Send command to content script in the active Threads tab ──

async function findThreadsTab(): Promise<chrome.tabs.Tab> {
  const patterns = [
    "https://www.threads.net/*",
    "https://threads.net/*",
    "https://www.threads.com/*",
    "https://threads.com/*",
  ];
  const allTabs: chrome.tabs.Tab[] = [];
  for (const url of patterns) {
    const tabs = await chrome.tabs.query({ url });
    allTabs.push(...tabs);
  }
  if (allTabs.length === 0) {
    throw new Error("No Threads tab open — open threads.net or threads.com first");
  }
  // Prefer the active tab, then any tab with a profile URL
  const active = allTabs.find((t) => t.active);
  if (active) return active;
  const profile = allTabs.find((t) => t.url?.includes("/@"));
  if (profile) return profile;
  return allTabs[0];
}

// ── Background tab management ──

let backgroundTabId: number | null = null;

async function getOrCreateBackgroundTab(): Promise<number> {
  // Reuse existing background tab if still open
  if (backgroundTabId !== null) {
    try {
      const tab = await chrome.tabs.get(backgroundTabId);
      if (tab) return backgroundTabId;
    } catch {
      backgroundTabId = null;
    }
  }

  // Create a new background tab (active: false = doesn't steal focus)
  const tab = await chrome.tabs.create({
    url: "https://www.threads.com/",
    active: false,
  });

  backgroundTabId = tab.id!;
  log("INFO", "pipeline", `Background tab created (id=${backgroundTabId})`);

  // Wait for initial load
  await waitForTabLoad(backgroundTabId);
  await new Promise((r) => setTimeout(r, 2000));

  return backgroundTabId;
}

async function closeBackgroundTab(): Promise<void> {
  if (backgroundTabId !== null) {
    try {
      await chrome.tabs.remove(backgroundTabId);
      log("INFO", "pipeline", "Background tab closed");
    } catch {
      // already closed
    }
    backgroundTabId = null;
  }
}

async function waitForTabLoad(tabId: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(); // resolve anyway after timeout
    }, 15000);

    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error("aborted"));
      });
    }

    const listener = (
      updatedTabId: number,
      changeInfo: chrome.tabs.TabChangeInfo
    ) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function ensureContentScript(tabId: number): Promise<void> {
  try {
    // Try a quick ping to see if the content script is already loaded
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
    log("INFO", "pipeline", `Content script already active on tab ${tabId}`);
  } catch {
    // Content script not loaded — inject it dynamically
    log("WARNING", "pipeline", `Content script not found on tab ${tabId}, injecting dynamically...`);
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
      // Wait for it to initialize
      await new Promise((r) => setTimeout(r, 500));
      log("INFO", "pipeline", `Content script injected successfully on tab ${tabId}`);
    } catch (injectErr) {
      log("ERROR", "pipeline", `Failed to inject content script: ${injectErr}`);
      throw new Error(`Cannot inject content script: ${injectErr}`);
    }
  }
}

async function sendToContentScript<T>(command: unknown): Promise<T> {
  const tab = await findThreadsTab();
  log("INFO", "pipeline", `Found Threads tab: id=${tab.id}, url=${tab.url}`);

  // Ensure content script is loaded (inject if needed)
  await ensureContentScript(tab.id!);

  try {
    const response = await chrome.tabs.sendMessage(tab.id!, command);
    return response as T;
  } catch (err) {
    log("ERROR", "pipeline", `sendMessage failed: ${err}`);
    throw err;
  }
}

// ── Fetch phase ──

export async function runFetch(): Promise<void> {
  if (isRunning()) return;
  abortController = new AbortController();
  await startKeepAlive();
  try {
    await runFetchInternal(abortController.signal);
  } finally {
    await stopKeepAlive();
    abortController = null;
  }
}

async function runFetchInternal(signal: AbortSignal): Promise<void> {
  await rateTracker.load();

  const settings = await getSettings();
  const username = settings.threadsUsername;
  if (!username) {
    log("ERROR", "pipeline", "No username configured");
    return;
  }

  log("INFO", "fetch", `Fetching your followers list (@${username})...`);
  await updateState({ stage: "fetching" });

  try {
    // Force-close any existing background tab (stale content script after extension reload)
    await closeBackgroundTab();

    // Use background tab on user's profile page (needs auth context + bridge)
    const tabId = await getOrCreateBackgroundTab();
    const profileUrl = `https://www.threads.com/@${username}`;
    await chrome.tabs.update(tabId, { url: profileUrl });
    await waitForTabLoad(tabId, signal);
    await new Promise((r) => setTimeout(r, 3000));
    await ensureContentScript(tabId);

    // Retry logic: message channel can close after extension reload
    let result: { collected: Record<string, ContentFollowerMeta>; method: string } | { error: string } | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        result = await chrome.tabs.sendMessage(tabId, {
          type: "FETCH_FOLLOWERS",
          payload: { username },
        }) as typeof result;
        break; // Success
      } catch (msgErr) {
        const errMsg = String(msgErr);
        if (errMsg.includes("message channel closed") || errMsg.includes("Receiving end does not exist")) {
          log("WARNING", "pipeline", `Message channel error (attempt ${attempt + 1}/3), re-injecting content script...`);
          await new Promise((r) => setTimeout(r, 2000));
          // Re-navigate and re-inject
          await chrome.tabs.update(tabId, { url: profileUrl });
          await waitForTabLoad(tabId, signal);
          await new Promise((r) => setTimeout(r, 3000));
          await ensureContentScript(tabId);
        } else {
          throw msgErr; // Different error, don't retry
        }
      }
    }

    if (!result) {
      log("ERROR", "pipeline", "Fetch failed after 3 retries — message channel keeps closing");
      await updateState({ stage: "idle", lastError: "message_channel_closed" });
      return;
    }

    type FetchSuccess = { collected: Record<string, ContentFollowerMeta>; method: string };
    type FetchError = { error: string };
    const fetchResult = result as FetchSuccess | FetchError;

    if ("error" in fetchResult) {
      log("ERROR", "pipeline", `Fetch failed: ${(fetchResult as FetchError).error}`);
      await updateState({ stage: "idle", lastError: (fetchResult as FetchError).error });
      return;
    }

    const successResult = fetchResult as FetchSuccess;
    const total = Object.keys(successResult.collected).length;
    log("INFO", "fetch", `${total} followers found, saving...`);
    await updateState({ stage: "fetching", total, progress: 0 });

    // Save to IndexedDB
    const now = Date.now();
    const records: FollowerRecord[] = [];
    let newCount = 0;

    for (const [pseudo, meta] of Object.entries(successResult.collected) as [string, ContentFollowerMeta][]) {
      if (pseudo === username) continue;

      const existing = await getFollower(pseudo);
      if (existing) {
        // Update metadata but keep scoring
        await updateFollower(pseudo, {
          fullName: meta.fullName || existing.fullName,
          followersCount: meta.followerCount ?? existing.followersCount,
          isPrivate: meta.isPrivate,
          isVerified: meta.isVerified,
          hasProfilePic: meta.hasProfilePic,
          bio: meta.biography || existing.bio,
        });
      } else {
        newCount++;
        records.push({
          username: pseudo,
          fullName: meta.fullName,
          bio: meta.biography,
          followersCount: meta.followerCount,
          followingCount: null,
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

    if (records.length > 0) {
      await upsertFollowers(records);
    }

    log(
      "INFO",
      "fetch",
      `Done: ${total} followers fetched, ${newCount} new — click Analyser to scan them`
    );
  } catch (e) {
    log("ERROR", "pipeline", `Fetch error: ${e}`);
    await updateState({ stage: "idle", lastError: String(e) });
  } finally {
    await updateState({ stage: "idle" });
    await broadcastStats();
  }
}

// ── Scan phase ──

export async function runScan(batchSize?: number): Promise<void> {
  if (isRunning()) return;
  abortController = new AbortController();
  await startKeepAlive();
  try {
    await runScanInternal(batchSize, abortController.signal);
  } finally {
    await closeBackgroundTab();
    await stopKeepAlive();
    abortController = null;
  }
}

async function runScanInternal(batchSize: number | undefined, signal: AbortSignal): Promise<void> {
  await rateTracker.load();

  const settings = await getSettings();
  rateTracker.setProfile(settings.safetyProfile);

  // Check free tier scan limit
  const licence = await getLicense();
  const usage = await getDailyUsage();
  if (!licence.active && usage.scans >= FREE_LIMITS.scansPerDay) {
    log("WARNING", "scan", `Daily scan limit reached (${FREE_LIMITS.scansPerDay}). Upgrade your license for extended limits.`);
    return;
  }

  // Cap batch for free users
  const maxBatch = !licence.active
    ? Math.min(batchSize || 500, FREE_LIMITS.scansPerDay - usage.scans)
    : (batchSize || 500);
  const pending = await getFollowersPending(maxBatch);

  if (pending.length === 0) {
    log("INFO", "scan", "All followers have been analyzed already.");
    return;
  }

  // Reset error counters from previous runs
  await rateTracker.resetErrors();

  log("INFO", "scan", `Analyzing ${pending.length} followers...`);
  await updateState({ stage: "scanning", total: pending.length, progress: 0 });

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

  let scanned = 0;
  let fakes = 0;
  const needsDomScan: FollowerRecord[] = [];
  const threshold = settings.scoreThreshold;

  // ═══════════════════════════════════════════════
  // PHASE 1: Score from metadata (instant, no navigation)
  // ═══════════════════════════════════════════════
  log("INFO", "scan", `Quick analysis of ${pending.length} profiles...`);

  for (const follower of pending) {
    if (signal.aborted) break;

    // All accounts go through the same pre-scorer — no shortcut for verified
    // (verified can still be bots, and the scorer now applies -25 for the verified badge)
    // For private accounts the followers-list API often omits profile_pic_url,
    // making hasProfilePic unreliable — so we use the same conservative pre-scorer
    // as for public accounts rather than the full scorer.
    // Phase 2 DOM visit will extract accurate bio/pic/followerCount for everyone else.
    const hasBio = (follower.bio || "").length >= 3;
    const { score: metaScore, details: metaDetails } = preScoreFromMetadata(
      follower.username,
      follower.followersCount,
      follower.isPrivate,
      follower.fullName,
      follower.hasProfilePic,
      hasBio,
      follower.isVerified
    );

    if (metaScore !== null && metaScore >= threshold) {
      await updateFollower(follower.username, {
        score: metaScore,
        scoreBreakdown: JSON.stringify(metaDetails),
        isFake: true,
        toReview: false,
        scanned: true,
        status: "fake",
        scannedAt: Date.now(),
      });
      scanned++;
      fakes++;
      continue;
    }

    // Everything else needs a real profile visit for accurate scoring
    needsDomScan.push(follower);
  }

  log("INFO", "scan",
    `Quick analysis done: ${scanned} already processed, ${needsDomScan.length} need detailed check`
  );
  await updateState({ stage: "scanning", progress: scanned, total: pending.length });
  await broadcastStats();

  // ═══════════════════════════════════════════════
  // PHASE 2: DOM scan for borderline public accounts
  // ═══════════════════════════════════════════════
  if (needsDomScan.length > 0 && !signal.aborted) {
    log("INFO", "scan", `Detailed scan of ${needsDomScan.length} profiles (this takes time)...`);

    // Sort by score descending (most suspicious first) for efficiency
    needsDomScan.sort((a, b) => {
      const scoreA = a.score ?? 50;
      const scoreB = b.score ?? 50;
      return scoreB - scoreA;
    });

    let tabId: number | null = null;

    async function ensureTab(): Promise<number> {
      // Check if current tab is still alive
      if (tabId !== null) {
        try {
          await chrome.tabs.get(tabId);
          return tabId;
        } catch {
          log("WARNING", "pipeline", `Background tab ${tabId} lost, recreating...`);
          tabId = null;
          backgroundTabId = null; // Reset the module-level variable too
        }
      }
      // Create a new one
      tabId = await getOrCreateBackgroundTab();
      return tabId;
    }

    let consecutiveBlocked = 0;

    for (const follower of needsDomScan) {
      if (signal.aborted) break;
      if (!rateTracker.canAct()) {
        const rs = rateTracker.getStats();
        log("WARNING", "pipeline", `Rate limited — ${rs.actionsThisHour}/${rs.limitHour}h, ${rs.actionsToday}/${rs.limitDay}d — stopping scan`);
        break;
      }

      const { stop, reason } = rateTracker.shouldStop();
      if (stop) {
        log("WARNING", "pipeline", `Auto-stop: ${reason}`);
        break;
      }

      // Detect if Threads is blocking us (5+ consecutive 429s or errors)
      if (consecutiveBlocked >= 5) {
        log("WARNING", "scan", `Threads seems to be slowing us down. Pausing for 5 minutes...`);
        await sleep(300, signal).catch(() => {});
        consecutiveBlocked = 0;
        // If still blocked after pause, stop
        if (consecutiveBlocked >= 5) break;
      }

      try {
        // Get or recreate the tab (handles "No tab with id" errors)
        const currentTabId = await ensureTab();

        const profileUrl = `https://www.threads.com/@${follower.username}`;
        await chrome.tabs.update(currentTabId, { url: profileUrl });
        await waitForTabLoad(currentTabId, signal);
        await sleep(1.5 + Math.random() * 1, signal);
        await ensureContentScript(currentTabId);

        const profileData = await chrome.tabs.sendMessage(currentTabId, {
          type: "SCAN_PROFILE",
          payload: { username: follower.username },
        });

        if (profileData && profileData.error === "429_RATE_LIMIT") {
          consecutiveBlocked++;
          await rateTracker.recordError();
          log("WARNING", "scan", `@${follower.username}: 429 rate limit (blocked: ${consecutiveBlocked})`);
          await sleep(30 + Math.random() * 30, signal);
          continue;
        }

        consecutiveBlocked = 0; // Reset on success

        if (profileData && profileData.notFound) {
          await updateFollower(follower.username, {
            score: 100,
            scoreBreakdown: JSON.stringify(["not_found"]),
            isFake: true,
            scanned: true,
            status: "fake",
            scannedAt: Date.now(),
          });
          scanned++;
          fakes++;
          log("INFO", "scan", `@${follower.username}: NOT FOUND → score=100 FAKE`);
        } else if (profileData) {
          const scored = scoreProfile(profileData, threshold);
          await updateFollower(follower.username, {
            score: scored.score,
            scoreBreakdown: JSON.stringify(scored.breakdown),
            isFake: scored.isFake,
            toReview: scored.toReview,
            scanned: true,
            status: scored.isFake ? "fake" : "scanned",
            scannedAt: Date.now(),
            followersCount: profileData.followerCount ?? follower.followersCount,
            fullName: profileData.fullName || follower.fullName,
            isPrivate: profileData.isPrivate ?? follower.isPrivate,
            isVerified: profileData.isVerified ?? follower.isVerified,
          });
          scanned++;
          if (scored.isFake) fakes++;
          log("INFO", "scan",
            `@${follower.username}: score=${scored.score} ${scored.isFake ? "FAKE" : scored.toReview ? "REVIEW" : "OK"}`
          );
          await rateTracker.recordSuccess();
        } else {
          consecutiveBlocked++;
          await updateFollower(follower.username, { scanError: "no_data" });
          await rateTracker.recordError();
          log("WARNING", "scan", `@${follower.username}: no data returned`);
        }

        await rateTracker.recordAction();
        await updateState({ stage: "scanning", progress: scanned, total: pending.length });
        await broadcastStats();

        // Shorter pace than before since Phase 2 handles fewer accounts
        const delay = pacer.nextScanPause();
        await sleep(delay, signal);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);

        // If the tab was lost, reset tabId so ensureTab() recreates it
        if (errMsg.includes("No tab with id") || errMsg.includes("Cannot inject")) {
          log("WARNING", "scan", `@${follower.username}: tab lost (${errMsg}), will recreate`);
          tabId = null;
          backgroundTabId = null;
          // Retry this profile on next iteration is not trivial, so just skip it
          await updateFollower(follower.username, { scanError: "tab_lost", status: "pending" });
        } else {
          consecutiveBlocked++;
          await rateTracker.recordError();
          log("ERROR", "scan", `@${follower.username}: ${errMsg}`);
        }
        await sleep(2, signal).catch(() => {});
      }
    }
  }

  // Finalize
  // Track total scans (Phase 1 + Phase 2) for free tier
  if (!licence.active && scanned > 0) {
    await incrementDailyUsage("scans", scanned);
  }

  await updateScanSession(sessionId, {
    status: signal.aborted ? "stopped" : "completed",
    scannedCount: scanned,
    fakeCount: fakes,
    finishedAt: Date.now(),
  });

  log("INFO", "scan", `Analysis complete: ${scanned} profiles analyzed, ${fakes} fakes detected`);
  await updateState({ stage: "idle" });
  await broadcastStats();
}

// ── Clean phase ──

export async function runClean(batchSize?: number): Promise<void> {
  if (isRunning()) return;
  abortController = new AbortController();
  await startKeepAlive();
  try {
    await runCleanInternal(batchSize, abortController.signal);
  } finally {
    await closeBackgroundTab();
    await stopKeepAlive();
    abortController = null;
  }
}

async function runCleanInternal(batchSize: number | undefined, signal: AbortSignal): Promise<void> {
  await rateTracker.load();

  const settings = await getSettings();
  rateTracker.setProfile(settings.safetyProfile);

  // Check free tier removal limit
  const licence = await getLicense();
  const usage = await getDailyUsage();
  if (!licence.active && usage.removals >= FREE_LIMITS.removalsPerDay) {
    log("WARNING", "clean", `Daily removal limit reached (${FREE_LIMITS.removalsPerDay}). Upgrade your license for extended limits.`);
    return;
  }

  // Reset error counters from previous runs
  await rateTracker.resetErrors();

  const fakeFollowers = await getFollowersFake();
  const maxBatch = !licence.active
    ? Math.min(batchSize || 50, FREE_LIMITS.removalsPerDay - usage.removals)
    : (batchSize || 50);
  const batch = fakeFollowers.slice(0, maxBatch);

  if (batch.length === 0) {
    log("INFO", "clean", "No fake followers to remove.");
    return;
  }

  log("INFO", "clean", `Removing ${batch.length} fake followers...`);
  await updateState({ stage: "cleaning", total: batch.length, progress: 0 });

  let removed = 0;
  let consecutiveBlocked = 0;

  try {
    for (const follower of batch) {
      if (signal.aborted) break;
      if (!rateTracker.canAct()) {
        log("WARNING", "pipeline", "Rate limited — stopping clean");
        break;
      }

      const { stop, reason } = rateTracker.shouldStop();
      if (stop) {
        log("WARNING", "pipeline", `Auto-stop: ${reason}`);
        break;
      }

      // If Threads is blocking us, stop immediately
      if (consecutiveBlocked >= 3) {
        log("ERROR", "clean", `Threads is temporarily blocking removals. Please wait 30 minutes before trying again.`);
        break;
      }

      try {
        // Navigate background tab to follower's profile page
        const tabId = await getOrCreateBackgroundTab();
        const profileUrl = `https://www.threads.com/@${follower.username}`;
        await chrome.tabs.update(tabId, { url: profileUrl });
        await waitForTabLoad(tabId, signal);
        await sleep(2 + Math.random() * 1.5, signal);
        await ensureContentScript(tabId);

        const result = await chrome.tabs.sendMessage(tabId, {
          type: "REMOVE_FOLLOWER",
          payload: { username: follower.username },
        }) as { success: boolean; action: string; error?: string; blocked?: boolean };

        await rateTracker.recordAction();

        if (result.success) {
          consecutiveBlocked = 0;
          await rateTracker.recordSuccess();
          await updateFollower(follower.username, {
            removed: true,
            status: "removed",
            removedAt: Date.now(),
          });
          removed++;
          if (!licence.active) await incrementDailyUsage("removals");
          log("INFO", "clean", `@${follower.username} removed`);

          await addActionLog({
            actionType: "remove",
            target: follower.username,
            status: "ok",
            errorDetail: null,
            durationMs: null,
            createdAt: Date.now(),
          });
        } else {
          await rateTracker.recordError();

          // Detect Threads blocking
          if (result.blocked || result.error === "threads_blocked") {
            consecutiveBlocked++;
            log("WARNING", "clean", `@${follower.username}: blocked by Threads`);

            await addActionLog({
              actionType: "remove",
              target: follower.username,
              status: "error_429",
              errorDetail: `threads_blocked: ${result.error}`,
              durationMs: null,
              createdAt: Date.now(),
            });

            // Long pause before retry
            if (consecutiveBlocked < 3) {
              log("WARNING", "clean", `Waiting 60s before retrying...`);
              await sleep(60 + Math.random() * 30, signal);
            }
          } else {
            log("WARNING", "clean", `@${follower.username}: failed — ${result.error}`);

            await addActionLog({
              actionType: "remove",
              target: follower.username,
              status: "error_other",
              errorDetail: result.error || null,
              durationMs: null,
              createdAt: Date.now(),
            });
          }
        }

        await updateState({ stage: "cleaning", progress: removed, total: batch.length });
        await broadcastStats();

        // Pace — longer delays for removal to avoid triggering Threads
        const delay = pacer.nextPause() * 1.5;
        await sleep(delay, signal);
      } catch (e) {
        await rateTracker.recordError();
        consecutiveBlocked++;
        log("ERROR", "clean", `@${follower.username}: ${e}`);
        if (consecutiveBlocked >= 3) break;
      }
    }
  } finally {
    const status = consecutiveBlocked >= 3 ? " (STOPPED: Threads blocking detected)" : "";
    log("INFO", "pipeline", `Clean done: ${removed} removed${status}`);
    await updateState({ stage: "idle" });
    await broadcastStats();
  }
}

// ── Autopilot ──

export async function runAutopilot(): Promise<void> {
  if (isRunning()) return;
  abortController = new AbortController();
  const signal = abortController.signal;

  await startKeepAlive();
  log("INFO", "pipeline", "Autopilot started");
  await updateState({ stage: "autopilot" });

  try {
    while (!signal.aborted) {
      // ── Fetch phase ──
      log("INFO", "autopilot", "Starting fetch phase...");
      await runFetchInternal(signal);
      if (signal.aborted) break;

      const pauseFetch = randomBetween(...AUTOPILOT.pauseBetween);
      log("INFO", "autopilot", `Pause ${Math.round(pauseFetch)}s before scan...`);
      await sleep(pauseFetch, signal);
      if (signal.aborted) break;

      // ── Scan phase ──
      const scanBatch = Math.floor(randomBetween(...AUTOPILOT.scanBatch));
      log("INFO", "autopilot", `Starting scan phase (batch=${scanBatch})...`);
      await runScanInternal(scanBatch, signal);
      if (signal.aborted) break;

      const pauseScan = randomBetween(...AUTOPILOT.pauseScan);
      log("INFO", "autopilot", `Pause ${Math.round(pauseScan)}s before clean...`);
      await sleep(pauseScan, signal);
      if (signal.aborted) break;

      // ── Clean phase ──
      const cleanBatch = Math.floor(randomBetween(...AUTOPILOT.cleanBatch));
      log("INFO", "autopilot", `Starting clean phase (batch=${cleanBatch})...`);
      await runCleanInternal(cleanBatch, signal);
      if (signal.aborted) break;

      // Wait before next cycle
      const pauseClean = randomBetween(...AUTOPILOT.pauseClean);
      log("INFO", "autopilot", `Cycle done. Next cycle in ${Math.round(pauseClean)}s...`);
      await sleep(pauseClean, signal);
    }
  } finally {
    log("INFO", "pipeline", "Autopilot stopped");
    await closeBackgroundTab();
    await updateState({ stage: "idle" });
    await broadcastStats();
    await stopKeepAlive();
    abortController = null;
  }
}

// ── Helpers ──

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function apiProfileToProfileData(
  username: string,
  data: Record<string, unknown>
): import("@shared/types").ProfileData {
  const mediaCount = (data.mediaCount as number) ?? 0;
  return {
    username,
    notFound: false,
    isPrivate: !!data.isPrivate,
    isVerified: !!data.isVerified,
    followerCount: (data.followerCount as number) ?? null,
    postCount: mediaCount,
    hasBio: ((data.biography as string) || "").length >= 5,
    hasReplies: false, // Can't determine from API alone
    hasRealPic: !isDefaultPic((data.profilePicUrl as string) || ""),
    hasFullName:
      ((data.fullName as string) || "").length >= 3 &&
      (data.fullName as string) !== username,
    hasIgLink: false, // Can't determine from API alone
    hasLinkInBio:
      ((data.externalUrl as string) || "").length > 0 ||
      ((data.bioLinks as string[]) || []).length > 0,
    fullName: (data.fullName as string) || "",
    allPostsRecent: false,
    duplicateRatio: 0,
    hasSpamKeywords: false,
    error: null,
  };
}

function isDefaultPic(url: string): boolean {
  if (!url) return true;
  return ["default", "empty", "placeholder", "/44884218_345"].some((p) =>
    url.includes(p)
  );
}

// ── Exports for service worker ──

export { isRunning, rateTracker };
