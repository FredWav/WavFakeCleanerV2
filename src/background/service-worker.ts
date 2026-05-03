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
import { submitVote, reportSightings } from "./community";
import { verifyLicenceToken } from "./licence-verify";

// ── Récupération après crash du service worker ──

(async () => {
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
      const sessionId = (msg.payload as { key: string }).key?.trim();
      if (!sessionId) {
        return { ok: false, error: "licence_invalid" };
      }

      // ── Owner / beta licence path: Ed25519 signature verification ──
      // The public key is safe to embed; only the matching private key (held offline)
      // can produce valid signatures. Each token carries a userId and optional expiry.
      if (sessionId.startsWith("wfc_lic_")) {
        const result = await verifyLicenceToken(sessionId);
        if (!result.valid) {
          return { ok: false, error: "licence_invalid" };
        }
        await saveLicense({
          active: true,
          key: "owner-" + (result.userId ?? "unknown"),
          activatedAt: Date.now(),
          communityToken: null,
        });
        return { ok: true };
      }

      // ── Stripe path: validate format then verify against the Cloudflare Worker ──
      const STRIPE_RE = /^cs_(live|test)_[A-Za-z0-9]{20,80}$/;
      if (!STRIPE_RE.test(sessionId)) {
        return { ok: false, error: "licence_invalid" };
      }
      try {
        const { LICENCE_VERIFY_URL } = await import("@shared/constants");
        const res = await fetch(`${LICENCE_VERIFY_URL}?session_id=${encodeURIComponent(sessionId)}`, {
          headers: { "Accept": "application/json" },
        });
        if (!res.ok) {
          return { ok: false, error: "network_error" };
        }
        const data = await res.json() as { valid: boolean; communityToken?: string };
        if (!data.valid) {
          return { ok: false, error: "licence_invalid" };
        }
        // Payment confirmed — activate (include communityToken if issued by the Worker)
        await saveLicense({
          active: true,
          key: sessionId,
          activatedAt: Date.now(),
          communityToken: data.communityToken ?? null,
        });
      } catch {
        return { ok: false, error: "network_error" };
      }
      return { ok: true };
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

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "rate-reset-check") {
    // RateTracker auto-rotates counters on access, so just load it
    await rateTracker.load();
  }
});

// ── Install handler ──

chrome.runtime.onInstalled.addListener(() => {
  console.log("Wav Fake Cleaner V2 installed");
});
