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
import {
  CYCLE_SIZE,
  INTER_CYCLE_PAUSE,
  CONTINUOUS_SESSION_MAX_HOURS,
  CONTINUOUS_LONG_BREAK,
  HARD_429_PAUSE,
} from "@shared/constants";
import { FREE_LIMITS } from "@shared/types";
import { scoreProfile, preScoreFromMetadata } from "./scorer";
import {
  upsertFollowers,
  getFollower,
  updateFollower,
  getFollowersPending,
  getAllFollowerUsernames,
  getSettings,
  savePipelineState,
  getPipelineState,
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
import { submitVote, checkSightings, reportSightings } from "./community";
import { reportTelemetry } from "./telemetry";

// ── Pipeline i18n (service worker has no localStorage, use chrome.storage) ──

let currentLang = "fr";

async function loadLang(): Promise<void> {
  try {
    const result = await chrome.storage.local.get("wav_lang");
    currentLang = result.wav_lang || "fr";
  } catch {
    currentLang = "fr";
  }
}

const MSG: Record<string, Record<string, string>> = {
  no_username:          { fr: "Aucun nom d'utilisateur configuré", en: "No username configured" },
  fetch_start:          { fr: "Récupération de tes followers (@{0})…", en: "Fetching your followers list (@{0})…" },
  fetch_found:          { fr: "{0} followers trouvés, sauvegarde…", en: "{0} followers found, saving…" },
  fetch_done:           { fr: "Terminé : {0} followers récupérés, {1} nouveaux — clique Nettoyer pour les scanner", en: "Done: {0} followers fetched, {1} new — click Clean to analyze them" },
  fetch_error:          { fr: "Erreur récupération : {0}", en: "Fetch error: {0}" },
  fetch_failed:         { fr: "Échec récupération : {0}", en: "Fetch failed: {0}" },
  fetch_retry_fail:     { fr: "Échec après 3 tentatives — canal de messages instable", en: "Fetch failed after 3 retries — message channel keeps closing" },
  msg_channel_err:      { fr: "Erreur canal (tentative {0}/3), réinjection…", en: "Message channel error (attempt {0}/3), re-injecting…" },
  bg_tab_created:       { fr: "Onglet arrière-plan créé (id={0})", en: "Background tab created (id={0})" },
  bg_tab_closed:        { fr: "Onglet arrière-plan fermé", en: "Background tab closed" },
  cs_injected:          { fr: "Script injecté avec succès (onglet {0})", en: "Content script injected successfully on tab {0}" },
  cs_inject_fail:       { fr: "Échec injection script : {0}", en: "Failed to inject content script: {0}" },
  cs_active:            { fr: "Script déjà actif (onglet {0})", en: "Content script already active on tab {0}" },
  threads_tab:          { fr: "Onglet Threads trouvé : id={0}", en: "Found Threads tab: id={0}" },
  send_fail:            { fr: "Envoi message échoué : {0}", en: "sendMessage failed: {0}" },
  scan_not_found:       { fr: "@{0} : INTROUVABLE → score=100 FAKE", en: "@{0}: NOT FOUND → score=100 FAKE" },
  scan_result:          { fr: "@{0} : score={1} {2}", en: "@{0}: score={1} {2}" },
  scan_error:           { fr: "@{0} : {1}", en: "@{0}: {1}" },
  scan_no_data:         { fr: "@{0} : aucune donnée retournée", en: "@{0}: no data returned" },
  scan_done:            { fr: "Analyse terminée : {0} profils analysés, {1} fakes détectés", en: "Analysis complete: {0} profiles analyzed, {1} fakes detected" },
  scan_rate_limit:      { fr: "@{0} : limite 429 (blocages : {1})", en: "@{0}: 429 rate limit (blocked: {1})" },
  scan_tab_lost:        { fr: "@{0} : onglet perdu ({1}), recréation…", en: "@{0}: tab lost ({1}), will recreate…" },
  scan_slowdown:        { fr: "Threads semble nous ralentir. Pause de 5 minutes…", en: "Threads seems to be slowing us down. Pausing for 5 minutes…" },
  rate_limited:         { fr: "Limité — {0}/{1} par heure — pause", en: "Rate limited — {0}/{1} per hour — pausing" },
  auto_stop:            { fr: "Arrêt auto : {0}", en: "Auto-stop: {0}" },
  no_fakes:             { fr: "Aucun faux follower à supprimer.", en: "No fake followers to remove." },
  clean_start:          { fr: "Suppression de {0} faux followers…", en: "Removing {0} fake followers…" },
  clean_removed:        { fr: "@{0} supprimé", en: "@{0} removed" },
  clean_blocked:        { fr: "Threads bloque temporairement les suppressions. Attends 30 minutes.", en: "Threads is temporarily blocking removals. Please wait 30 minutes." },
  clean_wait:           { fr: "Attente 60s avant nouvelle tentative…", en: "Waiting 60s before retrying…" },
  clean_fail:           { fr: "@{0} : échec — {1}", en: "@{0}: failed — {1}" },
  clean_blocked_user:   { fr: "@{0} : bloqué par Threads", en: "@{0}: blocked by Threads" },
  clean_done:           { fr: "Suppression terminée : {0} supprimés{1}", en: "Clean done: {0} removed{1}" },
  clean_stopped:        { fr: " (ARRÊTÉ : blocage Threads détecté)", en: " (STOPPED: Threads blocking detected)" },
  rate_limited_clean:   { fr: "Limité — arrêt suppression", en: "Rate limited — stopping clean" },
  cs_injecting:         { fr: "Script non trouvé sur l'onglet {0}, injection en cours…", en: "Content script not found on tab {0}, injecting dynamically…" },
  tab_recreated:        { fr: "Onglet arrière-plan {0} perdu, recréation…", en: "Background tab {0} lost, recreating…" },
  cycle_start:          { fr: "Nettoyage : {0} profils à traiter…", en: "Cleaning: {0} profiles to process…" },
  cycle_start_wait:     { fr: "Démarrage dans {0}s…", en: "Starting in {0}s…" },
  cycle_visit:          { fr: "@{0} : visite du profil…", en: "@{0}: visiting profile…" },
  cycle_fake_removed:   { fr: "@{0} : score={1} FAKE → supprimé", en: "@{0}: score={1} FAKE → removed" },
  cycle_fake_fail:      { fr: "@{0} : score={1} FAKE → échec suppression ({2})", en: "@{0}: score={1} FAKE → removal failed ({2})" },
  cycle_review:         { fr: "@{0} : score={1} → à vérifier", en: "@{0}: score={1} → to review" },
  cycle_ok:             { fr: "@{0} : score={1} → OK", en: "@{0}: score={1} → OK" },
  cycle_not_found:      { fr: "@{0} : INTROUVABLE → supprimé", en: "@{0}: NOT FOUND → removed" },
  cycle_done:           { fr: "Cycle terminé : {0} vérifiés, {1} supprimés, {2} à vérifier", en: "Cycle done: {0} checked, {1} removed, {2} to review" },
  cycle_limit:          { fr: "Limite quotidienne atteinte (1 cycle/jour). Passe en licence pour le mode continu.", en: "Daily limit reached (1 cycle/day). Upgrade to license for continuous mode." },
  cycle_no_pending:     { fr: "Aucun follower en attente. Lance d'abord une récupération.", en: "No pending followers. Run a fetch first." },
  continuous_start:     { fr: "Mode continu démarré", en: "Continuous mode started" },
  continuous_stop:      { fr: "Mode continu arrêté", en: "Continuous mode stopped" },
  continuous_pause:     { fr: "Pause {0}s avant le prochain cycle…", en: "Pause {0}s before next cycle…" },
  continuous_fetch:     { fr: "Re-récupération des followers…", en: "Re-fetching followers…" },
  cycle_auto_skip:     { fr: "{0} profil(s) résolus automatiquement (pré-score)", en: "{0} profile(s) auto-resolved (pre-score)" },
  cycle_remove_only:   { fr: "{0} profil(s) déjà scorés fake — suppression directe (sans re-scan)", en: "{0} profile(s) already scored fake — removing directly (no re-scan)" },
  scan_channel_lost:   { fr: "@{0} : canal perdu (page Threads crashée ?), re-navigation…", en: "@{0}: channel lost (Threads page crashed?), re-navigating…" },
  threads_error_page:  { fr: "@{0} : page d'erreur Threads — pause {1}s…", en: "@{0}: Threads error page — pausing {1}s…" },
  threads_error_page_skip: { fr: "@{0} : page d'erreur persistante, skip → retry prochain cycle", en: "@{0}: persistent error page, skip → retry next cycle" },
  threads_hard_429:    { fr: "429 massif détecté — pause longue de {0} minutes", en: "Hard 429 detected — long pause of {0} minutes" },
  continuous_session_break: { fr: "Session de {1} cycles — pause obligatoire de {0} min pour éviter le 429", en: "Session of {1} cycles — mandatory {0} min break to avoid 429" },
  continuous_session_resume: { fr: "Reprise après pause obligatoire", en: "Resuming after mandatory break" },
  cycle_remove_retry:  { fr: "@{0} : menu introuvable, retry {1}/2…", en: "@{0}: menu not found, retry {1}/2…" },
  cycle_remove_retry_nav: { fr: "@{0} : re-navigation vers le profil (dernier essai)…", en: "@{0}: re-navigating to profile (last attempt)…" },
  notification_fakes_found: { fr: "Wav Fake Cleaner a detecte {0} faux followers", en: "Wav Fake Cleaner detected {0} fake followers" },
  // User-facing mappings of internal fetch error codes (shown in the side panel)
  err_no_username:           { fr: "Aucun nom d'utilisateur configuré dans les paramètres.", en: "No username configured in settings." },
  err_followers_button:      { fr: "Bouton « Followers » introuvable. Vérifie que tu es connecté(e) et que ton profil est bien public.", en: "“Followers” button not found. Check that you're logged in and your profile is public." },
  err_no_container:          { fr: "Liste des followers non détectée. Recharge la page Threads (Ctrl+Shift+R) et réessaie. Si ça persiste, ferme et rouvre Threads.", en: "Followers list not detected. Reload the Threads page (Ctrl+Shift+R) and try again. If it persists, close and reopen Threads." },
  err_no_container_no_links: { fr: "Threads n'a pas chargé la liste des followers à temps. Recharge la page et réessaie.", en: "Threads didn't load the followers list in time. Reload the page and try again." },
  err_no_container_too_small:{ fr: "Trop peu de followers visibles pour scroller. Réessaie après avoir attendu quelques secondes sur la page.", en: "Too few followers visible to scroll. Wait a few seconds on the page and retry." },
  err_msg_channel:           { fr: "Communication interrompue avec Threads (3 tentatives). Recharge la page et réessaie.", en: "Communication with Threads interrupted (3 retries). Reload the page and try again." },
  err_generic:               { fr: "Erreur inattendue : {0}", en: "Unexpected error: {0}" },
};

/**
 * Map internal fetch error code (and optional reason) to a user-friendly
 * message. Falls back to the raw code if no specific mapping exists.
 */
function fetchErrorToUserMessage(code: string, reason?: string): string {
  switch (code) {
    case "no_username":
      return m("err_no_username");
    case "followers_button_not_found":
      return m("err_followers_button");
    case "scroll_container_not_found":
      if (reason === "no_links") return m("err_no_container_no_links");
      if (reason === "container_too_small") return m("err_no_container_too_small");
      return m("err_no_container");
    case "message_channel_closed":
      return m("err_msg_channel");
    default:
      return m("err_generic", code);
  }
}

function m(key: string, ...args: (string | number)[]): string {
  const tpl = MSG[key]?.[currentLang] || MSG[key]?.fr || key;
  return tpl.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ""));
}

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
  return newCount;
}

