"""
Scorer — 8-step pure scoring algorithm (0-100) + username heuristics + pre-scoring.

Zero network deps — 100% unit-testable.
Each scored profile gets a full score_breakdown for auditability.

Ported from V1 with identical logic + V2 enhancements.
"""

import asyncio
import json
import random
import re
from dataclasses import dataclass, field

from playwright.async_api import Page

from backend.core.config import settings
from backend.core.logger import log
from backend.engine.browser_manager import browser_manager
from backend.engine.fetcher import navigate_to_profile, RateLimitError


# ── Username pattern detection ───────────────────────────────────────────────

# Patterns that indicate bot/fake usernames
_BOT_USERNAME_PATTERNS = [
    # Mostly digits: user738291637
    (re.compile(r"^[a-z]{1,6}\d{6,}$", re.I), 20, "bot_digits"),
    # Random string ending with many digits: sara847362
    (re.compile(r"^[a-z]{2,8}\d{5,}$", re.I), 15, "name+digits"),
    # Underscore-heavy: __x_x__y__
    (re.compile(r"^_.*_.*_.*_"), 10, "underscore_heavy"),
    # All digits except maybe 1-2 letters
    (re.compile(r"^\d[\d_]{8,}$"), 25, "all_digits"),
    # Pattern: word.word.digits (common bot pattern)
    (re.compile(r"^[a-z]+\.[a-z]+\.\d{3,}$", re.I), 15, "dot_dot_num"),
    # Very long usernames (>25 chars)
    (re.compile(r"^.{26,}$"), 10, "very_long"),
    # Random consonant clusters (no vowels in 5+ char stretch)
    (re.compile(r"[^aeiou_.\d]{6,}", re.I), 10, "no_vowels"),
]


def score_username(username: str) -> tuple[int, list[str]]:
    """Analyse username for bot-like patterns. Returns (bonus, details)."""
    bonus = 0
    details: list[str] = []

    for pattern, points, label in _BOT_USERNAME_PATTERNS:
        if pattern.search(username):
            bonus += points
            details.append(f"@pattern({label}) +{points}")

    # Digit ratio: if >50% of username is digits
    digit_count = sum(1 for c in username if c.isdigit())
    if len(username) > 4 and digit_count / len(username) > 0.5:
        bonus += 15
        details.append(f"@digit_ratio({digit_count}/{len(username)}) +15")

    return min(bonus, 30), details  # Cap at +30 to avoid over-penalizing


def pre_score_from_metadata(username: str, follower_count: int | None,
                            is_private: bool, full_name: str | None,
                            has_profile_pic: bool) -> tuple[int | None, list[str]]:
    """Pre-score using only metadata from fetch phase (no page visit needed).
    Returns (score, details) or (None, []) if inconclusive.

    Only returns a score for OBVIOUS cases (>85 or <20).
    Borderline cases return None → need full scan.
    """
    score = 0
    details: list[str] = []

    # Username patterns
    u_bonus, u_details = score_username(username)
    score += u_bonus
    details.extend(u_details)

    # Follower count
    if follower_count is not None:
        if follower_count == 0:
            score += 15
            details.append(f"pre:0abn +15")
        elif follower_count <= 10:
            score += 10
            details.append(f"pre:{follower_count}abn +10")
        elif follower_count >= 500:
            score -= 15
            details.append(f"pre:{follower_count}abn -15")
        elif follower_count >= 100:
            score -= 10
            details.append(f"pre:{follower_count}abn -10")

    # No profile pic
    if not has_profile_pic:
        score += 20
        details.append("pre:!pic +20")
    else:
        score -= 5
        details.append("pre:pic -5")

    # Full name
    if full_name and len(full_name) >= 3:
        score -= 5
        details.append("pre:name -5")
    elif not full_name:
        score += 10
        details.append("pre:!name +10")

    # Private with no name and no pic → suspicious
    if is_private and not full_name and not has_profile_pic:
        score += 15
        details.append("pre:private(!name,!pic) +15")

    # Decision: only return score for obvious cases
    score = max(0, min(100, score))
    if score >= 75:
        return score, details  # Obvious fake
    if score <= 15:
        return score, details  # Obviously legit

    return None, details  # Inconclusive → needs full scan

