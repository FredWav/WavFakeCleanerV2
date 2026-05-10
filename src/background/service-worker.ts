/**
 * Service Worker — main entry point for the extension background.
 *
 * Handles message routing, alarm management, and side panel setup.
 */

import type { RequestMessage, ContentMessage } from "@shared/messages";
import type { Stats } from "@shared/types";
import {
  getSettings,
  saveSettings,
  getFollowers,
  updateFollower,
  computeStats,
  resetScannedFollowers,
  getLicense,
  saveLicense,
  getPipelineState,
  savePipelineState,
  purgeOwnerSubPageFakes,
  exportLicenseBackup,
  readLicenseBackup,
} from "./storage";
import {
  runFetch,
  runCleanCycle,
  runContinuous,
  stopPipeline,
  isRunning,
  rateTracker,
  persistFollowerPage,
} from "./pipeline";
import { restoreSessionState } from "./pipeline/tab-manager";
import { submitVote, reportSightings, processCommunityQueue } from "./community";
import { verifyLicenceToken } from "./licence-verify";

// ── Récupération après crash du service worker ──
// MV3 service workers terminate after ~30s of inactivity. On restart we:
//   1) Restore the cached background tab ID from chrome.storage.session
//      (in tab-manager) so we don't spawn a duplicate tab.
//   2) Reset any stale "running" pipeline state — the pipeline orchestrator
//      itself doesn't survive SW termination, so we mark it idle and surface
//      a recoverable error to the UI.

(async () => {
  try {
    await restoreSessionState();
  } catch (e) {
    console.error("[WFC] Tab recovery failed:", e);
  }

  try {
    const state = await getPipelineState();
    if (state && state.stage !== "idle") {
      console.log("[WFC] Recovery: resetting stale pipeline state:", state.stage);
      await savePipelineState({
        stage: "idle",
        sessionId: null,
        progress: 0,
        total: 0,
        lastError: "service_worker_restart",
      });
    }
  } catch (e) {
    console.error("[WFC] Recovery check failed:", e);
  }

  // One-shot cleanup of historical junk entries (owner-sub-page bug).
  // Runs every SW boot but is a fast no-op once the DB is clean.
  try {
    const settings = await getSettings();
    if (settings.threadsUsername) {
      const removed = await purgeOwnerSubPageFakes(settings.threadsUsername);
      if (removed > 0) {
        console.log(`[WFC] Purged ${removed} junk follower entries (owner sub-pages)`);
      }
    }
  } catch (e) {
    console.error("[WFC] Junk purge failed:", e);
  }
})();

// ── Side panel setup ──

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {
    // fallback: popup will handle it
  });

// ── Message routing ──

chrome.runtime.onMessage.addListener(
  (message: RequestMessage | ContentMessage, _sender, sendResponse: (response: unknown) => void) => {
    handleMessage(message).then(sendResponse).catch((e) => {
      sendResponse({ error: String(e) });
    });
    return true; // async
  }
);

