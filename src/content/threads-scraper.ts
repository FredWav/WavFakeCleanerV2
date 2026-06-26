/**
 * Threads DOM scraper — extracts profile data by visiting profile pages.
 *
 * Ported from the JS snippets in backend/engine/scorer.py (_JS_EXTRACT_PROFILE, etc.)
 * These run directly in the page context as content scripts.
 */

import { SELECTORS, is429 } from "@shared/selectors";
import type { ContentProfileData } from "@shared/messages";
import { reportDrift } from "@shared/selector-strategies";
import { humanClick } from "./humanize";

// ── Private profile detection ──
// Threads renders the "this account is private" banner as a heading or a
// strong element near the top of the profile. We scan headings + aria
// labels first (highest precision), then fall back to the full body text.
function detectIsPrivate(bodyText: string): boolean {
  const patterns = SELECTORS.profile.privatePatterns;

  // 1) Headings — Threads always uses h1/h2/h3 for the private banner.
  //    Tightest match, lowest false-positive rate.
  const headings = document.querySelectorAll("h1, h2, h3, h4, [role='heading']");
  for (const el of headings) {
    const t = ((el as HTMLElement).innerText || el.textContent || "").trim();
    if (!t) continue;
    if (patterns.some((p) => p.test(t))) return true;
  }

  // 2) ARIA labels & titles often carry the localised "private" wording.
  const labeled = document.querySelectorAll("[aria-label], [title]");
  for (const el of labeled) {
    const al = (el as HTMLElement).getAttribute("aria-label") || "";
    const ti = (el as HTMLElement).getAttribute("title") || "";
    if (patterns.some((p) => p.test(al) || p.test(ti))) return true;
  }

  // 3) Body-text fallback (case-insensitive — patterns already use /i flag).
  if (patterns.some((p) => p.test(bodyText))) return true;

  return false;
}

// Le profil affiche-t-il un bouton « Débloquer » ? Vrai ⇒ c'est un compte que
// l'utilisateur a lui-même bloqué (et non un faux à supprimer).
function hasUnblockButton(): boolean {
  const texts = SELECTORS.profile.unblockButtonTexts;
  const btns = document.querySelectorAll('div[role="button"], button, [role="button"], a');
  for (const b of btns) {
    const t = ((b as HTMLElement).innerText || b.textContent || "").trim();
    if (t && texts.includes(t)) return true;
  }
  return false;
}

// ── Profile data extraction (ported from _JS_EXTRACT_PROFILE) ──

/**
 * Scope expensive querySelectorAll calls to the profile container instead
 * of the whole document. Threads renders a feed below the profile that can
 * contain hundreds of <a>/<img>/<span> nodes; scoping cuts the search space
 * to ~5 % of the DOM and eliminates most reflow-causing reads.
 *
 * Falls back to document.body when the expected wrappers aren't present
 * (rare, but keeps the scraper resilient against future Threads layouts).
 */
