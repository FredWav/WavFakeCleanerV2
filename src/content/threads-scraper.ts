/**
 * Threads DOM scraper — extracts profile data by visiting profile pages.
 *
 * Ported from the JS snippets in backend/engine/scorer.py (_JS_EXTRACT_PROFILE, etc.)
 * These run directly in the page context as content scripts.
 */

import { SELECTORS, is429 } from "@shared/selectors";
import type { ContentProfileData } from "@shared/messages";
import { humanClick } from "./humanize";

// ── Profile data extraction (ported from _JS_EXTRACT_PROFILE) ──

export function extractProfileFromDom(username: string): Partial<ContentProfileData> {
  const result: Partial<ContentProfileData> = {
    username,
    notFound: false,
    isPrivate: false,
    isVerified: false,
    followerCount: null,
    postCount: 0,
    hasBio: false,
    hasReplies: false,
    hasRealPic: false,
    hasFullName: false,
    hasIgLink: false,
    hasLinkInBio: false,
    fullName: "",
    allPostsRecent: false,
    duplicateRatio: 0,
    hasSpamKeywords: false,
    hasMedia: false,
    error: null,
  };

  const bodyText = (document.body?.innerText || "").toLowerCase();

  // Check not found
  if (SELECTORS.profile.notFoundPatterns.some((p) => p.test(bodyText))) {
    result.notFound = true;
    return result;
  }

  // Check 429
  if (bodyText.length < 500 && is429(document.body?.innerText || "")) {
    result.error = "429_RATE_LIMIT";
    result.notFound = true;
    return result;
  }

  // Private?
  result.isPrivate = SELECTORS.profile.privatePatterns.some((p) => p.test(bodyText));

  // ── Follower count ──
  try {
    const allEls = document.querySelectorAll("span, a, div, p");
    for (const el of allEls) {
      if (el.children.length > 3) continue;
      const t = (el.textContent || "").trim();
      const m = t.match(/^([\d][\d,. \u00a0\u202f]*[KkMm]?)\s*(followers|abonnés)$/i);
      if (m) {
        let cleaned = m[1].trim().replace(/[\s\u00a0\u202f]/g, "");
        const suffix = cleaned.slice(-1).toUpperCase();
        if (suffix === "K") {
          result.followerCount = Math.round(
            parseFloat(cleaned.slice(0, -1).replace(",", ".")) * 1000
          );
        } else if (suffix === "M") {
          result.followerCount = Math.round(
            parseFloat(cleaned.slice(0, -1).replace(",", ".")) * 1000000
          );
        } else {
          result.followerCount = parseInt(cleaned.replace(/[^\d]/g, ""), 10) || 0;
        }
        break;
      }
    }
  } catch {
    // ignore
  }

  // ── Profile picture ──
  try {
    const imgs = document.querySelectorAll("img");
    for (const img of imgs) {
      const src = img.src || "";
      const alt = (img.alt || "").toLowerCase();
      const w = img.naturalWidth || img.width || 0;
      if (
        (alt.includes("photo") ||
          alt.includes("profile") ||
          alt.includes("avatar") ||
          alt.includes(username.toLowerCase())) &&
        w >= 40
      ) {
        result.hasRealPic =
          !src.includes("default") &&
          !src.includes("empty") &&
          !src.includes("placeholder") &&
          !src.includes("/44884218_345");
        break;
      }
    }
    if (!result.hasRealPic) {
      const headerImgs = document.querySelectorAll('img[width], img[style*="width"]');
      for (const img of headerImgs) {
        const r = img.getBoundingClientRect();
        if (r.width >= 60 && r.width <= 200 && r.top < 400) {
          const src = (img as HTMLImageElement).src || "";
          result.hasRealPic =
            !src.includes("default") &&
            !src.includes("empty") &&
            !src.includes("/44884218_345") &&
            src.length > 20;
          break;
        }
      }
    }
  } catch {
    // ignore
  }

  // ── Full name ──
  try {
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) {
      const m = ((ogTitle as HTMLMetaElement).content || "").match(/^(.+?)\s*\(@/);
      if (m) {
        result.fullName = m[1].trim();
        result.hasFullName = result.fullName.length >= 3 && result.fullName !== username;
      }
    }
    if (!result.hasFullName) {
      const headings = document.querySelectorAll('h1, h2, [role="heading"], span[dir="auto"]');
      for (const h of headings) {
        const t = (h.textContent || "").trim();
        if (t.length >= 3 && t.length < 60 && t !== username && !/^\d/.test(t)) {
          result.fullName = t;
          result.hasFullName = true;
          break;
        }
      }
    }
  } catch {
    // ignore
  }

  // ── Instagram link ──
  result.hasIgLink = !!document.querySelector('a[href*="instagram.com"]');

  // ── Bio ──
  try {
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) {
      let bio = (metaDesc as HTMLMetaElement).content || "";
      bio = bio
        .replace(/[\d,.\s]*\s*(followers?|abonnés|following|replies).*/gi, "")
        .trim();
      bio = bio.replace(/^.*?-\s*/, "").trim();
      result.hasBio = bio.length >= 5;
    }
  } catch {
    // ignore
  }

  // ── Link in bio ──
  try {
    const allLinks = document.querySelectorAll("a[href]");
    for (const a of allLinks) {
      const href = ((a as HTMLAnchorElement).href || "").toLowerCase();
      const text = (a.textContent || "").trim();
      if (
        href.includes("threads.net") ||
        href.includes("instagram.com") ||
        href.includes("javascript:") ||
        href === "#" ||
        href.includes("/login") ||
        href.includes("/signup")
      )
        continue;
      if (
        (href.startsWith("http://") || href.startsWith("https://")) &&
        text.length > 3 &&
        (a as HTMLElement).offsetHeight > 0
      ) {
        const r = a.getBoundingClientRect();
        if (r.top < 600) {
          result.hasLinkInBio = true;
          break;
        }
      }
    }
  } catch {
    // ignore
  }

  // ── Verified ──
  result.isVerified = !!document.querySelector(
    '[data-testid="verified-badge"], svg[aria-label*="Verified"], svg[aria-label*="vérifié"]'
  );

  return result;
}