async function handleMessage(msg: RequestMessage | ContentMessage): Promise<unknown> {
  switch (msg.type) {
    case "GET_STATS": {
      const stats = await computeStats(isRunning(), rateTracker.getStats());
      return stats;
    }

    case "GET_FOLLOWERS": {
      const filter = msg.payload?.filter;
      const limit = msg.payload?.limit || 200;
      const search = msg.payload?.search;
      const followers = await getFollowers({
        status: filter || undefined,
        limit,
        search: search || undefined,
      });
      // Add profile_url for the table
      return followers.map((f) => ({
        ...f,
        profile_url: `https://www.threads.net/@${f.username}`,
      }));
    }

    case "GET_SETTINGS":
      return await getSettings();

    case "UPDATE_SETTINGS": {
      const updated = await saveSettings(msg.payload);
      const freshStats = await computeStats(isRunning(), rateTracker.getStats());
      chrome.runtime.sendMessage({ type: "STATS_UPDATED", payload: freshStats }).catch(() => {});
      return updated;
    }

    case "START_FETCH":
      runFetch(); // fire and forget
      return { ok: true };

    case "START_CLEAN":
      runCleanCycle(); // fire and forget
      return { ok: true };

    case "START_CONTINUOUS":
      runContinuous(); // fire and forget
      return { ok: true };

    case "STOP":
      stopPipeline();
      return { ok: true };

    case "RESET_SCANNED": {
      const resetCount = await resetScannedFollowers();
      // Broadcast updated stats
      const resetStats = await computeStats(isRunning(), rateTracker.getStats());
      chrome.runtime.sendMessage({ type: "STATS_UPDATED", payload: resetStats }).catch(() => {});
      return { ok: true, count: resetCount };
    }

    case "APPROVE_FOLLOWER":
      await updateFollower(msg.payload.username, {
        approved: true,
        toReview: false,
        isFake: false,
        status: "approved",
      });
      return { ok: true };

    case "REJECT_FOLLOWER":
      await updateFollower(msg.payload.username, {
        approved: false,
        toReview: false,
        isFake: true,
        status: "fake",
      });
      return { ok: true };

    case "SUBMIT_COMMUNITY_VOTE": {
      const { username, verdict, score } = msg.payload as { username: string; verdict: "fake" | "ok"; score: number };
      try {
        await submitVote(username, verdict, score);
        // Report sighting when user manually flags as fake
        if (verdict === "fake") {
          reportSightings([username]).catch(() => {});
        }
        return { ok: true };
      } catch {
        return { ok: false, error: "vote_failed" };
      }
    }

    case "GET_LICENSE":
      return await getLicense();

    case "ACTIVATE_LICENSE": {
      const raw = (msg.payload as { key: string }).key?.trim();
      if (!raw) {
        return { ok: false, error: "licence_invalid" };
      }

      // Normalize: WFC codes are uppercase, alphanumeric — accept lowercase
      // input but never coerce other formats.
      const WFC_CODE_RE = /^WFC-[A-Z2-9]{4}-[A-Z2-9]{4}$/i;
      const STRIPE_RE = /^cs_(live|test)_[A-Za-z0-9]{20,80}$/;

      // ── Owner / beta licence path: Ed25519 signature verification ──
      // The public key is safe to embed; only the matching private key (held offline)
      // can produce valid signatures. Each token carries a userId and optional expiry.
      if (raw.startsWith("wfc_lic_")) {
        const result = await verifyLicenceToken(raw);
        if (!result.valid) {
          return { ok: false, error: "licence_invalid" };
        }
        await saveLicense({
          active: true,
          key: "owner-" + (result.userId ?? "unknown"),
          activatedAt: Date.now(),
          communityToken: null,
          recoveryToken: raw, // preserved so export/import works
        });
        return { ok: true };
      }

      // ── WFC code path (since 2.2): short product code WFC-XXXX-XXXX ──
      if (WFC_CODE_RE.test(raw)) {
        const code = raw.toUpperCase();
        try {
          const { LICENCE_VERIFY_URL } = await import("@shared/constants");
          const res = await fetch(`${LICENCE_VERIFY_URL}?code=${encodeURIComponent(code)}`, {
            headers: { "Accept": "application/json" },
          });
          if (!res.ok) return { ok: false, error: "network_error" };
          const data = await res.json() as { valid: boolean; communityToken?: string };
          if (!data.valid) return { ok: false, error: "licence_invalid" };
          await saveLicense({
            active: true,
            key: code,
            activatedAt: Date.now(),
            communityToken: data.communityToken ?? code,
            recoveryToken: code,
          });
          return { ok: true };
        } catch {
          return { ok: false, error: "network_error" };
        }
      }

      // ── Stripe legacy path: validate, then upgrade to a WFC code if the
      //    Worker hands one back. Pre-2.2 customers re-activating via their
      //    cs_live_xxx end up with a clean WFC-XXXX-XXXX in their storage. ──
      if (!STRIPE_RE.test(raw)) {
        return { ok: false, error: "licence_invalid" };
      }
      try {
        const { LICENCE_VERIFY_URL } = await import("@shared/constants");
        const res = await fetch(`${LICENCE_VERIFY_URL}?session_id=${encodeURIComponent(raw)}`, {
          headers: { "Accept": "application/json" },
        });
        if (!res.ok) {
          return { ok: false, error: "network_error" };
        }
        const data = await res.json() as { valid: boolean; communityToken?: string; code?: string };
        if (!data.valid) {
          return { ok: false, error: "licence_invalid" };
        }
        const upgradedKey = data.code || raw;
        await saveLicense({
          active: true,
          key: upgradedKey,
          activatedAt: Date.now(),
          communityToken: data.communityToken ?? upgradedKey,
          recoveryToken: upgradedKey, // prefer the short code for backups
        });
      } catch {
        return { ok: false, error: "network_error" };
      }
      return { ok: true };
    }

    case "EXPORT_LICENSE": {
      const backup = await exportLicenseBackup();
      if (!backup) return { ok: false, error: "no_license" };
      return { ok: true, backup };
    }

    case "IMPORT_LICENSE": {
      const { backup } = msg.payload as { backup: unknown };
      const parsed = readLicenseBackup(backup);
      if (!parsed) return { ok: false, error: "invalid_backup" };
      // Re-run activation on the recovered token so we get fresh validation
      // (Stripe re-check, Ed25519 sig verification) and a current
      // communityToken from the Worker.
      return await handleMessage({
        type: "ACTIVATE_LICENSE",
        payload: { key: parsed.key },
      });
    }

    case "KEEPALIVE_PING":
      return { ok: true };

    case "LOG_FROM_CONTENT": {
      const { level, category, message } = msg.payload as { level: string; category: string; message: string };
      const entry = {
        ts: new Date().toISOString(),
        level,
        category,
        message,
      };
      chrome.runtime.sendMessage({ type: "LOG_EVENT", payload: entry }).catch(() => {});
      return { ok: true };
    }

    case "FETCH_PROGRESS": {
      const { page, total } = msg.payload as { page: number; total: number };
      const logEntry = {
        ts: new Date().toISOString(),
        level: "INFO",
        category: "fetch",
        message: `Page ${page} : ${total} followers récupérés…`,
      };
      chrome.runtime.sendMessage({ type: "LOG_EVENT", payload: logEntry }).catch(() => {});
      // Also update pipeline state for progress display
      chrome.runtime.sendMessage({
        type: "PIPELINE_STATE",
        payload: { stage: "fetching", progress: total, total: 0, sessionId: null, lastError: null },
      }).catch(() => {});
      return { ok: true };
    }

    case "FOLLOWERS_PAGE": {
      // Incremental save : the content script sends each page as soon as it's
      // fetched. We persist immediately so a Stop never throws away progress.
      const { users } = msg.payload as { users: Record<string, import("@shared/messages").ContentFollowerMeta> };
      try {
        const settings = await getSettings();
        const ownerUsername = settings.threadsUsername || "";
        const newCount = await persistFollowerPage(users, ownerUsername);
        if (newCount > 0) {
          // Broadcast updated stats so the UI counter ticks up live
          const stats = await computeStats(isRunning(), rateTracker.getStats());
          chrome.runtime.sendMessage({ type: "STATS_UPDATED", payload: stats }).catch(() => {});
        }
        return { ok: true, newCount };
      } catch (e) {
        console.error("[WFC] FOLLOWERS_PAGE persist failed:", e);
        return { ok: false, error: String(e) };
      }
    }

    case "RATE_LIMIT_DETECTED": {
      const blockEntry = {
        ts: new Date().toISOString(),
        level: "ERROR" as const,
        category: "threads",
        message: "⚠️ Threads bloque les actions — attends 30+ minutes avant de réessayer",
      };
      chrome.runtime.sendMessage({ type: "LOG_EVENT", payload: blockEntry }).catch(() => {});
      return { ok: true };
    }

    case "CONTENT_READY":
      return { ok: true };

    default:
      return { error: "unknown_message" };
  }
}

