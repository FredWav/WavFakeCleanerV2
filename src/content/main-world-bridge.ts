/**
 * MAIN world bridge — runs in the page's JavaScript context.
 * Makes API calls with the page's full auth headers/cookies/session.
 * Communicates with the ISOLATED world content script via window.postMessage.
 *
 * Defense-in-depth (v2.1):
 *   - Per-instance shared secret read from the script element's dataset at
 *     load time. Responses include the secret so foreign scripts on the
 *     page can't impersonate the bridge or read its responses.
 *   - URL allowlist: only Threads API endpoints (and the resolution helpers)
 *     are honored. Arbitrary URLs are rejected to prevent the bridge from
 *     becoming an open SSRF for malicious code in the isolated world.
 */

import { isAllowedApiUrl } from "../shared/api-allowlist";

const WFC_REQUEST = "WFC_API_REQUEST";
const WFC_RESPONSE = "WFC_API_RESPONSE";

// Read the per-instance secret synchronously at script init.
// document.currentScript is non-null only during top-level synchronous
// execution; capturing it once in closure is the simplest reliable handoff
// from the isolated world that doesn't expose the secret to the page.
const WFC_SECRET = (() => {
  const cs = document.currentScript;
  if (cs instanceof HTMLScriptElement) {
    return cs.dataset.wfcSecret || null;
  }
  return null;
})();

// Only Threads API endpoints are allowed (absolute or same-origin relative).
// Anything else is rejected so the bridge can never be coerced into fetching
// attacker-controlled URLs with the user's auth cookies attached. The matcher
// lives in @shared/api-allowlist so a regression test can assert the URLs the
// interceptor actually builds pass it.

// ── Lazy header enrichment (auth tokens visible only from MAIN world) ──

let cachedLsd: string | null = null;
let cachedWwwClaim: string | null = null;

function readCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : null;
}

function findLsdToken(): string | null {
  if (cachedLsd) return cachedLsd;

  // 1) <input name="lsd"> hidden field, present on most Threads pages
  const input = document.querySelector('input[name="lsd"]') as HTMLInputElement | null;
  if (input?.value) { cachedLsd = input.value; return cachedLsd; }

  // 2) Embedded in inline scripts: "LSD",[],{"token":"<value>"
  const scripts = document.querySelectorAll("script");
  for (const s of scripts) {
    const txt = s.textContent || "";
    const m = txt.match(/"LSD",\[\],\{"token":"([^"]+)"/);
    if (m) { cachedLsd = m[1]; return cachedLsd; }
  }

  // 3) requireLazy fallback (legacy FB/IG bootstrap)
  try {
    const w = window as unknown as { requireLazy?: (mods: string[], cb: (lsd: { token?: string }) => void) => void };
    if (typeof w.requireLazy === "function") {
      let token: string | null = null;
      w.requireLazy(["LSD"], (LSD) => { token = LSD?.token ?? null; });
      if (token) { cachedLsd = token; return cachedLsd; }
    }
  } catch { /* ignore */ }

  return null;
}

function findWwwClaim(): string | null {
  if (cachedWwwClaim) return cachedWwwClaim;

  // 1) Inline script: "rolloutHash":"...","claim":"hmac.<value>"
  try {
    const scripts = document.querySelectorAll("script");
    for (const s of scripts) {
      const txt = s.textContent || "";
      const m = txt.match(/"X-IG-WWW-Claim":"(hmac\.[^"]+)"/);
      if (m) { cachedWwwClaim = m[1]; return cachedWwwClaim; }
    }
  } catch { /* ignore */ }

  return null;
}

function enrichHeaders(base: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...base };

  // CSRF token (always available once user is logged in)
  if (!out["X-CSRFToken"]) {
    const csrf = readCookie("csrftoken");
    if (csrf) out["X-CSRFToken"] = csrf;
  }

  // LSD anti-CSRF token (Meta-specific, present on every authentic request)
  if (!out["X-FB-LSD"]) {
    const lsd = findLsdToken();
    if (lsd) out["X-FB-LSD"] = lsd;
  }

  // WWW-Claim (session HMAC, optional but enriches the fingerprint)
  if (!out["X-IG-WWW-Claim"]) {
    const claim = findWwwClaim();
    if (claim) out["X-IG-WWW-Claim"] = claim;
  }

  // ASBD-ID is a constant Meta uses to identify a build cohort
  if (!out["X-ASBD-ID"]) out["X-ASBD-ID"] = "129477";

  // Accept-Language reflects the browser's preference
  if (!out["Accept-Language"]) out["Accept-Language"] = navigator.language || "en-US";

  // Drop the dead-giveaway header — real Threads requests don't send it explicitly
  delete out["X-Requested-With"];

  return out;
}

// ── Bridge listener ──

window.addEventListener("message", async (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== WFC_REQUEST) return;

  // Reject messages that don't carry the matching secret. Without this
  // check, any script on the page can submit requests through the bridge
  // and read the responses (which contain the user's session-scoped data).
  if (!WFC_SECRET || event.data.secret !== WFC_SECRET) return;

  const { id, url, headers } = event.data;

  // URL allowlist: refuse non-Threads-API URLs outright.
  if (!isAllowedApiUrl(url)) {
    // Surface this — a silently-rejected URL is exactly how the API fast-path
    // died unnoticed once before (relative URLs vs an https-only allowlist).
    console.warn("[WFC] bridge: url_not_allowed", url);
    window.postMessage(
      { type: WFC_RESPONSE, id, status: 0, body: null, error: "url_not_allowed", secret: WFC_SECRET },
      "*",
    );
    return;
  }

  try {
    const enriched = enrichHeaders(headers || {});
    const response = await fetch(url, {
      credentials: "include",
      headers: enriched,
      // Hint Chrome to add Sec-Fetch-Site/Mode/Dest naturally
      mode: "cors",
      referrer: window.location.href,
    });

    const status = response.status;
    let body: unknown = null;

    try {
      body = await response.json();
    } catch {
      body = await response.text().catch(() => null);
    }

    window.postMessage(
      { type: WFC_RESPONSE, id, status, body, error: null, secret: WFC_SECRET },
      "*",
    );
  } catch (e) {
    window.postMessage(
      { type: WFC_RESPONSE, id, status: 0, body: null, error: String(e), secret: WFC_SECRET },
      "*",
    );
  }
});

console.log("[WFC] Main world bridge loaded");