export function stopPipeline(): void {
  abortController?.abort();
  abortController = null;
  // Tell the content script to abort its loops too
  if (backgroundTabId !== null) {
    chrome.tabs.sendMessage(backgroundTabId, { type: "STOP_CONTENT" }).catch(() => {});
    chrome.tabs.remove(backgroundTabId).catch(() => {});
    backgroundTabId = null;
  }
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
  // Merge over the existing persisted state so partial updates don't silently
  // clear other fields. (Previously, calling updateState({ stage: "idle" })
  // in a finally{} block was wiping the lastError set by the error branch
  // immediately before it.)
  const current = (await getPipelineState()) || {
    stage: "idle" as const,
    sessionId: null,
    progress: 0,
    total: 0,
    lastError: null,
  };
  const full: PipelineState = { ...current, ...state };
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

// ── Nettoyage quand l'onglet arrière-plan est fermé manuellement ──
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === backgroundTabId) {
    console.log("[WFC] Background tab", tabId, "was closed externally");
    backgroundTabId = null;
  }
});

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
  log("INFO", "pipeline", m("bg_tab_created", backgroundTabId));

  // Wait for initial load
  await waitForTabLoad(backgroundTabId);
  await new Promise((r) => setTimeout(r, 2000));

  return backgroundTabId;
}