# ── Profile data extraction ───────────────────────────────────────────────────

_JS_EXTRACT_PROFILE = r"""
(username) => {
    const result = {
        follower_count: null, has_real_pic: false, has_full_name: false,
        has_ig_link: false, has_bio: false, is_verified: false,
        bio_text: '', full_name: '', has_link_in_bio: false,
        has_external_link: false, looks_private: false,
    };

    // ── Follower count ──
    try {
        const allEls = document.querySelectorAll('span, a, div, p');
        for (const el of allEls) {
            if (el.children.length > 3) continue;
            const t = (el.textContent || '').trim();
            const m = t.match(/^([\d][\d,. \u00a0\u202f]*[KkMm]?)\s*(followers|abonnés)$/i);
            if (m) {
                let cleaned = m[1].trim().replace(/[\s\u00a0\u202f]/g, '');
                const suffix = cleaned.slice(-1).toUpperCase();
                if (suffix === 'K')
                    result.follower_count = Math.round(
                        parseFloat(cleaned.slice(0,-1).replace(',','.')) * 1000);
                else if (suffix === 'M')
                    result.follower_count = Math.round(
                        parseFloat(cleaned.slice(0,-1).replace(',','.')) * 1000000);
                else
                    result.follower_count = parseInt(
                        cleaned.replace(/[^\d]/g,''), 10) || 0;
                break;
            }
        }
    } catch(e) {}

    // ── Profile picture ──
    try {
        const imgs = document.querySelectorAll('img');
        for (const img of imgs) {
            const src = img.src || '';
            const alt = (img.alt || '').toLowerCase();
            const w = img.naturalWidth || img.width || 0;
            if ((alt.includes('photo') || alt.includes('profile')
                 || alt.includes('avatar') || alt.includes(username.toLowerCase()))
                && w >= 40) {
                result.has_real_pic = !src.includes('default')
                    && !src.includes('empty')
                    && !src.includes('placeholder')
                    && !src.includes('/44884218_345');
                break;
            }
        }
        if (!result.has_real_pic) {
            const headerImgs = document.querySelectorAll('img[width], img[style*="width"]');
            for (const img of headerImgs) {
                const r = img.getBoundingClientRect();
                if (r.width >= 60 && r.width <= 200 && r.top < 400) {
                    const src = img.src || '';
                    result.has_real_pic = !src.includes('default')
                        && !src.includes('empty')
                        && !src.includes('/44884218_345')
                        && src.length > 20;
                    break;
                }
            }
        }
    } catch(e) {}

    // ── Full name ──
    try {
        const ogTitle = document.querySelector('meta[property="og:title"]');
        if (ogTitle) {
            const m = (ogTitle.content || '').match(/^(.+?)\s*\(@/);
            if (m) {
                result.full_name = m[1].trim();
                result.has_full_name = result.full_name.length >= 3
                    && result.full_name !== username;
            }
        }
        if (!result.has_full_name) {
            const headings = document.querySelectorAll(
                'h1, h2, [role="heading"], span[dir="auto"]');
            for (const h of headings) {
                const t = (h.textContent || '').trim();
                if (t.length >= 3 && t.length < 60
                    && t !== username && !t.match(/^\d/)) {
                    result.full_name = t;
                    result.has_full_name = true;
                    break;
                }
            }
        }
    } catch(e) {}

    // ── Instagram link ──
    try {
        result.has_ig_link = !!document.querySelector('a[href*="instagram.com"]');
    } catch(e) {}

    // ── Bio ──
    try {
        const metaDesc = document.querySelector('meta[name="description"]');
        if (metaDesc) {
            let bio = metaDesc.content || '';
            bio = bio.replace(/[\d,.\s]*\s*(followers?|abonnés|following|replies).*/gi, '').trim();
            bio = bio.replace(/^.*?-\s*/, '').trim();
            result.bio_text = bio;
            result.has_bio = bio.length >= 5;
        }
    } catch(e) {}

    // ── Link in bio ──
    try {
        // Check for external links near bio area (not IG, not Threads internal)
        const allLinks = document.querySelectorAll('a[href]');
        for (const a of allLinks) {
            const href = (a.href || '').toLowerCase();
            const text = (a.textContent || '').trim();
            // Skip internal Threads links, IG link, and navigation
            if (href.includes('threads.net') || href.includes('instagram.com')
                || href.includes('javascript:') || href === '#'
                || href.includes('/login') || href.includes('/signup'))
                continue;
            // Must be a real external URL with visible text
            if ((href.startsWith('http://') || href.startsWith('https://'))
                && text.length > 3 && a.offsetHeight > 0) {
                const r = a.getBoundingClientRect();
                if (r.top < 600) {  // above the fold, near profile header
                    result.has_link_in_bio = true;
                    result.has_external_link = true;
                    break;
                }
            }
        }
        // Also check bio text for URLs
        if (!result.has_link_in_bio && result.bio_text) {
            result.has_link_in_bio = /https?:\/\/\S{5,}/.test(result.bio_text);
        }
    } catch(e) {}

    // ── Private detection (heuristic) ──
    try {
        // If no articles/posts and no Threads/Replies tabs visible => probably private
        const articles = document.querySelectorAll('article, [data-pressable-container]');
        const tabs = document.querySelectorAll('[role="tab"], [role="tablist"]');
        const hasFollowBtn = !!document.querySelector(
            'button, div[role="button"]');
        const bodyText = (document.body?.innerText || '').toLowerCase();
        const hasPrivateText = /account is private|compte est priv|profil priv/.test(bodyText);
        const hasNoContent = articles.length === 0
            && !bodyText.includes('aucun thread')
            && !bodyText.includes('no threads yet')
            && !bodyText.includes("hasn't posted")
            && !bodyText.includes("n'a pas encore publi");
        const hasNoTabs = tabs.length === 0;
        // Private if: explicit text OR (no content + no tabs + profile has loaded)
        if (hasPrivateText || (hasNoContent && hasNoTabs && result.follower_count !== null)) {
            result.looks_private = true;
        }
    } catch(e) {}

    // ── Verified ──
    try {
        result.is_verified = !!document.querySelector(
            '[data-testid="verified-badge"], '
            + 'svg[aria-label*="Verified"], '
            + 'svg[aria-label*="vérifié"]');
    } catch(e) {}

    return result;
}
"""

