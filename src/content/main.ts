/**
 * Content script entry point — injected into Threads pages.
 *
 * IMPORTANT: The chrome.runtime.onMessage listener is registered FIRST,
 * before any other initialization, to ensure the service worker can always
 * reach this script.
 */

// ── Guard contre double injection (manifest auto-inject + executeScript dynamique) ──
const _wfcWin = window as unknown as Record<string, boolean>;
const _alreadyLoaded = !!_wfcWin.__WFC_CONTENT_LOADED__;
if (_alreadyLoaded) {
  console.log("[WFC] Content script already loaded, skipping duplicate injection");
}
_wfcWin.__WFC_CONTENT_LOADED__ = true;

import type { ContentCommand, ContentMessage, ContentFollowerMeta, ContentProfileData } from "@shared/messages";

// ── Register message listener IMMEDIATELY (sauf si déjà chargé) ──

if (!_alreadyLoaded) {
  chrome.runtime.onMessage.addListener(
    (message: ContentCommand, _sender, sendResponse: (response: unknown) => void) => {
      handleCommand(message)
        .then(sendResponse)
        .catch((e) => sendResponse({ error: String(e) }));
      return true; // async response
    }
  );

  console.log("[WFC] Content script loaded on", window.location.href);
}

// ── Now safe to import other modules ──

import { resolveUserProfile, fetchFollowersPage, injectMainWorldBridge } from "./api-interceptor";
import { SELECTORS } from "@shared/selectors";
import {
  extractProfileFromDom,
  countPosts,
  checkMedia,
  checkReplies,
  navigateToTab,
  markScrollContainer,
  scrollStep,
  stopScroll,
  extractFollowerLinks,
  clickFollowersButton,
  waitForFollowersUI,
} from "./threads-scraper";
import { performRemoveFollower, recoverFromErrorPage, isTransientErrorPage } from "./threads-actions";
import { onDrift } from "@shared/selector-strategies";

// ── Selector drift telemetry ──
// Fires when a non-primary selector strategy succeeds — signal that Threads
// has changed its DOM and the primary needs updating. The service worker
// rebroadcasts the LOG_EVENT (UI toast) and reports it to telemetry.
onDrift((event) => {
  send({ type: "DRIFT_DETECTED", payload: event });
});

// ── Send message to service worker ──

function send(message: ContentMessage): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // service worker may not be listening yet
  });
}

// ── Abort flag — set by STOP_CONTENT, checked in long loops ──

let contentAborted = false;

// ── Command handler ──

async function handleCommand(cmd: ContentCommand): Promise<unknown> {
  switch (cmd.type) {
    case "STOP_CONTENT":
      contentAborted = true;
      stopScroll();
      return { ok: true };

    case "FETCH_FOLLOWERS":
      contentAborted = false;
      return await handleFetchFollowers(cmd.payload.username, cmd.payload.knownUsernames);

    case "SCAN_PROFILE":
      contentAborted = false;
      return await handleScanProfile(cmd.payload.username);

    case "REMOVE_FOLLOWER":
      return await handleRemoveFollower(cmd.payload.username);

    case "CHECK_PAGE": {
      const errorPage = isTransientErrorPage();
      if (errorPage) {
        await recoverFromErrorPage();
        // Check again after recovery
        return { ok: !isTransientErrorPage(), errorPage: true };
      }
      return { ok: true, errorPage: false };
    }

    case "PING":
      return { ok: true, url: window.location.href };

    default:
      return { error: "unknown_command" };
  }
}

// ── Fetch followers (API pagination + scroll fallback) ──

async function handleFetchFollowers(
  username: string,
  knownUsernames?: string[],
): Promise<
  | { collected: Record<string, ContentFollowerMeta>; method: string; truncated?: boolean; truncReason?: "cap_5000" | "timeout" }
  | { error: string; reason?: string; linksFound?: number }