async function closeBackgroundTab(): Promise<void> {
  if (backgroundTabId !== null) {
    try {
      await chrome.tabs.remove(backgroundTabId);
      log("INFO", "pipeline", m("bg_tab_closed"));
    } catch {
      // already closed
    }
    backgroundTabId = null;
  }
}

async function waitForTabLoad(tabId: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let abortHandler: (() => void) | null = null;

    function cleanup(): void {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
    }

    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, 15000);

    if (signal) {
      abortHandler = () => {
        cleanup();
        reject(new Error("aborted"));
      };
      signal.addEventListener("abort", abortHandler);
    }

    const listener = (
      updatedTabId: number,
      changeInfo: chrome.tabs.TabChangeInfo
    ) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        cleanup();
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function ensureContentScript(tabId: number): Promise<void> {
  try {
    // PING avec timeout de 3s pour éviter un blocage indéfini
    await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: "PING" }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("PING timeout")), 3000)
      ),
    ]);
    log("INFO", "pipeline", m("cs_active", tabId));
  } catch {
    // Content script not loaded — inject it dynamically
    log("WARNING", "pipeline", m("cs_injecting", tabId));
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
      // Wait for it to initialize
      await new Promise((r) => setTimeout(r, 500));
      log("INFO", "pipeline", m("cs_injected", tabId));
    } catch (injectErr) {
      log("ERROR", "pipeline", m("cs_inject_fail", String(injectErr)));
      throw new Error(`Cannot inject content script: ${injectErr}`);
    }
  }
}

