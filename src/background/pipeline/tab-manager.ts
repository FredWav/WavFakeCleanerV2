/**
 * Tab manager — owns the lifecycle of the background tab used for scraping.
 *
 * The background tab is a hidden Threads tab (active: false) that the pipeline
 * uses to navigate profiles without disturbing the user's main browsing.
 *
 * State persistence (v2.1):
 *   The tab ID is mirrored to chrome.storage.session so it survives service
 *   worker restarts within the same browser session. The in-memory cache is
 *   the synchronous source of truth; restoreSessionState() seeds it at SW
 *   boot. Browser restart clears storage.session entirely — that's the
 *   intentional boundary.
 */

import { TAB } from "./timings";
import { log } from "./state";
import { m } from "./i18n";

const SESSION_KEY = "wfc_bg_tab_id";

let backgroundTabId: number | null = null;

// Persist the in-memory ID. Fire-and-forget; session storage is best-effort.
function persistSession(): void {
  try {
    void chrome.storage.session.set({ [SESSION_KEY]: backgroundTabId });
  } catch {
    // session storage unavailable in this environment
  }
}

// Auto-clear the cached ID when the user closes the tab manually.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === backgroundTabId) {
    console.log("[WFC] Background tab", tabId, "was closed externally");
    backgroundTabId = null;
    persistSession();
  }
});

export function getBackgroundTabId(): number | null {
  return backgroundTabId;
}

/**
 * Force-reset the cached ID. Used when the orchestrator detects the tab is
 * dead (e.g. "No tab with id" thrown from chrome.tabs.update).
 */
export function clearBackgroundTabId(): void {
  backgroundTabId = null;
  persistSession();
}

/**
 * Seed the in-memory cache from chrome.storage.session at service-worker
 * boot. Called once from the service-worker entry point.
 *
 * If the persisted tab no longer exists, the cache is cleared and storage
 * is wiped — preventing stale IDs from causing duplicate-tab creation on
 * subsequent operations.
 */
export async function restoreSessionState(): Promise<void> {
  try {
    const result = await chrome.storage.session.get(SESSION_KEY);
    const cached = result[SESSION_KEY];
    if (typeof cached !== "number") return;

    try {
      await chrome.tabs.get(cached);
      backgroundTabId = cached;
      console.log("[WFC] Recovered background tab:", cached);
    } catch {
      // tab was closed while SW was suspended — clear stale state
      await chrome.storage.session.remove(SESSION_KEY);
    }
  } catch {
    // chrome.storage.session unavailable (older Chrome) — fall back to fresh state
  }
}

export async function getOrCreateBackgroundTab(): Promise<number> {
  // Reuse existing background tab if still open
  if (backgroundTabId !== null) {
    try {
      const tab = await chrome.tabs.get(backgroundTabId);
      if (tab) return backgroundTabId;
    } catch {
      backgroundTabId = null;
      persistSession();
    }
  }

  // Create a new background tab (active: false = doesn't steal focus)
  const tab = await chrome.tabs.create({
    url: "https://www.threads.com/",
    active: false,
  });

  backgroundTabId = tab.id!;
  persistSession();
  log("INFO", "pipeline", m("bg_tab_created", backgroundTabId));

  // Wait for initial load
  await waitForTabLoad(backgroundTabId);
  await new Promise((r) => setTimeout(r, TAB.postNavSettleMs));

  return backgroundTabId;
}

export async function closeBackgroundTab(): Promise<void> {
  if (backgroundTabId !== null) {
    try {
      await chrome.tabs.remove(backgroundTabId);
      log("INFO", "pipeline", m("bg_tab_closed"));
    } catch {
      // already closed
    }
    backgroundTabId = null;
    persistSession();
  }
}

/**
 * Wait until chrome.tabs reports `status === "complete"` for the given tab,
 * with a hard timeout so a stuck navigation never blocks the pipeline forever.
 *
 * Renvoie `true` si la page a vraiment atteint l'état "complete", `false` si le
 * timeout a expiré sans confirmation (B-H6). Avant, le timeout résolvait
 * silencieusement comme un succès : l'appelant scannait alors une page à
 * demi-chargée (DOM vide → 0 post → faux positif, cf B-C1). Les appelants qui
 * ignorent la valeur de retour continuent de fonctionner.
 *
 * If signal is provided, aborting it rejects the promise.
 */
export async function waitForTabLoad(tabId: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let abortHandler: (() => void) | null = null;

    function cleanup(): void {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
    }

    const timeout = setTimeout(() => {
      cleanup();
      resolve(false); // timeout : page PAS confirmée chargée
    }, TAB.loadTimeoutMs);

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
        resolve(true);
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * Locate any open Threads tab the user has — used as a fallback when we
 * don't yet have a dedicated background tab.
 */
export async function findThreadsTab(): Promise<chrome.tabs.Tab> {
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

/**
 * Tell whichever content scripts are loaded to abort their loops, and
 * remove the background tab. Used on stopPipeline() and tab teardown.
 */
export async function tearDownBackgroundTab(): Promise<void> {
  if (backgroundTabId !== null) {
    try {
      await chrome.tabs.sendMessage(backgroundTabId, { type: "STOP_CONTENT" });
    } catch {
      // content script may already be gone
    }
    try {
      await chrome.tabs.remove(backgroundTabId);
    } catch {
      // already closed
    }
    backgroundTabId = null;
    persistSession();
  }
}
