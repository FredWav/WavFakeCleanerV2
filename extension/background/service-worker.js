/**
 * Service Worker — orchestrates scan/clean pipeline.
 *
 * Communicates with content script (threads.js) via chrome.tabs.sendMessage.
 * The content script does all DOM interaction; this worker does scoring and coordination.
 */

import { scoreProfile, preScoreFromMetadata } from "./scorer.js";
import { HumanPacer, sleep } from "./pacer.js";
import { QuotaManager } from "./quota.js";

// ── State ───────────────────────────────────────────────────────────────────

const state = {
  running: false,
  phase: "idle",         // idle, fetching, scanning, cleaning, autopilot
  abortController: null,
  stats: { scanned: 0, fakes: 0, removed: 0, errors: 0, preScored: 0 },
  followers: [],         // { username, score, isFake, toReview, ... }
  settings: {
    threshold: 60,
    safetyProfile: "normal",
  },
};

const quota = new QuotaManager();

// ── Init ────────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  await quota.init();
  await loadSettings();
  await loadFollowers();
  console.log("[wav] Extension installed, quota:", quota.plan);
});

chrome.runtime.onStartup.addListener(async () => {
  await quota.init();
  await quota.syncWithBackend();
  await loadSettings();
  await loadFollowers();
});

// ── Message handling ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse).catch((e) => {
    sendResponse({ error: e.message });
  });
  return true; // async response
});

async function handleMessage(msg, sender) {
  switch (msg.action) {
    // ── Pipeline control ──
    case "start_fetch":
      return startPhase("fetching", runFetch);
    case "start_scan":
      return startPhase("scanning", runScan);
    case "start_clean":
      return startPhase("cleaning", runClean);
    case "start_autopilot":
      return startPhase("autopilot", runAutopilot);
    case "stop":
      return stopPipeline();

    // ── Data queries ──
    case "get_state":
      return getPublicState();
    case "get_followers":
      return getFollowers(msg.filter, msg.limit);

    // ── Content script responses ──
    case "profile_data":
      return { ok: true }; // handled inline during scan
    case "follower_list":
      return { ok: true };

    // ── Auth ──
    case "login":
      return handleLogin(msg.email, msg.password);
    case "register":
      return handleRegister(msg.email, msg.password, msg.promoConsent);
    case "logout":
      return handleLogout();
    case "get_auth":
      return { token: (await chrome.storage.local.get("wav_token")).wav_token, plan: quota.plan };

    // ── Settings ──
    case "update_settings":
      return updateSettings(msg.settings);

    // ── Review ──
    case "approve":
      return approveFollower(msg.username);
    case "reject":
      return rejectFollower(msg.username);

    default:
      return { error: `Unknown action: ${msg.action}` };
  }
}

// ── Pipeline orchestration ──────────────────────────────────────────────────

async function startPhase(phase, fn) {
  if (state.running) return { error: "Already running" };
  state.running = true;
  state.phase = phase;
  state.abortController = new AbortController();
  state.stats = { scanned: 0, fakes: 0, removed: 0, errors: 0, preScored: 0 };
  broadcastState();

  try {
    await fn(state.abortController.signal);
  } catch (e) {
    console.error(`[wav] ${phase} error:`, e);
  } finally {
    state.running = false;
    state.phase = "idle";
    broadcastState();
  }
  return { ok: true };
}

function stopPipeline() {
  if (state.abortController) {
    state.abortController.abort();
  }
  state.running = false;
  state.phase = "idle";
  broadcastState();
  return { ok: true, message: "Stopped" };
}

// ── Fetch phase ─────────────────────────────────────────────────────────────

async function runFetch(signal) {
  const tab = await getThreadsTab();
  if (!tab) throw new Error("Ouvre threads.net d'abord");

  // Tell content script to navigate to profile and extract follower list
  const result = await sendToTab(tab.id, { action: "fetch_followers" });
  if (!result || result.error) throw new Error(result?.error || "Fetch failed");

  const collected = result.followers || [];
  let newCount = 0;

  for (const f of collected) {
    const existing = state.followers.find(e => e.username === f.username);
    if (!existing) {
      state.followers.push({
        username: f.username,
        fullName: f.fullName || "",
        followerCount: f.followerCount ?? null,
        isPrivate: f.isPrivate || false,
        hasProfilePic: f.hasProfilePic !== false,
        score: null,
        isFake: null,
        toReview: false,
        approved: false,
        scanned: false,
        removed: false,
        scoreBreakdown: null,
      });
      newCount++;
    }
  }

  await saveFollowers();
  console.log(`[wav] Fetch done: ${collected.length} collected, ${newCount} new`);
}

// ── Scan phase ──────────────────────────────────────────────────────────────