async function sendToContentScript<T>(command: unknown): Promise<T> {
  const tab = await findThreadsTab();
  log("INFO", "pipeline", m("threads_tab", tab.id ?? 0));

  // Ensure content script is loaded (inject if needed)
  await ensureContentScript(tab.id!);

  try {
    const response = await chrome.tabs.sendMessage(tab.id!, command);
    return response as T;
  } catch (err) {
    log("ERROR", "pipeline", m("send_fail", String(err)));
    throw err;
  }
}

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
  // Clear any previous error when starting a fresh run.
  await updateState({ stage: "fetching", lastError: null });

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

    type FetchSuccess = { collected: Record<string, ContentFollowerMeta>; method: string };
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

    // Fallback: if the modal-based scroll container detection failed, retry once
    // on the dedicated /@user/followers page (Threads sometimes routes there
    // instead of opening a modal, and the page-level scroller works reliably).
    if (
      result &&
      "error" in result &&
      result.error === "scroll_container_not_found" &&
      !signal.aborted
    ) {
      const followersUrl = `https://www.threads.com/@${encodeURIComponent(username)}/followers`;
      log("WARNING", "pipeline", `scroll_container_not_found (reason=${result.reason ?? "unknown"}, links=${result.linksFound ?? 0}) — retrying on dedicated /followers page`);
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

async function runCleanCycleInternal(signal: AbortSignal): Promise<number> {
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
  // Clear any previous error when starting a fresh cycle.
  await updateState({ stage: "cleaning", total: pending.length, progress: 0, lastError: null });

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

  // Track cycle for free tier AVANT le cycle — un crash mid-cycle compte quand même
  if (!licence.active) {
    await incrementDailyUsage("cycles");
  }

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
      needsRemoveOnly.push(follower);
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
      needsRemoveOnly.push({ ...follower, ...updates });
      cycleSightings.add(follower.username);
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
  if (needsRemoveOnly.length > 0) {
    log("INFO", "clean", m("cycle_remove_only", needsRemoveOnly.length));

    // Need a tab for removals
    let rmTabId = await getOrCreateBackgroundTab();
    for (const follower of needsRemoveOnly) {
      if (signal.aborted) break;

      const profileUrl = `https://www.threads.com/@${encodeURIComponent(follower.username)}`;
      log("INFO", "clean", m("cycle_visit", follower.username));

      await chrome.tabs.update(rmTabId, { url: profileUrl });
      await waitForTabLoad(rmTabId, signal);
      await sleep(8 + Math.random() * 12, signal);
      await ensureContentScript(rmTabId);

      // Check for error page
      const pageCheck = await chrome.tabs.sendMessage(rmTabId, { type: "CHECK_PAGE" }) as
        { ok: boolean; errorPage: boolean } | null;
      if (pageCheck?.errorPage && !pageCheck.ok) {
        log("WARNING", "clean", m("threads_error_page_skip", follower.username));
        continue;
      }

      const removeResult = await chrome.tabs.sendMessage(rmTabId, {
        type: "REMOVE_FOLLOWER",
        payload: { username: follower.username },
      }) as { success: boolean; action: string; error?: string; blocked?: boolean };

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
        backgroundTabId = null;
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
      await sleep(300, signal).catch(() => {});
      consecutiveBlocked = 0;
      if (signal.aborted) break;
    }

    try {
      const currentTabId = await ensureTab();
      const profileUrl = `https://www.threads.com/@${encodeURIComponent(follower.username)}`;
      log("INFO", "clean", m("cycle_visit", follower.username));

      // 1. Navigate to profile
      await chrome.tabs.update(currentTabId, { url: profileUrl });
      await waitForTabLoad(currentTabId, signal);
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
            await sleep(hardPause, signal);
            if (signal.aborted) break;
            consecutiveErrorPages = 0;
            // Recreate tab and retry this follower
            tabId = null;
            backgroundTabId = null;
            const freshTabId = await ensureTab();
            await chrome.tabs.update(freshTabId, { url: profileUrl });
            await waitForTabLoad(freshTabId, signal);
            await sleep(10 + Math.random() * 10, signal);
            await ensureContentScript(freshTabId);
          } else {
            // 1-2 error pages → shorter pause, escalating
            const cooldown = consecutiveErrorPages * 120; // 2min, 4min
            log("WARNING", "clean", m("threads_error_page", follower.username, cooldown));
            await sleep(cooldown, signal);
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
      const rawProfileData = await chrome.tabs.sendMessage(currentTabId, {
        type: "SCAN_PROFILE",
        payload: { username: follower.username },
      });

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
        await updateFollower(follower.username, {
          score: 100,
          scoreBreakdown: JSON.stringify(["not_found"]),
          isFake: true,
          scanned: true,
          removed: true,
          status: "removed",
          scannedAt: Date.now(),
          removedAt: Date.now(),
        });
        scanned++;
        removed++;
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
          // FAKE — remove immediately
          await updateFollower(follower.username, {
            score, scoreBreakdown: JSON.stringify(scored.breakdown),
            isFake: true, scanned: true, status: "fake", scannedAt: Date.now(),
            followersCount: profileData.followerCount ?? follower.followersCount,
            fullName: profileData.fullName || follower.fullName,
            isPrivate: profileData.isPrivate ?? follower.isPrivate,
            isVerified: profileData.isVerified ?? follower.isVerified,
          });

          // Simule la réflexion humaine avant de cliquer supprimer (3-8s)
          await sleep(3 + Math.random() * 5, signal);

          // Retry logic for REMOVE_FOLLOWER: menu_not_found is often a timing issue
          // (page not fully rendered after SCAN_PROFILE tab navigation).
          // Retry once on same page, then re-navigate as last resort.
          let removeResult: { success: boolean; action: string; error?: string; blocked?: boolean } | null = null;

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
            }) as typeof removeResult;

            if (removeResult!.success || removeResult!.error !== "menu_not_found") {
              break; // Success or non-retryable error
            }

            if (removeAttempt < 2) {
              log("WARNING", "clean", m("cycle_remove_retry", follower.username, removeAttempt + 1));
            }
          }

          if (removeResult!.success) {
            await updateFollower(follower.username, {
              removed: true, status: "removed", removedAt: Date.now(),
            });
            removed++;
            log("INFO", "clean", m("cycle_fake_removed", follower.username, score));
            await addActionLog({
              actionType: "remove", target: follower.username,
              status: "ok", errorDetail: null, durationMs: null, createdAt: Date.now(),
            });
          } else {
            if (removeResult!.blocked || removeResult!.error === "threads_blocked") {
              consecutiveBlocked++;
              log("WARNING", "clean", m("clean_blocked_user", follower.username));
            } else {
              log("WARNING", "clean", m("cycle_fake_fail", follower.username, score, removeResult!.error ?? ""));
            }
            await addActionLog({
              actionType: "remove", target: follower.username,
              status: removeResult!.blocked ? "error_429" : "error_other",
              errorDetail: removeResult!.error || null, durationMs: null, createdAt: Date.now(),
            });
          }
          scanned++;
        } else if (scored.toReview) {
          // TO REVIEW
          await updateFollower(follower.username, {
            score, scoreBreakdown: JSON.stringify(scored.breakdown),
            isFake: false, toReview: true, scanned: true, status: "scanned", scannedAt: Date.now(),
            followersCount: profileData.followerCount ?? follower.followersCount,
            fullName: profileData.fullName || follower.fullName,
            isPrivate: profileData.isPrivate ?? follower.isPrivate,
            isVerified: profileData.isVerified ?? follower.isVerified,
          });
          scanned++;
          reviewed++;
          log("INFO", "clean", m("cycle_review", follower.username, score));
        } else {
          // OK
          await updateFollower(follower.username, {
            score, scoreBreakdown: JSON.stringify(scored.breakdown),
            isFake: false, toReview: false, scanned: true, status: "scanned", scannedAt: Date.now(),
            followersCount: profileData.followerCount ?? follower.followersCount,
            fullName: profileData.fullName || follower.fullName,
            isPrivate: profileData.isPrivate ?? follower.isPrivate,
            isVerified: profileData.isVerified ?? follower.isVerified,
          });
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

      if (errMsg.includes("No tab with id") || errMsg.includes("Cannot inject")) {
        // Tab was closed externally
        log("WARNING", "clean", m("scan_tab_lost", follower.username, errMsg));
        tabId = null;
        backgroundTabId = null;
        await updateFollower(follower.username, { scanError: "tab_lost", status: "pending" });
      } else if (
        errMsg.includes("message channel closed") ||
        errMsg.includes("Receiving end does not exist") ||
        errMsg.includes("Could not establish connection") ||
        errMsg.includes("listener indicated an asynchronous response")
      ) {
        // Content script died mid-operation (Threads error page, navigation, reload).
        // The tab still exists but the content script context is gone.
        // Re-navigate, re-inject, and leave this follower as pending for retry.
        log("WARNING", "clean", m("scan_channel_lost", follower.username));
        try {
          const tid = tabId ?? backgroundTabId;
          if (tid !== null) {
            await chrome.tabs.update(tid, { url: `https://www.threads.com/@${encodeURIComponent(follower.username)}` });
            await waitForTabLoad(tid, signal);
            await sleep(3, signal);
            await ensureContentScript(tid);
          }
        } catch {
          // Tab might be gone too — will be recreated on next iteration
          tabId = null;
          backgroundTabId = null;
        }
        await updateFollower(follower.username, { scanError: "channel_lost", status: "pending" });
      } else {
        consecutiveBlocked++;
        await rateTracker.recordError();
        log("ERROR", "clean", m("scan_error", follower.username, errMsg));
      }
      await sleep(2, signal).catch(() => {});
    }
  }

  await updateScanSession(sessionId, {
    status: signal.aborted ? "stopped" : "completed",
    scannedCount: scanned,
    fakeCount: removed,
    removedCount: removed,
    finishedAt: Date.now(),
  });

  log("INFO", "clean", m("cycle_done", scanned, removed, reviewed));

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
          await sleep(breakDuration, signal);
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
        const remaining = await getFollowersPending(1);
        if (remaining.length === 0) {
          // No more pending — re-fetch then continue
          log("INFO", "pipeline", m("continuous_fetch"));
          await runFetchInternal(signal);
          if (signal.aborted) break;
        }

        // ── Adaptive inter-cycle pause: longer as the session ages ──
        const ageFactor = 1 + sessionHours * 0.15; // +15% per hour
        const basePause = randomBetween(...INTER_CYCLE_PAUSE);
        const pause = basePause * ageFactor;
        log("INFO", "pipeline", m("continuous_pause", Math.round(pause)));
        await sleep(pause, signal);
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

// ── Exports for service worker ──

export { isRunning, rateTracker };
