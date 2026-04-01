/**
 * Content script entry point — injected into Threads pages.
 *
 * IMPORTANT: The chrome.runtime.onMessage listener is registered FIRST,
 * before any other initialization, to ensure the service worker can always
 * reach this script.
 */

import type { ContentCommand, ContentMessage, ContentFollowerMeta, ContentProfileData } from "@shared/messages";

// ── Register message listener IMMEDIATELY ──

chrome.runtime.onMessage.addListener(
  (message: ContentCommand, _sender, sendResponse: (response: unknown) => void) => {
    handleCommand(message)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e) }));
    return true; // async response
  }
);

console.log("[WFC] Content script loaded on", window.location.href);

// ── Now safe to import other modules ──

import { resolveUserId, fetchFollowersPage, fetchProfileApi, injectMainWorldBridge } from "./api-interceptor";
import { SELECTORS } from "@shared/selectors";
import {
  extractProfileFromDom,
  countPosts,
  checkReplies,
  navigateToTab,
  markScrollContainer,
  startScroll,
  stopScroll,
  extractFollowerLinks,
  clickFollowersButton,
} from "./threads-scraper";
import { clickThreeDots, clickRemoveFollower, clickConfirm, performRemoveFollower } from "./threads-actions";

// ── Send message to service worker ──

function send(message: ContentMessage): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // service worker may not be listening yet
  });
}

// ── Command handler ──

async function handleCommand(cmd: ContentCommand): Promise<unknown> {
  switch (cmd.type) {
    case "FETCH_FOLLOWERS":
      return await handleFetchFollowers(cmd.payload.username);

    case "SCAN_PROFILE":
      return await handleScanProfile(cmd.payload.username);

    case "REMOVE_FOLLOWER":
      return await handleRemoveFollower(cmd.payload.username);

    case "FETCH_PROFILE_API":
      return await fetchProfileApi(cmd.payload.username);

    case "PING":
      return { ok: true, url: window.location.href };

    default:
      return { error: "unknown_command" };
  }
}

// ── Fetch followers (API pagination + scroll fallback) ──

async function handleFetchFollowers(
  username: string
): Promise<{ collected: Record<string, ContentFollowerMeta>; method: string } | { error: string }> {
  // Try API first
  const userId = await resolveUserId(username);
  if (userId) {
    console.log("[WFC] User ID resolved:", userId);

    const collected: Record<string, ContentFollowerMeta> = {};
    let maxId: string | null = null;
    let page = 0;
    let errors = 0;

    const first = await fetchFollowersPage(userId);
    if (first && Object.keys(first.users).length > 0) {
      Object.assign(collected, first.users);
      maxId = first.nextMaxId;
      page = 1;

      while (maxId) {
        page++;
        await sleep(800 + Math.random() * 700 + page * 20);

        const result = await fetchFollowersPage(userId, maxId);
        if (!result) {
          errors++;
          if (errors >= 3) break;
          await sleep(3000 + Math.random() * 3000);
          continue;
        }

        errors = 0;
        Object.assign(collected, result.users);
        maxId = result.nextMaxId;

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
): Promise<{ collected: Record<string, ContentFollowerMeta>; method: string } | { error: string }> {
  if (!clickFollowersButton()) {
    return { error: "followers_button_not_found" };
  }

  await sleep(4000);

  let containerFound = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    const mark = markScrollContainer();
    if (mark.ok) {
      containerFound = true;
      break;
    }
    await sleep(2000);
  }

  if (!containerFound) {
    return { error: "scroll_container_not_found" };
  }

  startScroll(120);
  const pseudos = new Set<string>();
  let lastCount = 0;
  let noChange = 0;
  const startTime = Date.now();
  const maxDuration = 1800_000;
  const maxFollowers = 5000;

  while (true) {
    if (Date.now() - startTime > maxDuration) break;
    if (pseudos.size >= maxFollowers) break;

    await sleep(500);

    const hrefs = extractFollowerLinks();
    for (const href of hrefs) {
      const pseudo = href.split("/@").pop()?.replace("/", "") || "";
      if (pseudo && !pseudo.includes("?") && !pseudo.includes("/") && pseudo !== username) {
        pseudos.add(pseudo);
      }
    }

    if (pseudos.size === lastCount) {
      noChange++;
    } else {
      noChange = 0;
      lastCount = pseudos.size;
    }

    if (noChange >= 6) break;

    stopScroll();
    await sleep(1200);
    startScroll(120);
  }

  stopScroll();

  const collected: Record<string, ContentFollowerMeta> = {};
  for (const p of pseudos) {
    collected[p] = {
      followerCount: null,
      isVerified: false,
      fullName: "",
      isPrivate: false,
      hasProfilePic: true,
      biography: "",
      bioLinks: [],
      externalUrl: "",
    };
  }

  return { collected, method: "scroll" };
}

// ── Scan profile ──

async function handleScanProfile(username: string): Promise<ContentProfileData> {
  const data = extractProfileFromDom(username);

  if (!data.isPrivate) {
    // ── Step 1: Check posts on the Threads tab ──
    // Ensure we're on the Threads tab first
    for (const tabName of SELECTORS.profile.threadsTabTexts) {
      if (navigateToTab(tabName)) {
        await sleep(800);
        break;
      }
    }

    const noThreads = (document.body?.innerText || "").toLowerCase();
    const isEmpty = SELECTORS_NO_THREADS.some((p) => p.test(noThreads));

    if (isEmpty) {
      data.postCount = 0;
    } else {
      const postInfo = countPosts();
      data.postCount = postInfo.count;
      data.allPostsRecent = postInfo.allRecent;
      data.duplicateRatio = postInfo.duplicateRatio;
      data.hasSpamKeywords = postInfo.hasSpamKeywords;
    }

    // ── Step 2: Navigate to Replies tab and check replies ──
    // V1 logic: click tab, then poll up to 5 times × 1.5s for content to load
    let navigatedToReplies = false;
    for (const tabName of SELECTORS.profile.repliesTabTexts) {
      if (navigateToTab(tabName)) {
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

    // ── Step 3: Navigate back to Threads tab (for next profile) ──
    for (const tabName of SELECTORS.profile.threadsTabTexts) {
      if (navigateToTab(tabName)) break;
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

// ── Inject MAIN world bridge for API calls ──

injectMainWorldBridge();

// ── Notify service worker ──

send({ type: "CONTENT_READY" });

// ── Utility ──

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