> {
  const knownSet = new Set(knownUsernames || []);
  const hasKnown = knownSet.size > 0;

  // Try API first
  const profile = await resolveUserProfile(username);
  const userId = profile?.userId;
  // Total followers reported by Threads. 0 means "unknown" — when unknown,
  // we MUST disable the early-stop heuristic (else we risk stopping after a few
  // pages on a partial DB). Acts as a safety check below.
  const totalFollowers = profile?.followerCount || 0;
  if (userId) {
    console.log(
      "[WFC] User ID resolved:",
      userId,
      hasKnown ? `(${knownSet.size} known followers)` : "(first fetch)",
      `[total reported by Threads: ${totalFollowers || "unknown"}]`,
    );

    const collected: Record<string, ContentFollowerMeta> = {};
    let maxId: string | null = null;
    let page = 0;
    let errors = 0;
    // Pages d'affilee ou aucun follower n'est nouveau. On stoppe quand ce
    // compteur atteint un seuil suffisamment robuste pour qu'on soit sur
    // d'avoir tout vu au-dessus du tail "known". Tolere les nouveaux follows
    // intercales avec des anciens (rare mais possible cote Threads).
    let pagesWithoutNew = 0;
    const STOP_AFTER_NO_NEW_PAGES = 3;

    const first = await fetchFollowersPage(userId);
    if (first && Object.keys(first.users).length > 0) {
      Object.assign(collected, first.users);
      maxId = first.nextMaxId;
      page = 1;
      // Incremental save: hand off page 1 to the background ASAP so it's
      // persisted even if the user clicks Stop right after.
      send({ type: "FOLLOWERS_PAGE", payload: { users: first.users } } as ContentMessage);

      while (maxId && !contentAborted) {
        page++;
        await sleep(800 + Math.random() * 700 + page * 20);
        if (contentAborted) break;

        const result = await fetchFollowersPage(userId, maxId);
        if (!result) {
          errors++;
          if (errors >= 3) break;
          await sleep(3000 + Math.random() * 3000);
          continue;
        }

        errors = 0;
        const pageUsernames = Object.keys(result.users);
        Object.assign(collected, result.users);
        maxId = result.nextMaxId;
        // Hand off the new page to the background for incremental persistence
        send({ type: "FOLLOWERS_PAGE", payload: { users: result.users } } as ContentMessage);

        // Early stop incremental: si on a deja un cache local (hasKnown), on
        // arrete des qu'on observe N pages CONSECUTIVES sans aucun nouveau
        // follower. Ca capture l'integralite du delta sans jamais re-fetcher
        // la liste complete — exactement ce que l'utilisateur veut quand il
        // a pris quelques centaines d'abonnes depuis le dernier scan.
        if (hasKnown && pageUsernames.length > 0) {
          const newInPage = pageUsernames.filter((u) => !knownSet.has(u)).length;
          if (newInPage === 0) {
            pagesWithoutNew++;
            console.log(`[WFC] Page ${page}: 0 new followers (${pagesWithoutNew}/${STOP_AFTER_NO_NEW_PAGES})`);
            if (pagesWithoutNew >= STOP_AFTER_NO_NEW_PAGES) {
              const collectedSoFar = Object.keys(collected).length;
              console.log(
                `[WFC] Early stop: ${STOP_AFTER_NO_NEW_PAGES} pages d'affilee sans nouveau follower — fini.`,
              );
              send({ type: "FETCH_PROGRESS", payload: { page, total: collectedSoFar } } as ContentMessage);
              break;
            }
          } else {
            // Au moins 1 nouveau sur cette page — reset du compteur.
            pagesWithoutNew = 0;
          }
        }

        // Send progress update every 5 pages
        if (page % 5 === 0) {
          send({ type: "FETCH_PROGRESS", payload: { page, total: Object.keys(collected).length } } as ContentMessage);
        }
      }

      return { collected, method: `api(${page}p)` };
    } else {
      console.log("[WFC] API first page returned no users, falling back to scroll");
    }
  } else {
    console.log("[WFC] Could not resolve user ID for @" + username);
  }

  return await scrollFetch(username);
}

async function scrollFetch(
  username: string
): Promise<
  | { collected: Record<string, ContentFollowerMeta>; method: string; truncated?: boolean; truncReason?: "cap_5000" | "timeout" }
  | { error: string; reason?: string; linksFound?: number }