_JS_COUNT_POSTS = r"""
() => {
    const articles = document.querySelectorAll('article');
    let topLevel = 0;
    for (const a of articles) {
        if (!a.closest('article')?.closest('article') || a.closest('article') === a)
            topLevel++;
    }
    if (topLevel === 0)
        topLevel = document.querySelectorAll('[data-pressable-container]').length;

    // Timestamps
    const times = document.querySelectorAll('time[datetime]');
    let allRecent = times.length > 0;
    const now = Date.now();
    const h72 = 72 * 3600 * 1000;
    for (const t of times) {
        const dt = new Date(t.getAttribute('datetime'));
        if (!isNaN(dt.getTime()) && (now - dt.getTime()) > h72)
            allRecent = false;
    }

    // Duplicate detection
    let dupeRatio = 0;
    if (articles.length >= 2) {
        const texts = Array.from(articles)
            .map(a => (a.innerText || '').trim().substring(0, 120).toLowerCase())
            .filter(t => t.length > 20);
        if (texts.length >= 2) {
            const ref = texts[0];
            let dupes = 0;
            for (let i = 1; i < texts.length; i++) {
                let shared = 0;
                const minLen = Math.min(ref.length, texts[i].length);
                for (let j = 0; j < minLen; j++)
                    if (ref[j] === texts[i][j]) shared++;
                if (shared / minLen > 0.6) dupes++;
            }
            dupeRatio = dupes / (texts.length - 1);
        }
    }

    // Spam keywords
    const body = (document.body?.innerText || '').toLowerCase();
    const spamPatterns = [
        /whatsapp|telegram|signal/,
        /\b0\d{9,}\b/, /\+\d{10,}/,
        /envie de faire connaissance/,
        /click.*link.*bio/i, /dm.*for.*promo/i,
        /follow.*for.*follow/i, /check.*my.*profile/i,
    ];
    const hasSpam = spamPatterns.some(p => p.test(body));

    return {
        count: topLevel,
        all_recent: allRecent && topLevel > 0,
        duplicate_ratio: dupeRatio,
        has_spam_keywords: hasSpam,
    };
}
"""

