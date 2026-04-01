/**
 * Threads DOM scraper — extracts profile data by visiting profile pages.
 *
 * Ported from the JS snippets in backend/engine/scorer.py (_JS_EXTRACT_PROFILE, etc.)
 * These run directly in the page context as content scripts.
 */

import { SELECTORS, is429 } from "@shared/selectors";
import type { ContentProfileData } from "@shared/messages";

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

export function navigateToTab(tabName: string): boolean {
  // Find clickable tab elements
  const allTabs = document.querySelectorAll(
    'div[role="tablist"] div[role="tab"], div[role="tablist"] a, a[role="tab"]'
  );
  for (const tab of allTabs) {
    const text = (tab.textContent || "").trim().toLowerCase();
    if (text === tabName.toLowerCase()) {
      (tab as HTMLElement).click();
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
      (el as HTMLElement).click();
      return true;
    }
  }

  return false;
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

export function markScrollContainer(): { ok: boolean; links: number } {
  let links = Array.from(
    document.querySelectorAll(SELECTORS.scroll.dialogLinks)
  );
  if (!links.length) {
    links = Array.from(document.querySelectorAll(SELECTORS.scroll.profileLinks)).filter(
      (a) => /^\/@[\w.]+$/.test(a.getAttribute("href") || "")
    );
  }
  if (!links.length) return { ok: false, links: 0 };

  let el: HTMLElement | null = links[links.length - 1].parentElement;
  while (el && el !== document.body) {
    const oy = window.getComputedStyle(el).overflowY;
    if ((oy === "scroll" || oy === "auto") && el.scrollHeight > el.clientHeight + 10) {
      el.setAttribute(SELECTORS.scroll.scrollableAttr, "true");
      return { ok: true, links: links.length };
    }
    el = el.parentElement;
  }
  return { ok: false, links: links.length };
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
  let links = document.querySelectorAll(SELECTORS.scroll.dialogLinks);
  if (!links.length) {
    const scroller = document.querySelector(
      `[${SELECTORS.scroll.scrollableAttr}="true"]`
    );
    if (scroller) links = scroller.querySelectorAll('a[href*="/@"]');
  }
  if (!links.length) links = document.querySelectorAll('a[href*="/@"]');
  return Array.from(links, (a) => a.getAttribute("href") || "");
}

export function clickFollowersButton(): boolean {
  // Method 1: <a> with href containing "followers"
  const link = document.querySelector("a[href*='followers']") as HTMLElement | null;
  if (link && link.offsetHeight > 0) {
    link.click();
    return true;
  }

  // Method 2: Find element with "X followers" text
  const candidates = document.querySelectorAll("a, span, header *");
  for (const el of candidates) {
    const t = (el.textContent || "").trim();
    if (SELECTORS.profile.followersTextPattern.test(t)) {
      const r = el.getBoundingClientRect();
      if (r.height < 50) {
        (el as HTMLElement).click();
        return true;
      }
    }
  }

  return false;
}
