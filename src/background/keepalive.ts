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
  } catch (e) {
    // "Only a single offscreen document may be created" = déjà existant = OK
    if (String(e).includes("single offscreen") || String(e).includes("already")) {
      active = true;
    } else {
      // Vrai échec — ne pas mettre active=true, on réessaiera au prochain appel
      console.error("[WFC] Keepalive creation failed:", e);
    }
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