_JS_CHECK_REPLIES = r"""
(username) => {
    const body = document.body?.innerText || '';
    const emptyPatterns = [
        /aucune r[ée]ponse/i, /no replies yet/i,
        /nothing here yet/i, /hasn.t replied/i,
        /pas encore de r[ée]ponse/i, /rien pour l.instant/i,
    ];
    for (const pat of emptyPatterns)
        if (pat.test(body)) return {has_replies: false, final: true};

    const articles = document.querySelectorAll('article, [data-pressable-container]');
    if (articles.length > 0) return {has_replies: true, final: true};

    const timeEls = document.querySelectorAll('time[datetime]');
    if (timeEls.length > 0) return {has_replies: true, final: true};

    if (username) {
        const matches = (body.match(new RegExp(username, 'gi')) || []).length;
        if (matches >= 2) return {has_replies: true, final: true};
    }

    const profileLinks = document.querySelectorAll('a[href^="/@"]');
    let below = 0;
    for (const a of profileLinks)
        if (a.getBoundingClientRect().top > 350) below++;
    if (below >= 2) return {has_replies: true, final: true};

    return {has_replies: false, final: false};
}
"""


# ── Profile data extraction ───────────────────────────────────────────────────

@dataclass
class ProfileData:
    username: str
    not_found: bool = False
    is_private: bool = False
    is_verified: bool = False
    follower_count: int | None = None
    post_count: int = 0
    has_bio: bool = False
    has_replies: bool = False
    has_real_pic: bool = False
    has_full_name: bool = False
    has_ig_link: bool = False
    has_link_in_bio: bool = False
    full_name: str = ""
    all_posts_recent: bool = False
    duplicate_ratio: float = 0.0
    has_spam_keywords: bool = False
    error: str | None = None