> {
  // If we're already on the dedicated /@user/followers page (e.g., after a
  // service-worker navigation retry), skip the click step entirely.
  const onFollowersPage = SELECTORS.scroll.followersUrlPattern.test(location.pathname);

  if (!onFollowersPage) {
    let clicked = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await clickFollowersButton()) {
        clicked = true;
        break;
      }
      await sleep(1500);
    }
    if (!clicked) {
      return { error: "followers_button_not_found" };
    }

    // Wait for either a modal/dialog to render or the URL to switch to the
    // dedicated followers route. Replaces the old fixed sleep(4000).
    await waitForFollowersUI(8000);
  }

  let containerFound = false;
  let lastReason: string | undefined;
  let lastLinks = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    const mark = markScrollContainer();
    if (mark.ok) {
      containerFound = true;
      break;
    }
    lastReason = mark.reason;
    lastLinks = mark.links;
    await sleep(2000);
  }

  if (!containerFound) {
    return {
      error: "scroll_container_not_found",
      reason: lastReason,
      linksFound: lastLinks,
    };
  }

  const pseudos = new Set<string>();
  let lastCount = 0;
  let noChange = 0;
  let stagnant = 0;     // consecutive scroll steps where scrollTop didn't advance
  let rawHrefs = 0;     // links seen on the last extraction (for diagnostics)
  const startTime = Date.now();
  const maxDuration = 1800_000;
  const maxFollowers = 5000;
  // Track whether we stopped on a hard cap/timeout (= list truncated, the
  // caller must warn the user) rather than a natural end (got everyone).
  let truncReason: "cap_5000" | "timeout" | null = null;

  while (!contentAborted) {
    if (Date.now() - startTime > maxDuration) { truncReason = "timeout"; break; }
    if (pseudos.size >= maxFollowers) { truncReason = "cap_5000"; break; }

    // Drive the scroll with one explicit jump (robust under hidden-tab timer
    // throttling), then let the lazily-loaded rows mount before reading them.
    const step = scrollStep();
    if (step.advanced) stagnant = 0; else stagnant++;
    await sleep(700);

    const hrefs = extractFollowerLinks();
    rawHrefs = hrefs.length;
    for (const href of hrefs) {
      // CRITICAL: do NOT strip the slash. A href like "/@fredwav/media" must
      // be REJECTED (owner's own sub-page, not a follower), not coerced into
      // "fredwavmedia". Drop the query, then require a clean username.
      const pseudo = (href.split("/@").pop() || "").split("?")[0];
      if (
        pseudo &&
        !pseudo.includes("/") &&         // sub-page (replies, media, followers…) → reject
        !pseudo.includes("?") &&         // safety belt
        pseudo !== username              // owner's own profile → reject
      ) {
        pseudos.add(pseudo);
      }
    }

    if (pseudos.size === lastCount) noChange++;
    else { noChange = 0; lastCount = pseudos.size; }

    // Fast-fail a wrong/non-scrollable container: nothing collected AND either
    // the list never moved or several reads found no new rows. Bail so the
    // pipeline re-runs on the dedicated /@user/followers page. Skipped on the
    // followers page itself (there, 0 means a genuinely empty list — terminal).
    if (pseudos.size === 0 && (stagnant >= 3 || noChange >= 3) && !onFollowersPage) {
      stopScroll();
      return {
        error: "scroll_container_not_found",
        reason: stagnant >= 3 ? "scrolltop_not_advancing" : "zero_extracted",
        linksFound: rawHrefs,
      };
    }

    // Natural end: scrolled but no NEW followers across several reads.
    if (noChange >= 6 && pseudos.size > 0) break;
    // Backstop: don't spin forever once the list clearly stopped producing.
    if (noChange >= 8) break;
  }

  stopScroll();

  // A scroll that collected nothing off the dedicated page is a failure, not a
  // success-with-0 — surface it so the /@user/followers retry fires.
  if (pseudos.size === 0 && !onFollowersPage) {
    return { error: "scroll_container_not_found", reason: "zero_extracted", linksFound: rawHrefs };
  }

  const collected: Record<string, ContentFollowerMeta> = {};
  for (const p of pseudos) {
    collected[p] = {
      followerCount: null,
      followingCount: null,
      isVerified: false,
      fullName: "",
      isPrivate: false,
      hasProfilePic: true,
      biography: "",
      bioLinks: [],
      externalUrl: "",
    };
  }

  return {
    collected,
    method: "scroll",
    truncated: truncReason !== null,
    truncReason: truncReason ?? undefined,
  };
}

// ── Scan profile ──

