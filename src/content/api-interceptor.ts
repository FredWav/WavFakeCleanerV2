/**
 * API Interceptor — makes Threads API calls via the MAIN world bridge.
 *
 * The ISOLATED world content script can't use the page's auth context directly.
 * All API calls are routed through main-world-bridge.ts which runs in the page's
 * JavaScript context and has access to the full session/cookies/headers.
 */

import { THREADS_API, DEFAULT_PIC_PATTERNS } from "@shared/constants";
import type { ContentFollowerMeta } from "@shared/messages";

// ── MAIN world bridge communication ──

const WFC_REQUEST = "WFC_API_REQUEST";
const WFC_RESPONSE = "WFC_API_RESPONSE";

let requestId = 0;
const pendingRequests = new Map<number, {
  resolve: (value: { status: number; body: unknown }) => void;
  reject: (reason: Error) => void;
}>();

// Listen for responses from MAIN world
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== WFC_RESPONSE) return;

  const { id, status, body, error } = event.data;
  const pending = pendingRequests.get(id);
  if (!pending) return;

  pendingRequests.delete(id);
  if (error) {
    pending.reject(new Error(error));
  } else {
    pending.resolve({ status, body });
  }
});

async function mainWorldFetch(url: string, headers?: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const id = ++requestId;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error("Main world fetch timeout (15s)"));
    }, 15000);

    pendingRequests.set(id, {
      resolve: (val) => { clearTimeout(timeout); resolve(val); },
      reject: (err) => { clearTimeout(timeout); reject(err); },
    });

    window.postMessage({ type: WFC_REQUEST, id, url, headers }, "*");
  });
}

// ── Inject MAIN world bridge script ──

export function injectMainWorldBridge(): void {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("main-world-bridge.js");
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();
  console.log("[WFC] Injecting main world bridge script");
}

// ── Helpers ──

function isDefaultPic(url: string): boolean {
  if (!url) return true;
  return DEFAULT_PIC_PATTERNS.some((p) => url.includes(p));
}

function extractFollowerMeta(u: Record<string, unknown>): ContentFollowerMeta {
  return {
    followerCount: (u.follower_count as number) ?? null,
    followingCount: (u.following_count as number) ?? null,
    isVerified: !!u.is_verified,
    fullName: ((u.full_name as string) || "").trim(),
    isPrivate: !!u.is_private,
    hasProfilePic: !isDefaultPic((u.profile_pic_url as string) || ""),
    biography: ((u.biography as string) || "").trim(),
    bioLinks: ((u.bio_links as Array<{ url?: string }>) || []).map((l) => l.url || ""),
    externalUrl: ((u.external_url as string) || "").trim(),
  };
}

// ── API calls (routed through MAIN world) ──

function apiHeaders(): Record<string, string> {
  // The MAIN-world bridge enriches with X-CSRFToken, X-FB-LSD, X-ASBD-ID,
  // X-IG-WWW-Claim and Accept-Language (which need page context).
  return {
    "X-IG-App-ID": THREADS_API.appId,
    "Accept": "*/*",
  };
}

// ── Exponential backoff for transient API errors ──
// Threads serves 429 sporadically; instead of retrying immediately (which gets
// us flagged as a bot), we wait with exponentially-growing jitter.
async function fetchWithBackoff(
  url: string,
  headers: Record<string, string>,
  maxAttempts = 4,
): Promise<{ status: number; body: unknown; gaveUp: boolean }> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { status, body } = await mainWorldFetch(url, headers);

    if (status !== 429) {
      return { status, body, gaveUp: false };
    }

    // Honour Retry-After if the body carries it; otherwise exponential backoff
    let waitMs = 30_000 * Math.pow(2, attempt) + Math.random() * 5_000;
    if (body && typeof body === "object") {
      const retryAfter = (body as Record<string, unknown>).retry_after_seconds;
      if (typeof retryAfter === "number" && retryAfter > 0 && retryAfter < 1800) {
        waitMs = retryAfter * 1000 + Math.random() * 5_000;
      }
    }
    waitMs = Math.min(waitMs, 30 * 60 * 1000); // cap at 30 min

    console.log(`[WFC] 429 received (attempt ${attempt + 1}/${maxAttempts}), waiting ${Math.round(waitMs / 1000)}s before retry`);
    await new Promise((r) => setTimeout(r, waitMs));
  }

  return { status: 429, body: null, gaveUp: true };
}