// ── Alarms for periodic tasks ──

chrome.alarms.create("rate-reset-check", { periodInMinutes: 5 });
chrome.alarms.create("community-queue-replay", { periodInMinutes: 15 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "rate-reset-check") {
    // RateTracker auto-rotates counters on access, so just load it
    await rateTracker.load();
  } else if (alarm.name === "community-queue-replay") {
    // Drain any votes/sightings that failed earlier (offline, 5xx, SW restart).
    // 4xx errors and items past the attempt cap are dropped silently.
    try {
      const result = await processCommunityQueue();
      if (result.replayed > 0 || result.dropped > 0) {
        console.log(
          `[WFC] Community queue replay: ${result.replayed} sent, ${result.dropped} dropped, ${result.remaining} pending`,
        );
      }
    } catch (e) {
      console.error("[WFC] Community queue replay failed:", e);
    }
  }
});

// ── Install handler ──

chrome.runtime.onInstalled.addListener(() => {
  console.log("Wav Fake Cleaner V2 installed");
});

// ── Service worker suspend handler ──
// MV3 fires onSuspend ~5s before terminating the worker. We use it to:
//   - mark any in-flight pipeline as interrupted (so next boot reflects it)
// We deliberately do NOT close the background tab here — the tab itself
// belongs to the user's session and chrome.storage.session will let us
// reattach to it on the next boot.

chrome.runtime.onSuspend.addListener(() => {
  if (isRunning()) {
    console.log("[WFC] Service worker suspending while pipeline is running");
    void savePipelineState({
      stage: "idle",
      sessionId: null,
      progress: 0,
      total: 0,
      lastError: "service_worker_suspended",
    });
  }
});
