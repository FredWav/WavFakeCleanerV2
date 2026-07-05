/**
 * API Interceptor — makes Threads API calls via the MAIN world bridge.
 *
 * The ISOLATED world content script can't use the page's auth context directly.
 * All API calls are routed through main-world-bridge.ts which runs in the page's
 * JavaScript context and has access to the full session/cookies/headers.
 */

import { THREADS_API, DEFAULT_PIC_PATTERNS } from "@shared/constants";
import type { ContentFollowerMeta } from "@shared/messages";
import { dbg } from "./debug";

// ── MAIN world bridge communication ──

const WFC_REQUEST = "WFC_API_REQUEST";
const WFC_RESPONSE = "WFC_API_RESPONSE";

// Per-instance shared secret. Generated once at module load, embedded in
// the bridge script's dataset before injection, and validated on every
// inbound response. Stops other scripts on the page from impersonating the
// bridge or reading our responses (defense-in-depth — the page can already
// see the data, but the bridge shouldn't make it trivially exfiltratable).
const WFC_SECRET = crypto.randomUUID();

let requestId = 0;
const pendingRequests = new Map<number, {
  resolve: (value: { status: number; body: unknown }) => void;
  reject: (reason: Error) => void;
}>();

// Listen for responses from MAIN world
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== WFC_RESPONSE) return;
  // Reject responses lacking the secret — prevents foreign scripts from
  // satisfying our pending requests with attacker-controlled bodies.
  if (event.data.secret !== WFC_SECRET) return;

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

    window.postMessage(
      { type: WFC_REQUEST, id, url, headers, secret: WFC_SECRET },
      "*",
    );
  });
}

// ── Inject MAIN world bridge script ──

export function injectMainWorldBridge(): void {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("main-world-bridge.js");
  // Hand the per-instance secret to the bridge before it executes. The
  // bridge reads document.currentScript.dataset.wfcSecret synchronously at
  // script init; isolated-world dataset writes are not visible to the page.
  script.dataset.wfcSecret = WFC_SECRET;
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => { dbg("bridge", "Pont MAIN-world injecté et chargé"); script.remove(); };
  script.onerror = () => dbg("bridge", "ÉCHEC d'injection du pont MAIN-world (script non chargé)", "ERROR");
}

// ── Helpers ──

/**
 * Resolve a relative Threads API path ("/api/v1/...") to an absolute URL against
 * the current page origin. Content scripts share the page's `location`, so on a
 * Threads tab this yields https://www.threads.com/... (or threads.net).
 */
function apiUrl(path: string): string {
  try {
    return new URL(path, location.origin).toString();
  } catch {
    return path; // fall back to the relative form; the bridge allowlist accepts it
  }
}

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

    dbg("api", `429 (tentative ${attempt + 1}/${maxAttempts}) → attente ${Math.round(waitMs / 1000)}s avant nouvel essai`, "WARNING");
    await new Promise((r) => setTimeout(r, waitMs));
  }

  return { status: 429, body: null, gaveUp: true };
}

export interface UserProfile {
  userId: string;
  followerCount: number; // 0 if unknown — caller MUST treat 0 as "do not trust"
  // Confidentialité de référence, depuis web_profile_info / le JSON embarqué de
  // la page — le champ que Threads utilise pour afficher « Ce profil est privé ».
  // Indépendant du rendu, contrairement à la bannière qu'un onglet de fond
  // throttlé peut ne jamais peindre.
  isPrivate: boolean;
}

export async function resolveUserId(username: string): Promise<string | null> {
  const profile = await resolveUserProfile(username);
  return profile?.userId ?? null;
}