async function runScan(signal) {
  const tab = await getThreadsTab();
  if (!tab) throw new Error("Ouvre threads.net d'abord");

  const pending = state.followers.filter(f => !f.scanned && !f.removed);
  if (!pending.length) return;

  // Phase 1: Pre-score obvious cases
  for (const f of pending) {
    if (signal.aborted) return;
    const { score, details } = preScoreFromMetadata(
      f.username, f.followerCount, f.isPrivate, f.fullName, f.hasProfilePic);

    if (score !== null) {
      f.scanned = true;
      f.score = score;
      f.scoreBreakdown = JSON.stringify(details);
      f.isFake = score >= state.settings.threshold;
      state.stats.scanned++;
      state.stats.preScored++;
      if (f.isFake) state.stats.fakes++;
      broadcastState();
    }
  }

  // Phase 2: Deep scan remaining
  const needsScan = state.followers.filter(f => !f.scanned && !f.removed);
  shuffle(needsScan);
  const pacer = new HumanPacer(8, 15);
  let microBatch = 0;
  const MICRO_BATCH_SIZE = 12;

  for (let i = 0; i < needsScan.length; i++) {
    if (signal.aborted) break;
    const f = needsScan[i];

    // Micro-batch pause
    microBatch++;
    if (microBatch > MICRO_BATCH_SIZE) {
      microBatch = 1;
      const pause = randFloat(120, 200);
      console.log(`[wav] Micro-batch pause: ${Math.round(pause)}s`);
      await sleep(pause * 1000, signal);
      if (signal.aborted) break;
    }

    // Human navigation occasionally
    if (microBatch > 1 && Math.random() < 0.22) {
      await sendToTab(tab.id, { action: "human_navigation" });
      await sleep(randFloat(3, 6) * 1000, signal);
    }

    // Ask content script to extract profile data
    const data = await sendToTab(tab.id, {
      action: "extract_profile",
      username: f.username,
    });

    if (!data || data.error === "429") {
      state.stats.errors++;
      broadcastState();
      break; // Rate limited
    }

    if (data.notFound) {
      state.stats.errors++;
      broadcastState();
      // Pace after error
      await sleep(randFloat(8, 15) * 1000, signal);
      continue;
    }

    // Score
    const { score, details } = scoreProfile(data, state.settings.threshold);
    f.scanned = true;
    f.score = score;
    f.scoreBreakdown = JSON.stringify(details);
    f.followerCount = data.followerCount ?? f.followerCount;
    f.isPrivate = data.isPrivate || f.isPrivate;

    const threshold = state.settings.threshold;
    const margin = 10;
    if (score >= threshold) {
      const hasLegit = data.hasBio || data.hasLinkInBio || data.hasIgLink || data.hasRealPic;
      if (score <= threshold + margin && hasLegit) {
        f.isFake = false;
        f.toReview = true;
      } else {
        f.isFake = true;
        state.stats.fakes++;
      }
    } else {
      f.isFake = false;
    }

    state.stats.scanned++;
    broadcastState();

    // Pace
    if (!signal.aborted && i < needsScan.length - 1) {
      const pause = pacer.nextScanPause();
      await sleep(pause * 1000, signal);
    }
  }

  await saveFollowers();
  console.log(`[wav] Scan done: ${state.stats.scanned} scanned, ${state.stats.fakes} fakes`);
}

// ── Clean phase ─────────────────────────────────────────────────────────────

async function runClean(signal) {
  const tab = await getThreadsTab();
  if (!tab) throw new Error("Ouvre threads.net d'abord");

  const fakes = state.followers.filter(
    f => f.isFake && !f.removed && f.scanned && !f.approved && !f.toReview
  );
  if (!fakes.length) return;

  shuffle(fakes);
  const pacer = new HumanPacer(15, 30);

  for (let i = 0; i < fakes.length; i++) {
    if (signal.aborted) break;

    // Quota check
    if (!quota.canRemove()) {
      console.log("[wav] Daily quota reached");
      break;
    }

    const f = fakes[i];

    const result = await sendToTab(tab.id, {
      action: "remove_follower",
      username: f.username,
    });

    if (!result || result.error) {
      state.stats.errors++;
      broadcastState();
      if (result?.error === "429") break;
      continue;
    }

    f.removed = true;
    state.stats.removed++;
    await quota.recordRemoval();
    broadcastState();

    console.log(`[wav] [${i + 1}/${fakes.length}] @${f.username} removed (${f.score}/100)`);

    // Pace
    if (!signal.aborted && i < fakes.length - 1) {
      const pause = pacer.nextCleanPause();
      await sleep(pause * 1000, signal);
    }
  }

  await saveFollowers();
  console.log(`[wav] Clean done: ${state.stats.removed} removed`);
}

// ── Autopilot ───────────────────────────────────────────────────────────────