async def extract_profile(page: Page, username: str) -> ProfileData:
    """Navigate to a profile and extract all scoring-relevant data."""
    data = ProfileData(username=username)

    # Navigate
    try:
        await page.goto(
            f"https://www.threads.net/@{username}",
            timeout=12000, wait_until="domcontentloaded",
        )
    except Exception as e:
        err = str(e)
        if "ERR_HTTP_RESPONSE_CODE_FAILURE" in err:
            body = await _safe_body(page)
            if _is_429(body):
                data.error = "429_RATE_LIMIT"
                data.not_found = True
                return data
        data.not_found = True
        return data

    await browser_manager.wait_for_profile(page, timeout_ms=5000)
    await asyncio.sleep(random.uniform(0.3, 0.6))

    # Read body text
    try:
        full_text = await asyncio.wait_for(page.inner_text("body"), timeout=5.0)
    except asyncio.TimeoutError:
        full_text = await page.evaluate("() => document.body?.innerText || ''") or ""

    # Check 429
    if len(full_text) < 500 and _is_429(full_text):
        data.error = "429_RATE_LIMIT"
        data.not_found = True
        return data

    # Check not found
    if re.search(r"not found|not available|n'est pas disponible"
                 r"|page isn.t available|page introuvable",
                 full_text, re.IGNORECASE):
        data.not_found = True
        return data

    # Private?
    data.is_private = bool(re.search(
        r"account is private|compte est priv[ée]|profil priv",
        full_text, re.IGNORECASE))

    # JS extraction (follower count, pic, name, bio, links, etc.)
    try:
        info = await page.evaluate(_JS_EXTRACT_PROFILE, username)
        if info:
            data.follower_count = info.get("follower_count")
            data.has_real_pic = info.get("has_real_pic", False)
            data.has_full_name = info.get("has_full_name", False)
            data.full_name = info.get("full_name", "")
            data.has_ig_link = info.get("has_ig_link", False)
            data.has_bio = info.get("has_bio", False)
            data.has_link_in_bio = info.get("has_link_in_bio", False)
            data.is_verified = info.get("is_verified", False)
            # Heuristic private detection (when user follows the account)
            if not data.is_private and info.get("looks_private", False):
                data.is_private = True
    except Exception:
        pass

    # Bio fallback from header
    if not data.has_bio:
        try:
            header = await asyncio.wait_for(page.inner_text("header"), timeout=3.0)
            bio = re.sub(r'@[\w\.]+|\d+\s*(followers|abonnés)', '',
                         header, flags=re.IGNORECASE).strip()
            data.has_bio = len(bio) >= 10
        except Exception:
            pass

    # Posts (only for public accounts)
    if not data.is_private:
        threads_empty = bool(re.search(
            r"aucun thread|no threads yet|nothing here yet"
            r"|hasn.t posted|n.a pas encore publi",
            full_text, re.IGNORECASE))

        if threads_empty:
            data.post_count = 0
        else:
            try:
                post_info = await page.evaluate(_JS_COUNT_POSTS)
                if post_info:
                    data.post_count = post_info.get("count", 0)
                    data.all_posts_recent = post_info.get("all_recent", False)
                    data.duplicate_ratio = post_info.get("duplicate_ratio", 0)
                    data.has_spam_keywords = post_info.get("has_spam_keywords", False)
            except Exception:
                pass

        # Replies tab
        replies_clicked = await _click_replies_tab(page)
        if replies_clicked:
            for _ in range(5):
                await asyncio.sleep(1.5)
                try:
                    reply_info = await page.evaluate(_JS_CHECK_REPLIES, username)
                    if reply_info and reply_info.get("final"):
                        data.has_replies = reply_info.get("has_replies", False)
                        break
                except Exception:
                    pass

    return data


async def _click_replies_tab(page: Page) -> bool:
    """Click the Replies tab."""
    for text in ["Réponses", "Replies", "réponses", "replies"]:
        try:
            tab = page.get_by_text(text, exact=True).first
            if await asyncio.wait_for(tab.is_visible(), timeout=2.0):
                await tab.click()
                return True
        except Exception:
            continue

    # JS fallback
    try:
        clicked = await page.evaluate(r"""
        () => {
            const candidates = document.querySelectorAll(
                '[role="tab"], [role="tablist"] > *, a, div[class]');
            for (const el of candidates) {
                const t = (el.textContent || '').trim().toLowerCase();
                if (t === 'réponses' || t === 'replies') { el.click(); return true; }
            }
            return false;
        }
        """)
        return bool(clicked)
    except Exception:
        return False


async def _safe_body(page: Page) -> str:
    try:
        return await page.evaluate(
            "() => (document.body?.innerText || '').substring(0, 300)")
    except Exception:
        return ""


def _is_429(body: str) -> bool:
    lo = body.lower()
    return (("429" in body and ("cette page ne fonctionne pas" in lo
                                or "this page isn't working" in lo))
            or "too many requests" in lo)


# ── Pure scoring function ─────────────────────────────────────────────────────