export async function resolveUserProfile(username: string): Promise<UserProfile | null> {
  const headers = apiHeaders();

  // Absolutise against the page origin (https://www.threads.com). The bridge's
  // allowlist accepts the relative form too, but an explicit absolute URL is
  // unambiguous and removes any dependency on how fetch resolves a bare path.
  const endpoints = [
    apiUrl(`${THREADS_API.profileEndpoint}?username=${encodeURIComponent(username)}`),
    apiUrl(`${THREADS_API.searchEndpoint}?q=${encodeURIComponent(username)}`),
  ];

  // web_profile_info ET search sont des endpoints Instagram WEB : les DEUX
  // exigent l'app-id WEB (THREADS_API.webAppId), sinon Meta répond 400
  // « useragent mismatch ». Seuls les endpoints Threads natifs (followers)
  // gardent l'app-id Threads.
  const webHeaders = { ...headers, "X-IG-App-ID": THREADS_API.webAppId };

  for (const url of endpoints) {
    try {
      const { status, body } = await mainWorldFetch(url, webHeaders);
      dbg("api", `resolveProfile ${url.replace(/\?.*/, "")} → HTTP ${status}`);

      if (status !== 200) {
        const snippet = (() => { try { return JSON.stringify(body).slice(0, 160); } catch { return String(body).slice(0, 160); } })();
        dbg("api", `resolveProfile non-200 (${status}) body=${snippet}`, "WARNING");
        continue;
      }

      const j = body as Record<string, unknown>;
      const dataObj = j?.data as Record<string, unknown> | undefined;

      // Extraction robuste : la forme varie (threads.com vs instagram.com). On
      // cherche l'objet utilisateur sous data.user, user, ou directement data.
      const userObj =
        (dataObj?.user as Record<string, unknown> | undefined) ||
        (j?.user as Record<string, unknown> | undefined) ||
        dataObj;

      const uid = userObj && (userObj.id ?? userObj.pk ?? userObj.pk_id ?? userObj.user_id);
      if (userObj && uid) {
        const fc = Number(userObj.follower_count ?? 0);
        return { userId: String(uid), followerCount: Number.isFinite(fc) ? fc : 0, isPrivate: !!userObj.is_private };
      }

      // Résultats de recherche : { users: [...] } (parfois users[].user).
      const rawUsers =
        (j?.users as Array<Record<string, unknown>> | undefined) ||
        (dataObj?.users as Array<Record<string, unknown>> | undefined) || [];
      const flat = rawUsers.map((u) => (u.user as Record<string, unknown>) || u);
      const match = flat.find((u) => u.username === username) || flat[0];
      const mid = match && (match.pk ?? match.id ?? match.pk_id);
      if (match && mid) {
        const fc = Number(match.follower_count ?? 0);
        return { userId: String(mid), followerCount: Number.isFinite(fc) ? fc : 0, isPrivate: !!match.is_private };
      }

      // 200 mais aucun uid : on logue la FORME du corps pour trancher (temporaire).
      const shape = (() => {
        try {
          const top = Object.keys(j).join(",");
          const dk = dataObj ? Object.keys(dataObj).join(",") : "—";
          const uk = userObj ? Object.keys(userObj).slice(0, 14).join(",") : "—";
          return `top=[${top}] data=[${dk}] user=[${uk}]`;
        } catch { return "illisible"; }
      })();
      dbg("api", `resolveProfile 200 SANS uid (${url.replace(/\?.*/, "")}) → ${shape}`, "WARNING");
    } catch (e) {
      dbg("api", `resolveProfile EXCEPTION (pont muet ?) : ${String(e)}`, "ERROR");
    }
  }

  // Fallback: check page scripts for embedded data (no follower count available here)
  try {
    const scripts = document.querySelectorAll('script[type="application/json"]');
    for (const s of scripts) {
      const text = s.textContent || "";
      if (text.includes(username)) {
        // Lit is_private dans le MÊME JSON embarqué, près de ce pseudo (le blob
        // peut lister plusieurs comptes → on limite la recherche à une fenêtre après).
        const uIdx = text.indexOf(`"username":"${username}"`);
        const priv = uIdx >= 0 && /"is_private":\s*true/.test(text.slice(uIdx, uIdx + 600));
        const pkM = text.match(/"pk":"?(\d+)"?/);
        if (pkM) {
          return { userId: pkM[1], followerCount: 0, isPrivate: priv };
        }
        const idM = text.match(/"user_id":"?(\d+)"?/);
        if (idM) return { userId: idM[1], followerCount: 0, isPrivate: priv };
      }
    }
  } catch {
    // ignore
  }

  dbg("api", `resolveProfile : aucun identifiant trouvé pour @${username}`, "WARNING");
  return null;
}

export async function fetchFollowersPage(
  userId: string,
  maxId?: string
): Promise<{ users: Record<string, ContentFollowerMeta>; nextMaxId: string | null } | null> {
  const headers = apiHeaders();
  let path = THREADS_API.followersEndpoint.replace("{user_id}", userId);
  path += `?count=${THREADS_API.pageSize}&search_surface=follow_list_page`;
  if (maxId) path += `&max_id=${encodeURIComponent(maxId)}`;
  const url = apiUrl(path);

  try {
    const { status, body, gaveUp } = await fetchWithBackoff(url, headers);
    dbg("api", `fetchFollowersPage → HTTP ${status}${gaveUp ? " (backoff épuisé)" : ""}`);

    if (status === 429) { dbg("api", "fetchFollowersPage : 429 → null (rate-limit)", "WARNING"); return null; }
    if (status !== 200) {
      const snippet = (() => { try { return JSON.stringify(body).slice(0, 160); } catch { return String(body).slice(0, 160); } })();
      dbg("api", `fetchFollowersPage : HTTP ${status} → null · body=${snippet}`, "WARNING");
      return null;
    }

    const data = body as Record<string, unknown>;
    const rawUsers = (data.users as Array<Record<string, unknown>>) || [];
    const users: Record<string, ContentFollowerMeta> = {};

    for (const u of rawUsers) {
      const pseudo = ((u.username as string) || "").trim();
      if (pseudo) {
        users[pseudo] = extractFollowerMeta(u);
      }
    }

    return {
      users,
      nextMaxId: (data.next_max_id as string) || null,
    };
  } catch (e) {
    dbg("api", `fetchFollowersPage EXCEPTION : ${String(e)}`, "ERROR");
    return null;
  }
}