async function runAutopilot(signal) {
  let cycle = 0;
  while (!signal.aborted) {
    cycle++;
    console.log(`[wav] Autopilot cycle ${cycle}`);

    // Fetch
    state.phase = "fetching";
    broadcastState();
    await runFetch(signal);
    if (signal.aborted) break;
    await sleep(randFloat(300, 600) * 1000, signal);

    // Scan
    state.phase = "scanning";
    broadcastState();
    await runScan(signal);
    if (signal.aborted) break;
    await sleep(randFloat(600, 900) * 1000, signal);

    // Clean
    state.phase = "cleaning";
    broadcastState();
    await runClean(signal);
    if (signal.aborted) break;

    // Check if done
    const pending = state.followers.filter(f => !f.scanned && !f.removed);
    const fakesLeft = state.followers.filter(
      f => f.isFake && !f.removed && !f.approved && !f.toReview);
    if (!pending.length && !fakesLeft.length) {
      console.log("[wav] Autopilot: all done");
      break;
    }

    await sleep(randFloat(900, 1800) * 1000, signal);
  }
}

// ── Auth handlers ───────────────────────────────────────────────────────────

const API_BASE = "https://api.wavfakecleaner.com";

async function handleLogin(email, password) {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { error: err.detail || "Login failed" };
  }
  const data = await res.json();
  await quota.setToken(data.token);
  await quota.setPlan(data.plan || "free");
  return { ok: true, plan: data.plan };
}

async function handleRegister(email, password, promoConsent) {
  const res = await fetch(`${API_BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, promo_consent: !!promoConsent }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { error: err.detail || "Registration failed" };
  }
  const data = await res.json();
  await quota.setToken(data.token);
  await quota.setPlan("free");
  return { ok: true };
}

async function handleLogout() {
  await quota.setToken(null);
  await quota.setPlan("free");
  return { ok: true };
}

// ── Review handlers ─────────────────────────────────────────────────────────

function approveFollower(username) {
  const f = state.followers.find(f => f.username === username);
  if (!f) return { error: "Not found" };
  f.approved = true;
  f.toReview = false;
  f.isFake = false;
  saveFollowers();
  broadcastState();
  return { ok: true };
}

function rejectFollower(username) {
  const f = state.followers.find(f => f.username === username);
  if (!f) return { error: "Not found" };
  f.approved = false;
  f.toReview = false;
  f.isFake = true;
  saveFollowers();
  broadcastState();
  return { ok: true };
}

// ── Settings ────────────────────────────────────────────────────────────────

async function loadSettings() {
  const stored = await chrome.storage.local.get("wav_settings");
  if (stored.wav_settings) {
    Object.assign(state.settings, stored.wav_settings);
  }
}

async function updateSettings(newSettings) {
  Object.assign(state.settings, newSettings);
  await chrome.storage.local.set({ wav_settings: state.settings });
  return { ok: true };
}

// ── Followers persistence ───────────────────────────────────────────────────

async function loadFollowers() {
  const stored = await chrome.storage.local.get("wav_followers");
  state.followers = stored.wav_followers || [];
}

async function saveFollowers() {
  await chrome.storage.local.set({ wav_followers: state.followers });
}

// ── State broadcasting ──────────────────────────────────────────────────────

function getPublicState() {
  const followers = state.followers;
  return {
    running: state.running,
    phase: state.phase,
    stats: state.stats,
    plan: quota.plan,
    removalsLeft: quota.removalsLeft,
    removalsToday: quota.removalsToday,
    counts: {
      total: followers.length,
      pending: followers.filter(f => !f.scanned && !f.removed).length,
      scanned: followers.filter(f => f.scanned).length,
      fakes: followers.filter(f => f.isFake && !f.removed).length,
      removed: followers.filter(f => f.removed).length,
      toReview: followers.filter(f => f.toReview && !f.removed).length,
      ok: followers.filter(f => f.scanned && !f.isFake && !f.removed && !f.toReview).length,
    },
    settings: state.settings,
  };
}

function getFollowers(filter = "all", limit = 200) {
  let list = state.followers;
  switch (filter) {
    case "pending":  list = list.filter(f => !f.scanned && !f.removed); break;
    case "ok":       list = list.filter(f => f.scanned && !f.isFake && !f.removed && !f.toReview); break;
    case "review":   list = list.filter(f => f.toReview && !f.removed); break;
    case "fake":     list = list.filter(f => f.isFake && !f.removed); break;
    case "removed":  list = list.filter(f => f.removed); break;
  }
  return list.slice(0, limit).map(f => ({
    ...f,
    profileUrl: `https://www.threads.net/@${f.username}`,
  }));
}

function broadcastState() {
  chrome.runtime.sendMessage({ action: "state_update", state: getPublicState() }).catch(() => {});
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function getThreadsTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.threads.net/*" });
  return tabs[0] || null;
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    return { error: e.message };
  }
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function randFloat(min, max) {
  return min + Math.random() * (max - min);
}