def score_profile(data: ProfileData, threshold: int = 0,
                  strict_private: bool = False) -> tuple[int, list[str]]:
    """Score a profile 0-100. Higher = more likely fake.
    Returns (score, breakdown_details)."""

    if data.not_found:
        return -1, ["Not found"]
    if data.error and data.error != "429_RATE_LIMIT":
        return -1, [data.error[:40]]
    if data.is_verified:
        return 0, ["Verified"]

    score = 0
    details: list[str] = []
    fc = data.follower_count

    # ── Step 0: Username pattern ──────────────────────────────────────
    u_bonus, u_details = score_username(data.username)
    if u_bonus > 0:
        score += u_bonus
        details.extend(u_details)

    # ── Step 1: Follower count ────────────────────────────────────────
    if fc is not None:
        if fc == 0:
            score += 15; details.append("0abn +15")
        elif fc <= 10:
            score += 10; details.append(f"{fc}abn +10")
        elif fc <= 50:
            score += 5; details.append(f"{fc}abn +5")
        elif fc >= 500:
            score -= 10; details.append(f"{fc}abn -10")
        elif fc >= 100:
            score -= 5; details.append(f"{fc}abn -5")
    else:
        score += 5; details.append("abn? +5")

    # ── Step 2: Posts ─────────────────────────────────────────────────
    has_posts = False
    is_spambot = False

    if not data.is_private:
        if data.post_count == 0:
            score += 35; details.append("0post +35")
        elif data.post_count <= 2:
            score += 20; details.append(f"{data.post_count}post +20")
            if data.all_posts_recent:
                score += 20; details.append("spam(<72h) +20")
        elif data.post_count <= 4:
            score += 10; details.append(f"{data.post_count}post +10")
            if data.all_posts_recent:
                score += 20; details.append("spam(<72h) +20")
        elif data.post_count >= 5:
            has_posts = True
            score -= 15; details.append(f"{data.post_count}post -15")

        # Step 2b: Spam detection
        if data.duplicate_ratio >= 0.5 and data.post_count >= 3:
            is_spambot = True
            if has_posts:
                score += 15; details.append("dupes! cancel post")
            score += 40; details.append(f"spam_dupes({data.duplicate_ratio:.0%}) +40")

        if data.has_spam_keywords:
            score += 25; details.append("spam_keywords +25")
            is_spambot = True

    # ── Step 3: Replies ───────────────────────────────────────────────
    if not data.is_private:
        if not data.has_replies:
            score += 25; details.append("0rep +25")
        elif is_spambot:
            score += 10; details.append("rep_spam +10")
        elif has_posts:
            score -= 15; details.append("rep+posts -15")
        else:
            score += 10; details.append("rep_no_post +10")

    # ── Step 4: Combos ────────────────────────────────────────────────
    if not data.is_private:
        if data.post_count == 0 and not data.has_replies:
            score += 20; details.append("combo(0p+0r) +20")
        if data.post_count == 0 and data.has_replies:
            score += 10; details.append("spammer(0p+rep) +10")
        if (1 <= data.post_count <= 4 and not data.has_replies
                and not data.has_bio):
            score += 10; details.append("inactive +10")

    # ── Step 5: Bio ───────────────────────────────────────────────────
    zero_activity = (data.post_count == 0 and not data.has_replies
                     and not data.is_private)
    if data.has_bio:
        if zero_activity:
            score -= 5; details.append("bio(inactive) -5")
        else:
            score -= 10; details.append("bio -10")
    else:
        score += 15; details.append("!bio +15")

    # ── Step 6: Private ───────────────────────────────────────────────
    if data.is_private:
        if strict_private:
            score += 10; details.append("private +10")
        else:
            # Count legitimacy signals
            legit = sum([data.has_bio, data.has_link_in_bio,
                         data.has_real_pic, data.has_ig_link])
            if legit >= 3:
                # Bio + link + pic/IG = almost certainly real
                score -= 15; details.append(f"private(legit:{legit}sig) -15")
            elif legit >= 2:
                score -= 5; details.append(f"private(semi:{legit}sig) -5")
            elif fc is not None and fc < 10:
                score += 40; details.append("private(<10abn) +40")
            elif fc is not None and fc < 30:
                if not data.has_bio and not data.has_real_pic:
                    score += 30; details.append("private(<30,!bio,!pic) +30")
                elif not data.has_bio or not data.has_real_pic:
                    score += 20; details.append("private(<30,partial) +20")
                else:
                    score += 5; details.append("private(<30,bio+pic) +5")
            else:
                score += 5; details.append("private(30+) +5")

    # ── Step 7: Full name ─────────────────────────────────────────────
    if data.has_full_name:
        score -= 5; details.append("name -5")

    # ── Step 8: Legitimacy signals (links) ────────────────────────────
    if data.has_link_in_bio:
        score -= 15; details.append("link_bio -15")
    if data.has_ig_link:
        score -= 10; details.append("ig_link -10")

    return max(0, min(100, score)), details
