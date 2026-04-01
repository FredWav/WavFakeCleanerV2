/**
 * MAIN world bridge — runs in the page's JavaScript context.
 * Makes API calls with the page's full auth headers/cookies/session.
 * Communicates with the ISOLATED world content script via window.postMessage.
 */

const WFC_REQUEST = "WFC_API_REQUEST";
const WFC_RESPONSE = "WFC_API_RESPONSE";

window.addEventListener("message", async (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== WFC_REQUEST) return;

  const { id, url, headers } = event.data;

  try {
    const response = await fetch(url, {
      credentials: "include",
      headers: headers || {},
    });

    const status = response.status;
    let body: unknown = null;

    try {
      body = await response.json();
    } catch {
      body = await response.text().catch(() => null);
    }

    window.postMessage({ type: WFC_RESPONSE, id, status, body, error: null }, "*");
  } catch (e) {
    window.postMessage({ type: WFC_RESPONSE, id, status: 0, body: null, error: String(e) }, "*");
  }
});

console.log("[WFC] Main world bridge loaded");
