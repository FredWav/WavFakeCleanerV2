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
} from "./storage";
import {
  runFetch,
  runScan,
  runClean,
  runAutopilot,
  stopPipeline,
  isRunning,
  rateTracker,
} from "./pipeline";

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
      const followers = await getFollowers({
        status: filter || undefined,
        limit,
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
      if (msg.payload.safetyProfile) {
        rateTracker.setProfile(msg.payload.safetyProfile);
      }
      // Broadcast updated stats immediately so UI reflects new limits
      const freshStats = await computeStats(isRunning(), rateTracker.getStats());
      chrome.runtime.sendMessage({ type: "STATS_UPDATED", payload: freshStats }).catch(() => {});
      return updated;
    }

    case "START_FETCH":
      runFetch(); // fire and forget
      return { ok: true };

    case "START_SCAN":
      runScan(msg.payload?.batchSize); // fire and forget
      return { ok: true };

    case "START_CLEAN":
      runClean(msg.payload?.batchSize); // fire and forget
      return { ok: true };

    case "START_AUTOPILOT":
      runAutopilot(); // fire and forget
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

    case "GET_LICENSE":
      return await getLicense();

    case "ACTIVATE_LICENSE": {
      const sessionId = (msg.payload as { key: string }).key?.trim();
      // Stripe session IDs start with cs_live_ or cs_test_
      if (!sessionId || !sessionId.startsWith("cs_")) {
        return { ok: false, error: "licence_invalid" };
      }

      // Verify against the Cloudflare Worker (which calls Stripe API with the secret key)
      try {
        const { LICENCE_VERIFY_URL } = await import("@shared/constants");
        const res = await fetch(`${LICENCE_VERIFY_URL}?session_id=${encodeURIComponent(sessionId)}`, {
          headers: { "Accept": "application/json" },
        });
        if (!res.ok) {
          return { ok: false, error: "network_error" };
        }
        const data = await res.json() as { valid: boolean };
        if (!data.valid) {
          return { ok: false, error: "licence_invalid" };
        }
      } catch {
        return { ok: false, error: "network_error" };
      }

      // Payment confirmed — activate
      await saveLicense({ active: true, key: sessionId, activatedAt: Date.now() });
      const currentSettings = await getSettings();
      if (currentSettings.safetyProfile === "gratuit") {
        await saveSettings({ safetyProfile: "normal" });
        rateTracker.setProfile("normal");
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
        message: `Page ${page}: ${total} followers collected...`,
      };
      chrome.runtime.sendMessage({ type: "LOG_EVENT", payload: logEntry }).catch(() => {});
      // Also update pipeline state for progress display
      chrome.runtime.sendMessage({
        type: "PIPELINE_STATE",
        payload: { stage: "fetching", progress: total, total: 0, sessionId: null, lastError: null },
      }).catch(() => {});
      return { ok: true };
    }

    case "RATE_LIMIT_DETECTED": {
      const blockEntry = {
        ts: new Date().toISOString(),
        level: "ERROR" as const,
        category: "threads",
        message: "⚠️ Threads is blocking actions — wait 30+ minutes before retrying",
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