function getProfileScope(): Element {
  // Prefer <main> (the document landmark) — Threads always wraps the
  // profile content in it. <header> contains the avatar/name/bio block,
  // which is where most signals live.
  return document.querySelector("main") || document.body;
}

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

  // Compte que J'AI bloqué : Threads affiche un bouton « Débloquer » + « Contenu
  // indisponible » à la place du profil (0 post visible → sinon scoré faux à tort).
  // Ce n'est PAS un faux — l'utilisateur l'a déjà traité. On signale l'état pour
  // que le pipeline l'ignore.
  if (hasUnblockButton()) {
    result.error = "blocked_by_me";
    return result;
  }

  // Private? — multi-source detection to minimise false negatives.
  result.isPrivate = detectIsPrivate(bodyText);

  const scope = getProfileScope();

  // ── Follower count ──
  try {
    // Scope to the profile area; Threads also renders feed posts with
    // "X followers" mentions that would otherwise poison the match.
    const allEls = scope.querySelectorAll("span, a, div, p");
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
    const imgs = scope.querySelectorAll("img");
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
      const headerImgs = scope.querySelectorAll('img[width], img[style*="width"]');
      for (const img of headerImgs) {
        // Read the rect once; never read it again on this element.
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
      const headings = scope.querySelectorAll('h1, h2, [role="heading"], span[dir="auto"]');
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
    // Scope to header/profile area: Threads renders dozens of feed-card
    // links below the bio that would otherwise count as "links in bio".
    const allLinks = scope.querySelectorAll("a[href]");
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
  const target = tabName.toLowerCase();

  // Find clickable tab elements (the canonical, role-based selector path)
  const allTabs = document.querySelectorAll(
    'div[role="tablist"] div[role="tab"], div[role="tablist"] a, a[role="tab"]'
  );
  for (const tab of allTabs) {
    const text = (tab.textContent || "").trim().toLowerCase();
    if (text === target) {
      await humanClick(tab as HTMLElement);
      return true;
    }
  }

  // Fallback: find by text in the profile scope only, not the entire feed.
  // The previous version queried `'a, div[role="tab"], span'` document-wide
  // and forced a getBoundingClientRect read per candidate — on a populated
  // feed this was 2-3 ms × hundreds of nodes. Scoping cuts the candidate
  // set dramatically and the rect read short-circuits on text mismatch.
  const scope = getProfileScope();
  const candidates = scope.querySelectorAll('a, div[role="tab"], span');
  for (const el of candidates) {
    const text = (el.textContent || "").trim().toLowerCase();
    if (text !== target) continue; // cheap text check before forcing a reflow
    const rect = el.getBoundingClientRect();
    if (
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

// Signal when the followers list was found via a non-primary selector, so the
// operator can refresh the primary before Threads removes it entirely. The
// scroll path is now the ONLY way to fetch followers, so drift here is critical.
function reportScrollDrift(source: string): void {
  const rank = source === "dialog" ? 0 : source === "modal" ? 1 : source === "testid" ? 2 : 3;
  if (rank > 0) {
    reportDrift({ lookup: "followers-scroll-container", winningStrategy: source, rank });
  }
}

// Owner username from the current path (/@owner or /@owner/followers). Used to
// exclude the profile owner's own links when scoring scroll-container density.
function currentOwnerFromPath(): string | null {
  const m = location.pathname.match(/^\/@([\w.]+)/);
  return m ? m[1] : null;
}

// Is this href a *real* follower link — a clean "/@username", not the owner and
// not a sub-page like "/@owner/media"? Mirrors the filter scrollFetch applies,
// so container detection and link extraction agree on what counts.
export function isFollowerHref(href: string | null | undefined, owner: string | null): boolean {
  if (!href || !href.includes("/@")) return false;
  const pseudo = (href.split("/@").pop() || "").split("?")[0];
  if (!pseudo || pseudo.includes("/")) return false;
  if (owner && pseudo === owner) return false;
  return true;
}

// Nearest scrollable ancestor of a node: overflow scroll/auto that already
// overflows, OR a large overflow:hidden wrapper that overflows (common with
// React virtualized lists whose outer wrapper hides overflow and an inner
// spacer drives the scroll). Returns null if none within `maxDepth`.
function nearestScrollableAncestor(node: Element, maxDepth = 25): HTMLElement | null {
  let el: HTMLElement | null = node.parentElement;
  let depth = 0;
  while (el && el !== document.body && depth < maxDepth) {
    const oy = window.getComputedStyle(el).overflowY;
    const overflows = el.scrollHeight > el.clientHeight + 10;
    if ((oy === "scroll" || oy === "auto") && overflows) return el;
    if (oy === "hidden" && overflows && el.clientHeight > 200) return el;
    el = el.parentElement;
    depth++;
  }
  return null;
}

// Minimum distinct follower links a container must hold before we trust it as
// the list. Page chrome (nav, footer, suggested, owner header) is sparse (1-3);
// the real followers list is dense. Below this we fail so the pipeline retries
// on the dedicated /@user/followers page instead of marking the wrong element.
const MIN_CONTAINER_LINKS = 5;

export function markScrollContainer(): {
  ok: boolean;
  links: number;
  reason?: MarkScrollReason;
  source?: "dialog" | "modal" | "testid" | "page" | "global";
} {
  const onFollowersPage = SELECTORS.scroll.followersUrlPattern.test(location.pathname);
  const owner = currentOwnerFromPath();

  // Drift attribution: the most specific selector class that still matches.
  // "global" means the canonical modal anchors are gone — operator should refresh.
  const source: NonNullable<ReturnType<typeof markScrollContainer>["source"]> =
    document.querySelector(SELECTORS.scroll.dialogLinks) ? "dialog"
    : document.querySelector(SELECTORS.scroll.modalLinks) ? "modal"
    : document.querySelector(SELECTORS.scroll.testIdLinks) ? "testid"
    : onFollowersPage ? "page" : "global";

  // On the dedicated /followers page the document itself is the scroller — no
  // modal, no density guessing needed.
  if (onFollowersPage) {
    const root = (document.scrollingElement || document.documentElement) as HTMLElement;
    if (root) {
      root.setAttribute(SELECTORS.scroll.scrollableAttr, "true");
      const links = document.querySelectorAll('a[href*="/@"]').length;
      console.log(`[WFC] markScrollContainer: ok via dedicated followers page (${links} links)`);
      reportScrollDrift("page");
      return { ok: true, links, source: "page" };
    }
  }

  // DENSITY SELECTION: tally how many distinct *real* follower links each
  // scrollable ancestor contains, then mark the densest one. This locks onto the
  // followers list (dozens-to-hundreds of rows) and ignores the last stray "/@"
  // link in page chrome that the old "walk up from the last link" approach hit.
  const byContainer = new Map<HTMLElement, Set<string>>();
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href*="/@"]')) {
    const href = a.getAttribute("href");
    if (!isFollowerHref(href, owner)) continue;
    const sc = nearestScrollableAncestor(a);
    if (!sc) continue;
    let set = byContainer.get(sc);
    if (!set) { set = new Set<string>(); byContainer.set(sc, set); }
    set.add(href!);
  }

  let best: HTMLElement | null = null;
  let bestCount = 0;
  for (const [el, set] of byContainer) {
    if (set.size > bestCount || (set.size === bestCount && best !== null && el.scrollHeight > best.scrollHeight)) {
      best = el;
      bestCount = set.size;
    }
  }

  if (best && bestCount >= MIN_CONTAINER_LINKS) {
    best.setAttribute(SELECTORS.scroll.scrollableAttr, "true");
    console.log(`[WFC] markScrollContainer: ok via ${source} density (${bestCount} follower links)`);
    reportScrollDrift(source);
    return { ok: true, links: bestCount, source };
  }

  // Not enough density: a wrong/page-chrome scroller. Fail so the pipeline's
  // /@user/followers re-navigation fallback fires (deterministic page scroller).
  const reason: MarkScrollReason = byContainer.size > 0 ? "container_too_small" : "no_scrollable_parent";
  console.log(`[WFC] markScrollContainer: failed (${reason}, best=${bestCount} links, need ${MIN_CONTAINER_LINKS})`);
  return { ok: false, links: bestCount, reason };
}

let autoScrollId: ReturnType<typeof setInterval> | null = null;

/**
 * Advance the marked scroll container by ONE explicit jump.
 *
 * Driven from the awaited scrollFetch loop rather than a high-frequency
 * setInterval — the fetch runs in a HIDDEN (active:false) background tab where
 * Chrome clamps setInterval to ~1/s and pauses requestAnimationFrame, so a
 * 16ms timer barely moved the list. One synchronous jump per loop turn is
 * immune to that throttling. We also fire a `scroll` event and pull the last
 * row into view to wake observer-driven lazy loaders that won't otherwise tick
 * in an unpainted tab.
 *
 * Returns whether scrollTop actually advanced (false ⇒ the marked element is
 * not really scrollable, so the caller can bail and re-route).
 */
export function scrollStep(): { advanced: boolean; height: number } {
  const el = document.querySelector(
    `[${SELECTORS.scroll.scrollableAttr}="true"]`,
  ) as HTMLElement | null;
  if (!el) return { advanced: false, height: 0 };

  const before = el.scrollTop;
  el.scrollTop = el.scrollHeight; // jump to the bottom to force the next window
  try { el.dispatchEvent(new Event("scroll", { bubbles: true })); } catch { /* ignore */ }
  try { window.dispatchEvent(new Event("scroll")); } catch { /* ignore */ }
  try {
    const rows = el.querySelectorAll('a[href*="/@"]');
    (rows[rows.length - 1] as HTMLElement | undefined)?.scrollIntoView({ block: "end" });
  } catch { /* ignore — last row can be unmounted by virtualization mid-read */ }

  return { advanced: el.scrollTop > before, height: el.scrollHeight };
}

export function stopScroll(): void {
  // No interval is started anymore, but clear any legacy one defensively so the
  // STOP_CONTENT abort path stays correct.
  if (autoScrollId) {
    clearInterval(autoScrollId);
    autoScrollId = null;
  }
}

export function extractFollowerLinks(): string[] {
  // Prefer the marked scroller's subtree (set by markScrollContainer), but if it
  // yields implausibly few links (a wrong/over-narrow container), UNION in the
  // document-wide candidates so the real followers stay reachable even when
  // container detection is imperfect. scrollFetch filters out owner/sub-page
  // hrefs afterwards, so over-collecting here is harmless.
  const hrefs = new Set<string>();
  const collect = (nodes: ArrayLike<Element>): void => {
    for (let i = 0; i < nodes.length; i++) {
      const h = nodes[i].getAttribute("href");
      if (h) hrefs.add(h);
    }
  };

  const scroller = document.querySelector(`[${SELECTORS.scroll.scrollableAttr}="true"]`);
  if (scroller) collect(scroller.querySelectorAll('a[href*="/@"]'));

  if (hrefs.size < 3) {
    collect(document.querySelectorAll(SELECTORS.scroll.dialogLinks));
    collect(document.querySelectorAll(SELECTORS.scroll.modalLinks));
    collect(document.querySelectorAll('a[href*="/@"]'));
  }

  return Array.from(hrefs);
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
        // Primary "a[href*=followers]" failed; we matched via text — signal drift.
        reportDrift({ lookup: "followers-button", winningStrategy: "text-pattern", rank: 1 });
        await humanClick(el as HTMLElement);
        return true;
      }
    }
  }

  return false;
}
