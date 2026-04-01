/**
 * Keepalive — manages offscreen document to keep service worker alive
 * during long-running operations.
 */

let active = false;

export async function startKeepAlive(): Promise<void> {
  if (active) return;
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification: "Keep service worker alive during scan/clean operations",
    });
    active = true;
  } catch {
    // Document may already exist
    active = true;
  }
}

export async function stopKeepAlive(): Promise<void> {
  if (!active) return;
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // ignore
  }
  active = false;
}
