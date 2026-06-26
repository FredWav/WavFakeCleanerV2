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
let loggedFollowerShape = false; // DIAG one-shot (cf. fetchFollowersPage)
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
  console.log("[WFC] Injecting main world bridge script");
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

    console.log(`[WFC] 429 received (attempt ${attempt + 1}/${maxAttempts}), waiting ${Math.round(waitMs / 1000)}s before retry`);
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

  for (const url of endpoints) {
    try {
      console.log("[WFC] resolveUserProfile: trying (MAIN world)", url);
      const { status, body } = await mainWorldFetch(url, headers);
      console.log("[WFC] resolveUserProfile: status", status, "for", url);
      dbg("api", `resolveProfile ${url.replace(/\?.*/, "")} → HTTP ${status}`);

      if (status !== 200) {
        const snippet = (() => { try { return JSON.stringify(body).slice(0, 160); } catch { return String(body).slice(0, 160); } })();
        console.log("[WFC] resolveUserProfile: non-200, body =", snippet);
        dbg("api", `resolveProfile non-200 (${status}) body=${snippet}`, "WARNING");
        continue;
      }

      const j = body as Record<string, unknown>;
      console.log("[WFC] resolveUserProfile: response keys =", Object.keys(j));
      // DIAG : forme du corps web_profile_info 200, pour brancher le parser sur
      // les bons champs (et savoir pourquoi l'uid n'en est pas extrait).
      if (url.includes("web_profile_info")) {
        const du = (j?.data as Record<string, unknown> | undefined)?.user as Record<string, unknown> | undefined;
        const u2 = (j?.user as Record<string, unknown> | undefined);
        const uu = du || u2;
        dbg("api", `web_profile_info 200 · topKeys=[${Object.keys(j).join(",")}] · status=${String(j.status ?? "?")} · user=${uu ? "OK(keys:" + Object.keys(uu).slice(0, 14).join(",") + ")" : "ABSENT"}`);
        if (uu) {
          dbg("api", `web_profile_info user : id=${String(uu.id ?? uu.pk ?? "?")} fc=${String(uu.follower_count ?? "?")} priv=${String(uu.is_private ?? "?")} bio=${(String(uu.biography ?? "")).length}c name="${String(uu.full_name ?? "")}"`);
        }
      }

      const userObj =
        ((j?.data as Record<string, unknown>)?.user as Record<string, unknown>) ||
        (j?.user as Record<string, unknown>);

      if (userObj) {
        const uid = userObj.id || userObj.pk || userObj.pk_id;
        const fc = Number(userObj.follower_count ?? 0);
        if (uid) {
          console.log("[WFC] resolveUserProfile: uid=", uid, "followerCount=", fc);
          return { userId: String(uid), followerCount: fc, isPrivate: !!userObj.is_private };
        }
      }

      const users = (j?.users as Array<Record<string, unknown>>) || [];
      const match = users.find((u) => u.username === username);
      if (match) {
        const uid = match.pk || match.id;
        const fc = Number(match.follower_count ?? 0);
        console.log("[WFC] resolveUserProfile: via search uid=", uid, "followerCount=", fc);
        return { userId: String(uid), followerCount: fc, isPrivate: !!match.is_private };
      }

      console.log("[WFC] resolveUserProfile: no uid in response =", JSON.stringify(j).substring(0, 500));
    } catch (e) {
      console.log("[WFC] resolveUserProfile: error for", url, e);
      dbg("api", `resolveProfile EXCEPTION (pont muet ?) : ${String(e)}`, "ERROR");
    }
  }

  // Fallback: check page scripts for embedded data (no follower count available here)
  try {
    const scripts = document.querySelectorAll('script[type="application/json"]');
    console.log("[WFC] resolveUserProfile: checking", scripts.length, "script tags");
    for (const s of scripts) {
      const text = s.textContent || "";
      if (text.includes(username)) {
        // Lit is_private dans le MÊME JSON embarqué, près de ce pseudo (le blob
        // peut lister plusieurs comptes → on limite la recherche à une fenêtre après).
        const uIdx = text.indexOf(`"username":"${username}"`);
        const priv = uIdx >= 0 && /"is_private":\s*true/.test(text.slice(uIdx, uIdx + 600));
        const pkM = text.match(/"pk":"?(\d+)"?/);
        if (pkM) {
          console.log("[WFC] resolveUserProfile: found pk in script tag:", pkM[1]);
          return { userId: pkM[1], followerCount: 0, isPrivate: priv };
        }
        const idM = text.match(/"user_id":"?(\d+)"?/);
        if (idM) return { userId: idM[1], followerCount: 0, isPrivate: priv };
      }
    }
  } catch {
    // ignore
  }

  console.log("[WFC] resolveUserProfile: FAILED for", username);
  return null;
}

// PROBE diagnostique (TEMP) : teste l'endpoint profil par ID et logue sa forme.
async function probeUserInfo(userId: string): Promise<void> {
  try {
    const url = apiUrl(`/api/v1/users/${encodeURIComponent(userId)}/info/`);
    const { status, body } = await mainWorldFetch(url, apiHeaders());
    const j = (body as Record<string, unknown>) || {};
    const u =
      (j.user as Record<string, unknown> | undefined) ||
      ((j.data as Record<string, unknown> | undefined)?.user as Record<string, unknown> | undefined);
    if (u) {
      dbg("api", `PROBE /users/{id}/info/ → HTTP ${status} · user OK · media_count=${String(u.media_count)} follower_count=${String(u.follower_count)} bio=${String(u.biography ?? "").length}c`);
    } else {
      dbg("api", `PROBE /users/{id}/info/ → HTTP ${status} · topKeys=[${Object.keys(j).join(",")}] · user ABSENT`, "WARNING");
    }
  } catch (e) {
    dbg("api", `PROBE /users/{id}/info/ EXCEPTION — ${String(e)}`, "WARNING");
  }
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
    console.log("[WFC] fetchFollowersPage:", url);
    const { status, body, gaveUp } = await fetchWithBackoff(url, headers);
    console.log("[WFC] fetchFollowersPage: status", status, gaveUp ? "(backoff exhausted)" : "");
    dbg("api", `fetchFollowersPage → HTTP ${status}${gaveUp ? " (backoff épuisé)" : ""}`);

    if (status === 429) { dbg("api", "fetchFollowersPage : 429 → null (rate-limit)", "WARNING"); return null; }
    if (status !== 200) {
      const snippet = (() => { try { return JSON.stringify(body).slice(0, 160); } catch { return String(body).slice(0, 160); } })();
      dbg("api", `fetchFollowersPage : HTTP ${status} → null · body=${snippet}`, "WARNING");
      return null;
    }

    const data = body as Record<string, unknown>;
    const rawUsers = (data.users as Array<Record<string, unknown>>) || [];
    // DIAG one-shot : quels champs l'endpoint followers donne par abonné ?
    // (savoir si on a déjà follower_count / biography / media_count = postCount
    // sans visiter le profil → scan API possible).
    if (!loggedFollowerShape && rawUsers.length > 0) {
      loggedFollowerShape = true;
      dbg("api", `champs abonné brut = [${Object.keys(rawUsers[0]).join(",")}]`);
      // PROBE one-shot : /api/v1/users/{id}/info/ renvoie-t-il le profil COMPLET
      // (media_count = nb de posts, follower_count, biography) ? Si oui → scan API
      // sans visite possible (web_profile_info étant mort sur Threads).
      const probePk = String(rawUsers[0].pk ?? rawUsers[0].id ?? "");
      if (probePk) void probeUserInfo(probePk);
    }
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