async function handleScanProfile(username: string): Promise<ContentProfileData> {
  // Recover from Threads error page left by a previous action
  await recoverFromErrorPage();

  const data = extractProfileFromDom(username);

  // La bannière « Ce profil est privé » est rendue côté client et un onglet de
  // fond throttlé ne la peint souvent jamais : lire le texte du DOM seul rate les
  // comptes privés et les scanne comme des fantômes publics (0 post → faux
  // verdict). On confirme la confidentialité depuis les données PROPRES du profil
  // (web_profile_info, le champ que Threads utilise pour la bannière ; repli sur
  // le JSON embarqué de la page). Indépendant du rendu → fiable même sur un
  // onglet de fond throttlé.
  if (!data.isPrivate) {
    try {
      const prof = await resolveUserProfile(username);
      if (prof?.isPrivate) data.isPrivate = true;
    } catch {
      // échec réseau/parsing — on garde le résultat du DOM
    }
  }

  if (!data.isPrivate) {
    // ── Step 1: Check posts on the Threads tab ──
    // Ensure we're on the Threads tab first
    for (const tabName of SELECTORS.profile.threadsTabTexts) {
      if (await navigateToTab(tabName)) {
        await sleep(800);
        break;
      }
    }

    const noThreads = (document.body?.innerText || "").toLowerCase();
    const isEmpty = SELECTORS_NO_THREADS.some((p) => p.test(noThreads));

    if (isEmpty) {
      // « Aucun thread » explicite → vrai 0 post confirmé.
      data.postCount = 0;
    } else {
      const postInfo = countPosts();
      if (postInfo.count > 0 || profileContentRendered(data)) {
        // Soit on a trouvé des posts, soit la page de profil a bien chargé
        // (en-tête peint / signal de feed présent) → le « 0 » est réel.
        data.postCount = postInfo.count;
        data.allPostsRecent = postInfo.allRecent;
        data.duplicateRatio = postInfo.duplicateRatio;
        data.hasSpamKeywords = postInfo.hasSpamKeywords;
      } else {
        // B-C1 : 0 article trouvé ET aucune preuve que la page a réellement
        // chargé (onglet de fond throttlé, DOM non hydraté). On NE croit PAS
        // au « 0 post » : -1 = inconnu → le scorer neutralise tous les signaux
        // liés aux posts au lieu de marquer faux à tort un vrai abonné.
        data.postCount = -1;
      }
    }

    // ── Step 2: Navigate to Media tab and check for media ──
    let navigatedToMedia = false;
    for (const tabName of SELECTORS.profile.mediaTabTexts) {
      if (await navigateToTab(tabName)) {
        navigatedToMedia = true;
        break;
      }
    }

    if (navigatedToMedia) {
      await sleep(1200);
      let mediaResult = { hasMedia: false, final: false };
      for (let attempt = 0; attempt < 3; attempt++) {
        mediaResult = checkMedia();
        if (mediaResult.final) break;
        await sleep(800);
      }
      data.hasMedia = mediaResult.hasMedia;
    }

    // ── Step 3: Navigate to Replies tab and check replies ──
    let navigatedToReplies = false;
    for (const tabName of SELECTORS.profile.repliesTabTexts) {
      if (await navigateToTab(tabName)) {
        navigatedToReplies = true;
        break;
      }
    }

    if (navigatedToReplies) {
      // Poll for reply content (V1 does 5 × 1.5s = 7.5s max)
      let replyResult = { hasReplies: false, final: false };
      for (let attempt = 0; attempt < 5; attempt++) {
        await sleep(1500);
        replyResult = checkReplies(username);
        if (replyResult.final) break;
      }
      data.hasReplies = replyResult.hasReplies;
    } else {
      // Couldn't navigate to replies tab — assume no replies
      data.hasReplies = false;
    }

    // ── Step 4: Navigate back to Threads tab (for next profile) ──
    for (const tabName of SELECTORS.profile.threadsTabTexts) {
      if (await navigateToTab(tabName)) break;
    }
  }

  return data as ContentProfileData;
}

const SELECTORS_NO_THREADS = [
  /aucun thread/i,
  /no threads yet/i,
  /nothing here yet/i,
  /hasn.t posted/i,
  /n.a pas encore publi/i,
];

/**
 * Preuve que la page de profil a RÉELLEMENT été peinte (et pas juste un onglet
 * de fond throttlé dont le HTML est servi mais React jamais hydraté). Sert à
 * distinguer un vrai « 0 post » d'une page non chargée — cœur du fix B-C1.
 *
 * On n'utilise QUE des signaux rendus côté client (jamais og:title/meta, qui
 * sont dans le HTML statique et présents même sur un onglet non hydraté) :
 *   - un post/horodatage du feed effectivement monté ;
 *   - le compteur d'abonnés lu dans le DOM (rendu par React dans l'en-tête) ;
 *   - une vraie photo de profil détectée.
 */
function profileContentRendered(data: Partial<ContentProfileData>): boolean {
  if (document.querySelector("article, [data-pressable-container], time[datetime]")) return true;
  if (data.followerCount !== null && data.followerCount !== undefined) return true;
  if (data.hasRealPic) return true;
  return false;
}

// ── Remove follower ──

async function handleRemoveFollower(
  username: string
): Promise<{ success: boolean; action: string; error?: string; blocked?: boolean }> {
  // Use the enhanced remove flow with blocking detection
  const result = await performRemoveFollower(username);

  // If Threads is blocking us, notify the service worker
  if (result.blocked) {
    send({ type: "RATE_LIMIT_DETECTED" } as ContentMessage);
    console.log("[WFC] Threads blocking detected for @" + username, result.error);
  }

  return result;
}

// ── Inject MAIN world bridge for API calls (sauf si déjà chargé) ──

if (!_alreadyLoaded) {
  injectMainWorldBridge();

  // ── Notify service worker ──
  send({ type: "CONTENT_READY" });
}

// ── Utility ──

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