// ── Post counting (ported from _JS_COUNT_POSTS) ──

export function countPosts(): {
  count: number;
  allRecent: boolean;
  duplicateRatio: number;
  hasSpamKeywords: boolean;
} {
  const articles = document.querySelectorAll("article");
  let topLevel = 0;
  for (const a of articles) {
    if (!a.closest("article")?.closest("article") || a.closest("article") === a) topLevel++;
  }
  if (topLevel === 0) {
    topLevel = document.querySelectorAll("[data-pressable-container]").length;
  }

  // Timestamps
  const times = document.querySelectorAll("time[datetime]");
  let allRecent = times.length > 0;
  const now = Date.now();
  const h72 = 72 * 3600 * 1000;
  for (const t of times) {
    const dt = new Date(t.getAttribute("datetime") || "");
    if (!isNaN(dt.getTime()) && now - dt.getTime() > h72) {
      allRecent = false;
    }
  }

  // Duplicate detection
  let dupeRatio = 0;
  if (articles.length >= 2) {
    const texts = Array.from(articles)
      .map((a) => (a.innerText || "").trim().substring(0, 120).toLowerCase())
      .filter((t) => t.length > 20);
    if (texts.length >= 2) {
      const ref = texts[0];
      let dupes = 0;
      for (let i = 1; i < texts.length; i++) {
        let shared = 0;
        const minLen = Math.min(ref.length, texts[i].length);
        for (let j = 0; j < minLen; j++) {
          if (ref[j] === texts[i][j]) shared++;
        }
        if (shared / minLen > 0.6) dupes++;
      }
      dupeRatio = dupes / (texts.length - 1);
    }
  }

  // Spam keywords
  const body = (document.body?.innerText || "").toLowerCase();
  const hasSpamKeywords = SELECTORS.spam.keywords.some((p) => p.test(body));

  return { count: topLevel, allRecent: allRecent && topLevel > 0, duplicateRatio: dupeRatio, hasSpamKeywords };
}

// ── Tab navigation ──

export async function navigateToTab(tabName: string): Promise<boolean> {
  // Find clickable tab elements
  const allTabs = document.querySelectorAll(
    'div[role="tablist"] div[role="tab"], div[role="tablist"] a, a[role="tab"]'
  );
  for (const tab of allTabs) {
    const text = (tab.textContent || "").trim().toLowerCase();
    if (text === tabName.toLowerCase()) {
      await humanClick(tab as HTMLElement);
      return true;
    }
  }

  // Fallback: find by text content in common containers
  const candidates = document.querySelectorAll('a, div[role="tab"], span');
  for (const el of candidates) {
    const text = (el.textContent || "").trim().toLowerCase();
    const rect = el.getBoundingClientRect();
    // Tab-like element: within profile area, reasonable size
    if (
      text === tabName.toLowerCase() &&
      rect.top > 150 &&
      rect.top < 500 &&
      rect.height > 10 &&
      rect.height < 60
    ) {
      await humanClick(el as HTMLElement);
      return true;
    }
  }

  return false;
}

// ── Media checking (runs on the Media tab) ──

