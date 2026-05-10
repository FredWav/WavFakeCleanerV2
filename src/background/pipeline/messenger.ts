/**
 * Messenger — wraps chrome.tabs.sendMessage with content-script injection.
 *
 * Every pipeline call site previously open-coded the same logic: PING the
 * tab, fall back to chrome.scripting.executeScript on timeout, then send the
 * actual command. This module dedupes that.
 */

import { log } from "./state";
import { m } from "./i18n";
import { findThreadsTab } from "./tab-manager";

const PING_TIMEOUT_MS = 3000;
const POST_INJECT_SETTLE_MS = 500;

/**
 * Verify a content script is alive on the tab; inject it dynamically if not.
 *
 * Throws when injection fails (e.g. tab navigated to a non-Threads URL or
 * was closed mid-operation). Callers handle the error to recreate the tab.
 */
export async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: "PING" }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("PING timeout")), PING_TIMEOUT_MS),
      ),
    ]);
    log("INFO", "pipeline", m("cs_active", tabId));
  } catch {
    log("WARNING", "pipeline", m("cs_injecting", tabId));
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
      await new Promise((r) => setTimeout(r, POST_INJECT_SETTLE_MS));
      log("INFO", "pipeline", m("cs_injected", tabId));
    } catch (injectErr) {
      log("ERROR", "pipeline", m("cs_inject_fail", String(injectErr)));
      throw new Error(`Cannot inject content script: ${injectErr}`);
    }
  }
}

/**
 * Find any open Threads tab, ensure content script is alive, send command.
 *
 * Used by the fetch path before a dedicated background tab exists. Any other
 * call should target a known tabId via chrome.tabs.sendMessage directly.
 */
export async function sendToContentScript<T>(command: unknown): Promise<T> {
  const tab = await findThreadsTab();
  log("INFO", "pipeline", m("threads_tab", tab.id ?? 0));

  await ensureContentScript(tab.id!);

  try {
    const response = await chrome.tabs.sendMessage(tab.id!, command);
    return response as T;
  } catch (err) {
    log("ERROR", "pipeline", m("send_fail", String(err)));
    throw err;
  }
}

/**
 * Common discriminator for "the content script context is gone" errors.
 * Used by the orchestrator to decide whether to re-navigate vs. recreate.
 */
export function isChannelLostError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("message channel closed") ||
    msg.includes("Receiving end does not exist") ||
    msg.includes("Could not establish connection") ||
    msg.includes("listener indicated an asynchronous response")
  );
}

/**
 * Common discriminator for "the tab itself is gone" errors.
 */
export function isTabGoneError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("No tab with id") || msg.includes("Cannot inject");
}