export async function resolveUserId(username: string): Promise<string | null> {
  const headers = apiHeaders();

  const endpoints = [
    `${THREADS_API.profileEndpoint}?username=${username}`,
    `${THREADS_API.searchEndpoint}?q=${username}`,
  ];

  for (const url of endpoints) {
    try {
      console.log("[WFC] resolveUserId: trying (MAIN world)", url);
      const { status, body } = await mainWorldFetch(url, headers);
      console.log("[WFC] resolveUserId: status", status, "for", url);

      if (status !== 200) {
        console.log("[WFC] resolveUserId: non-200, body =", JSON.stringify(body).substring(0, 300));
        continue;
      }

      const j = body as Record<string, unknown>;
      console.log("[WFC] resolveUserId: response keys =", Object.keys(j));

      const uid =
        (j?.data as Record<string, unknown>)?.user &&
        ((j.data as Record<string, unknown>).user as Record<string, unknown>)?.id ||
        (j?.data as Record<string, unknown>)?.user &&
        ((j.data as Record<string, unknown>).user as Record<string, unknown>)?.pk ||
        (j?.user as Record<string, unknown>)?.pk ||
        (j?.user as Record<string, unknown>)?.id ||
        (j?.data as Record<string, unknown>)?.user &&
        ((j.data as Record<string, unknown>).user as Record<string, unknown>)?.pk_id;

      if (uid) {
        console.log("[WFC] resolveUserId: found uid =", uid);
        return String(uid);
      }

      const users = (j?.users as Array<Record<string, unknown>>) || [];
      const match = users.find((u) => u.username === username);
      if (match) {
        console.log("[WFC] resolveUserId: found via search =", match.pk || match.id);
        return String(match.pk || match.id);
      }

      console.log("[WFC] resolveUserId: no uid in response =", JSON.stringify(j).substring(0, 500));
    } catch (e) {
      console.log("[WFC] resolveUserId: error for", url, e);
    }
  }

  // Fallback: check page scripts for embedded data
  try {
    const scripts = document.querySelectorAll('script[type="application/json"]');
    console.log("[WFC] resolveUserId: checking", scripts.length, "script tags");
    for (const s of scripts) {
      const text = s.textContent || "";
      if (text.includes(username)) {
        const pkM = text.match(/"pk":"?(\d+)"?/);
        if (pkM) {
          console.log("[WFC] resolveUserId: found pk in script tag:", pkM[1]);
          return pkM[1];
        }
        const idM = text.match(/"user_id":"?(\d+)"?/);
        if (idM) return idM[1];
      }
    }
  } catch {
    // ignore
  }

  console.log("[WFC] resolveUserId: FAILED for", username);
  return null;
}

export async function fetchFollowersPage(
  userId: string,
  maxId?: string
): Promise<{ users: Record<string, ContentFollowerMeta>; nextMaxId: string | null } | null> {
  const headers = apiHeaders();
  let url = THREADS_API.followersEndpoint.replace("{user_id}", userId);
  url += `?count=${THREADS_API.pageSize}&search_surface=follow_list_page`;
  if (maxId) url += `&max_id=${maxId}`;

  try {
    console.log("[WFC] fetchFollowersPage:", url);
    const { status, body, gaveUp } = await fetchWithBackoff(url, headers);
    console.log("[WFC] fetchFollowersPage: status", status, gaveUp ? "(backoff exhausted)" : "");

    if (status === 429) return null;
    if (status !== 200) return null;

    const data = body as Record<string, unknown>;
    const rawUsers = (data.users as Array<Record<string, unknown>>) || [];
    const users: Record<string, ContentFollowerMeta> = {};

    for (const u of rawUsers) {
      const pseudo = ((u.username as string) || "").trim();
      if (pseudo) {
        users[pseudo] = extractFollowerMeta(u);
      }
    }

    console.log("[WFC] fetchFollowersPage: got", Object.keys(users).length, "users");

    return {
      users,
      nextMaxId: (data.next_max_id as string) || null,
    };
  } catch (e) {
    console.log("[WFC] fetchFollowersPage: error", e);
    return null;
  }
}