export function checkMedia(): { hasMedia: boolean; final: boolean } {
  const body = document.body?.innerText || "";

  // Check for explicit "no media" messages
  for (const pat of SELECTORS.profile.noMediaPatterns) {
    if (pat.test(body)) return { hasMedia: false, final: true };
  }

  // Look for media items (images/videos in the content area)
  const articles = document.querySelectorAll("article, [data-pressable-container]");
  let mediaArticles = 0;
  for (const a of articles) {
    const rect = a.getBoundingClientRect();
    if (rect.top > 300 && rect.height > 30) {
      mediaArticles++;
    }
  }
  if (mediaArticles > 0) return { hasMedia: true, final: true };

  // Check for image/video elements in content area
  const mediaEls = document.querySelectorAll("img, video");
  for (const el of mediaEls) {
    const rect = el.getBoundingClientRect();
    if (rect.top > 300 && rect.width > 50 && rect.height > 50) {
      return { hasMedia: true, final: true };
    }
  }

  return { hasMedia: false, final: false };
}

// ── Reply checking (runs on the Replies tab) ──

export function checkReplies(_username: string): { hasReplies: boolean; final: boolean } {
  // This function now assumes we are already ON the Replies tab.
  // It checks if the Replies tab content has actual reply articles.
  const body = document.body?.innerText || "";

  // Check for explicit "no replies" messages
  for (const pat of SELECTORS.profile.noReplyPatterns) {
    if (pat.test(body)) return { hasReplies: false, final: true };
  }

  // Look for reply articles in the content area (below the profile header)
  const articles = document.querySelectorAll("article, [data-pressable-container]");
  let replyArticles = 0;
  for (const a of articles) {
    const rect = a.getBoundingClientRect();
    // Reply articles appear below the profile header (>300px typically)
    if (rect.top > 300 && rect.height > 30) {
      replyArticles++;
    }
  }
  if (replyArticles > 0) return { hasReplies: true, final: true };

  // Check for time elements in the content area (replies have timestamps)
  const timeEls = document.querySelectorAll("time[datetime]");
  let replyTimes = 0;
  for (const t of timeEls) {
    const rect = t.getBoundingClientRect();
    if (rect.top > 300) replyTimes++;
  }
  if (replyTimes > 0) return { hasReplies: true, final: true };

  return { hasReplies: false, final: false };
}

// ── Scroll-based follower fetching ──

export type MarkScrollReason =
  | "no_links"
  | "no_scrollable_parent"
  | "container_too_small";

export function markScrollContainer(): {
  ok: boolean;
  links: number;
  reason?: MarkScrollReason;
  source?: "dialog" | "modal" | "testid" | "page" | "global";
} {
  // 1) Try DOM variants for modal/page containers, in order of specificity
  const onFollowersPage = SELECTORS.scroll.followersUrlPattern.test(location.pathname);

  type Candidate = { source: NonNullable<ReturnType<typeof markScrollContainer>["source"]>; nodes: Element[] };
  const candidates: Candidate[] = [];

  const dialog = Array.from(document.querySelectorAll(SELECTORS.scroll.dialogLinks));
  if (dialog.length) candidates.push({ source: "dialog", nodes: dialog });

  const modal = Array.from(document.querySelectorAll(SELECTORS.scroll.modalLinks));
  if (modal.length) candidates.push({ source: "modal", nodes: modal });

  const testId = Array.from(document.querySelectorAll(SELECTORS.scroll.testIdLinks));
  if (testId.length) candidates.push({ source: "testid", nodes: testId });

  // Fallback: all profile-shaped links on the page (regex-filtered)
  const globalLinks = Array.from(
    document.querySelectorAll(SELECTORS.scroll.profileLinks)
  ).filter((a) => /^\/@[\w.]+$/.test(a.getAttribute("href") || ""));
  if (globalLinks.length) {
    candidates.push({ source: onFollowersPage ? "page" : "global", nodes: globalLinks });
  }

  if (!candidates.length) {
    console.log("[WFC] markScrollContainer: no_links (none of dialog/modal/testid/global matched)");
    return { ok: false, links: 0, reason: "no_links" };
  }

  // On the dedicated /followers page the document itself is the scroller
  if (onFollowersPage) {
    const root = (document.scrollingElement || document.documentElement) as HTMLElement;
    if (root) {
      root.setAttribute(SELECTORS.scroll.scrollableAttr, "true");
      const totalLinks = candidates.reduce((acc, c) => acc + c.nodes.length, 0);
      console.log(`[WFC] markScrollContainer: ok via dedicated followers page (${totalLinks} links)`);
      return { ok: true, links: totalLinks, source: "page" };
    }
  }

  // 2) For each candidate set, walk up the DOM looking for a scrollable parent
  let lastLinkCount = 0;
  let sawTooSmall = false;
  for (const cand of candidates) {
    lastLinkCount = cand.nodes.length;
    const anchor = cand.nodes[cand.nodes.length - 1] as HTMLElement;
    let el: HTMLElement | null = anchor.parentElement;
    let depth = 0;

    while (el && el !== document.body && depth < 25) {
      const cs = window.getComputedStyle(el);
      const oy = cs.overflowY;
      const hasOverflowSetting = oy === "scroll" || oy === "auto";
      const overflowsContent = el.scrollHeight > el.clientHeight + 10;

      if (hasOverflowSetting && overflowsContent) {
        el.setAttribute(SELECTORS.scroll.scrollableAttr, "true");
        console.log(`[WFC] markScrollContainer: ok via ${cand.source} (${cand.nodes.length} links, depth=${depth})`);
        return { ok: true, links: cand.nodes.length, source: cand.source };
      }

      // Relaxed: accept overflow:hidden when the element is large and content
      // already overflows — common with React virtualized lists where the
      // outer wrapper has overflow:hidden and an inner spacer drives scroll.
      if (oy === "hidden" && overflowsContent && el.clientHeight > 200) {
        el.setAttribute(SELECTORS.scroll.scrollableAttr, "true");
        console.log(`[WFC] markScrollContainer: ok via ${cand.source} relaxed (overflow:hidden, depth=${depth})`);
        return { ok: true, links: cand.nodes.length, source: cand.source };
      }

      if (hasOverflowSetting && !overflowsContent && el.clientHeight > 200) {
        // Overflow is set up but content not (yet) tall enough. Track this so
        // we report a more specific reason if nothing else works.
        sawTooSmall = true;
      }

      el = el.parentElement;
      depth++;
    }
  }

  const reason: MarkScrollReason = sawTooSmall ? "container_too_small" : "no_scrollable_parent";
  console.log(`[WFC] markScrollContainer: failed (${reason}, links=${lastLinkCount})`);
  return { ok: false, links: lastLinkCount, reason };
}

let autoScrollId: ReturnType<typeof setInterval> | null = null;

export function startScroll(speed: number): void {
  const el = document.querySelector(`[${SELECTORS.scroll.scrollableAttr}="true"]`);
  if (!el) return;
  if (autoScrollId) clearInterval(autoScrollId);
  autoScrollId = setInterval(() => {
    el.scrollTop += speed;
  }, 16);
}

export function stopScroll(): void {
  if (autoScrollId) {
    clearInterval(autoScrollId);
    autoScrollId = null;
  }
}

export function extractFollowerLinks(): string[] {
  // Prefer the marked scroller's subtree (set by markScrollContainer).
  // Falls back to dialog/modal/global selectors if no marker is present.
  const scroller = document.querySelector(
    `[${SELECTORS.scroll.scrollableAttr}="true"]`
  );
  let links: NodeListOf<Element> | Element[] | null = null;

  if (scroller) {
    links = scroller.querySelectorAll('a[href*="/@"]');
  }
  if (!links || !links.length) {
    links = document.querySelectorAll(SELECTORS.scroll.dialogLinks);
  }
  if (!links.length) {
    links = document.querySelectorAll(SELECTORS.scroll.modalLinks);
  }
  if (!links.length) {
    links = document.querySelectorAll('a[href*="/@"]');
  }
  return Array.from(links, (a) => a.getAttribute("href") || "");
}

/**
 * Wait for the followers list to be reachable: either a dialog/modal opens,
 * or the URL switches to the dedicated /@user/followers page.
 * Polls every 200 ms; resolves true on success, false on timeout.
 */
export async function waitForFollowersUI(timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (SELECTORS.scroll.followersUrlPattern.test(location.pathname)) return true;
    if (
      document.querySelector(SELECTORS.scroll.dialogLinks) ||
      document.querySelector(SELECTORS.scroll.modalLinks) ||
      document.querySelector('div[role="dialog"]') ||
      document.querySelector('[aria-modal="true"]')
    ) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export async function clickFollowersButton(): Promise<boolean> {
  // Method 1: <a> with href containing "followers"
  const link = document.querySelector("a[href*='followers']") as HTMLElement | null;
  if (link && link.offsetHeight > 0) {
    await humanClick(link);
    return true;
  }

  // Method 2: Find element with "X followers" text
  const candidates = document.querySelectorAll("a, span, header *");
  for (const el of candidates) {
    const t = (el.textContent || "").trim();
    if (SELECTORS.profile.followersTextPattern.test(t)) {
      const r = el.getBoundingClientRect();
      if (r.height < 50) {
        await humanClick(el as HTMLElement);
        return true;
      }
    }
  }

  return false;
}
