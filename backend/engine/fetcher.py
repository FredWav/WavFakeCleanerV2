"""
Fetcher — retrieves the follower list from Threads.

Strategy:
1. Try API pagination (fast, reliable when it works)
2. Fallback to scroll-based DOM scraping

Ported from V1 with cleaner architecture.
"""

import asyncio
import random
import re
import time
from datetime import datetime, timezone

from playwright.async_api import Page

from backend.core.logger import log
from backend.engine.browser_manager import browser_manager
from backend.engine.pacer import isleep

# ── Rate limit error ──────────────────────────────────────────────────────────

class RateLimitError(Exception):
    """Raised when Threads returns HTTP 429."""
    pass


# ── JS snippets for scroll-based fetch ────────────────────────────────────────

_JS_RESOLVE_USER_ID = r"""
async (username) => {
    const csrf = (document.cookie.match(/csrftoken=([^;]+)/)||[])[1]||'';
    const headers = {
        'X-IG-App-ID': '238260118697367',
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
    };
    if (csrf) headers['X-CSRFToken'] = csrf;
    const endpoints = [
        `https://www.threads.net/api/v1/users/web_profile_info/?username=${username}`,
        `https://www.threads.net/api/v1/users/search/?q=${username}`,
    ];
    for (const url of endpoints) {
        try {
            const r = await fetch(url, { credentials: 'include', headers });
            if (!r.ok) continue;
            const j = await r.json();
            const uid = j?.data?.user?.id || j?.data?.user?.pk
                || j?.user?.pk || j?.user?.id || j?.data?.user?.pk_id;
            if (uid) return String(uid);
            const users = j?.users || [];
            const match = users.find(u => u.username === username);
            if (match) return String(match.pk || match.id);
        } catch(e) {}
    }
    try {
        const scripts = document.querySelectorAll('script[type="application/json"]');
        for (const s of scripts) {
            const text = s.textContent || '';
            if (text.includes(username)) {
                const pkM = text.match(/"pk":"?(\d+)"?/);
                if (pkM) return pkM[1];
                const idM = text.match(/"user_id":"?(\d+)"?/);
                if (idM) return idM[1];
            }
        }
    } catch(e) {}
    return null;
}
"""

_JS_FETCH_PAGE = r"""
async ([url, csrf]) => {
    try {
        const h = {
            'X-IG-App-ID': '238260118697367',
            'Accept': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
        };
        if (csrf) h['X-CSRFToken'] = csrf;
        else {
            const m = document.cookie.match(/csrftoken=([^;]+)/);
            if (m) h['X-CSRFToken'] = m[1];
        }
        const r = await fetch(url, { credentials: 'include', headers: h });
        if (!r.ok) return {http_error: r.status};
        return await r.json();
    } catch(e) { return {error: e.toString()}; }
}
"""

_JS_MARK_CONTAINER = r"""
() => {
    let links = Array.from(
        document.querySelectorAll('div[role="dialog"] a[href*="/@"]')
    );
    if (!links.length) {
        links = Array.from(document.querySelectorAll('a[href*="/@"]'))
            .filter(a => /^\/@[\w.]+$/.test(a.getAttribute('href') || ''));
    }
    if (!links.length) return {ok: false};
    let el = links[links.length - 1].parentElement;
    while (el && el !== document.body) {
        const oy = window.getComputedStyle(el).overflowY;
        if ((oy === 'scroll' || oy === 'auto')
            && el.scrollHeight > el.clientHeight + 10) {
            el.setAttribute('data-autoscroll', 'true');
            return {ok: true, links: links.length};
        }
        el = el.parentElement;
    }
    return {ok: false, links: links.length};
}
"""

_JS_START_SCROLL = """(speed) => {
    const el = document.querySelector('[data-autoscroll="true"]');
    if (!el) return;
    if (window._autoScrollId) clearInterval(window._autoScrollId);
    window._autoScrollId = setInterval(() => { el.scrollTop += speed; }, 16);
}"""

_JS_STOP_SCROLL = """() => {
    if (window._autoScrollId) {
        clearInterval(window._autoScrollId);
        window._autoScrollId = null;
    }
}"""

_JS_EXTRACT_LINKS = r"""
() => {
    let links = document.querySelectorAll('div[role="dialog"] a[href*="/@"]');
    if (!links.length) {
        const scroller = document.querySelector('[data-autoscroll="true"]');
        if (scroller) links = scroller.querySelectorAll('a[href*="/@"]');
    }
    if (!links.length) links = document.querySelectorAll('a[href*="/@"]');
    return Array.from(links, a => a.getAttribute('href') || '');
}
"""


# ── Navigation helper ─────────────────────────────────────────────────────────

async def navigate_to_profile(page: Page, username: str,
                              timeout: int = 15000) -> bool:
    """Navigate to a Threads profile. Returns True on success.
    Raises RateLimitError on HTTP 429."""
    url = f"https://www.threads.net/@{username}"

    for attempt in range(3):
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=timeout)
            await browser_manager.wait_for_profile(page)
            await asyncio.sleep(1.5)
        except Exception as e:
            err = str(e)
            if "ERR_HTTP_RESPONSE_CODE_FAILURE" in err:
                body = await _safe_body(page)
                if _is_429(body):
                    raise RateLimitError("HTTP 429")
            if attempt == 2:
                return False
            continue

        # Check for 429 in loaded page
        body = await _safe_body(page)
        if _is_429(body):
            raise RateLimitError("HTTP 429 in page body")

        # Verify we're on the profile (not a post page)
        cur = page.url
        if f"/@{username}" in cur.lower() and "/post/" not in cur and "/p/" not in cur:
            return True

        # Wrong page — retry with JS redirect
        try:
            await page.evaluate(f"() => window.location.href = '{url}'")
            await asyncio.sleep(3)
            await browser_manager.wait_for_profile(page)
            cur = page.url
            if f"/@{username}" in cur.lower() and "/post/" not in cur:
                return True
        except Exception:
            pass

    return False


async def _safe_body(page: Page, max_len: int = 300) -> str:
    try:
        return await page.evaluate(
            f"() => (document.body?.innerText || '').substring(0, {max_len})")
    except Exception:
        return ""


def _is_429(body: str) -> bool:
    body_lower = body.lower()
    has_429 = "429" in body
    has_error_page = ("cette page ne fonctionne pas" in body_lower
                      or "this page isn't working" in body_lower)
    has_too_many = "too many requests" in body_lower
    return (has_429 and has_error_page) or has_too_many


# ── API-based fetch ───────────────────────────────────────────────────────────

async def fetch_via_api(
    page: Page,
    username: str,
    stop_event: asyncio.Event,
    on_page: callable = None,
) -> dict[str, dict] | None:
    """Fetch followers via internal API pagination.
    Returns dict of {username: metadata} or None if API unavailable."""

    log.info("fetch", "Trying API fetch...")

    # Resolve user_id
    user_id = await page.evaluate(_JS_RESOLVE_USER_ID, username)
    if not user_id:
        log.warning("fetch", "user_id not found via API")
        return None

    log.info("fetch", f"user_id={user_id}")

    # Get CSRF token
    csrf = await page.evaluate(
        "() => (document.cookie.match(/csrftoken=([^;]+)/)||[])[1]||''")

    # Test first page
    url = (f"https://www.threads.net/api/v1/friendships/{user_id}/followers/"
           f"?count=50&search_surface=follow_list_page")
    first = await page.evaluate(_JS_FETCH_PAGE, [url, csrf])

    if not first or "error" in first or "http_error" in first:
        log.warning("fetch", f"API test failed: {first}")
        return None

    users = first.get("users", [])
    if not users:
        log.warning("fetch", "API returned 0 users")
        return None

    log.info("fetch", f"API OK — {len(users)} first followers")

    # Paginate
    collected: dict[str, dict] = {}
    for u in users:
        pseudo = (u.get("username") or "").strip()
        if pseudo and pseudo != username:
            collected[pseudo] = _extract_api_meta(u)

    if on_page:
        on_page(1, len(collected))

    max_id = first.get("next_max_id")
    page_num = 1
    errors = 0

    while max_id and not stop_event.is_set():
        page_num += 1
        await isleep(random.uniform(0.8, 1.5 + page_num * 0.02), stop_event)
        if stop_event.is_set():
            break

        cursor_url = f"{url}&max_id={max_id}"
        result = await page.evaluate(_JS_FETCH_PAGE, [cursor_url, csrf])

        if not result or "error" in result:
            errors += 1
            if errors >= 3:
                break
            await isleep(random.uniform(3, 6), stop_event)
            continue

        if "http_error" in result:
            status = result["http_error"]
            if status == 429:
                pause = random.uniform(60, 120)
                log.warning("fetch", f"429 — pausing {pause:.0f}s")
                await isleep(pause, stop_event)
                continue
            elif status in (401, 403):
                log.error("fetch", f"Auth error {status}")
                break
            errors += 1
            if errors >= 3:
                break
            continue

        errors = 0
        for u in result.get("users", []):
            pseudo = (u.get("username") or "").strip()
            if pseudo and pseudo != username:
                collected[pseudo] = _extract_api_meta(u)

        if on_page:
            on_page(page_num, len(collected))

        max_id = result.get("next_max_id")

    log.info("fetch", f"API done: {len(collected)} followers collected")
    return collected


def _extract_api_meta(u: dict) -> dict:
    return {
        "follower_count": u.get("follower_count"),
        "is_verified": u.get("is_verified", False),
        "full_name": (u.get("full_name") or "").strip(),
        "is_private": u.get("is_private", False),
    }


# ── Scroll-based fetch ───────────────────────────────────────────────────────

async def fetch_via_scroll(
    page: Page,
    username: str,
    stop_event: asyncio.Event,
    scroll_speed: int = 120,
    max_followers: int = 5000,
    max_duration: int = 1800,
    on_progress: callable = None,
) -> set[str] | None:
    """Fetch followers by scrolling the followers dialog.
    Returns set of usernames or None on failure."""

    # Navigate to profile
    if not await navigate_to_profile(page, username):
        log.error("fetch", "Could not navigate to profile")
        return None

    if stop_event.is_set():
        return None

    # Click followers button
    clicked = await _click_followers_button(page)
    if not clicked:
        log.error("fetch", "Followers button not found")
        return None

    await isleep(4, stop_event)
    if stop_event.is_set():
        return None

    # Find scrollable container
    container_found = False
    for attempt in range(8):
        if stop_event.is_set():
            break
        mark = await page.evaluate(_JS_MARK_CONTAINER)
        if mark and isinstance(mark, dict) and mark.get("ok"):
            log.info("fetch", f"Container found: {mark.get('links', 0)} links")
            container_found = True
            break
        await isleep(2, stop_event)

    if not container_found:
        log.error("fetch", "Scrollable container not found")
        return None

    # Scroll and collect
    await page.evaluate(_JS_START_SCROLL, scroll_speed)
    pseudos: set[str] = set()
    last_count = 0
    no_change = 0
    start_time = time.time()

    while not stop_event.is_set():
        elapsed = time.time() - start_time
        if elapsed > max_duration:
            log.info("fetch", f"Max duration ({max_duration}s) reached")
            break
        if len(pseudos) >= max_followers:
            log.info("fetch", f"Max followers ({max_followers}) reached")
            break

        await isleep(0.5, stop_event)
        if stop_event.is_set():
            break

        # Extract links
        try:
            hrefs = await page.evaluate(_JS_EXTRACT_LINKS)
            for href in hrefs:
                pseudo = href.split("/@")[-1].strip("/")
                if (pseudo and "?" not in pseudo
                        and "/" not in pseudo and pseudo != username):
                    pseudos.add(pseudo)
        except Exception:
            pass

        loaded = len(pseudos)
        if on_progress and loaded % 100 < 5 and loaded > 0:
            on_progress(loaded)

        if loaded == last_count:
            no_change += 1
        else:
            no_change = 0
            last_count = loaded

        if no_change >= 6:
            log.info("fetch", f"Stall after {no_change} cycles ({loaded} loaded)")
            break

        # Pause scroll briefly to let DOM catch up
        await page.evaluate(_JS_STOP_SCROLL)
        await isleep(1.2, stop_event)
        if stop_event.is_set():
            break
        await page.evaluate(_JS_START_SCROLL, scroll_speed)

    await page.evaluate(_JS_STOP_SCROLL)
    log.info("fetch", f"Scroll done: {len(pseudos)} followers in "
             f"{int(time.time() - start_time)}s")
    return pseudos


async def _click_followers_button(page: Page) -> bool:
    """Click the followers count button/link to open the followers dialog."""

    # Method 1: <a> with href containing "followers"
    try:
        el = page.locator("a[href*='followers']").first
        if await asyncio.wait_for(el.is_visible(), timeout=2.0):
            await el.click()
            return True
    except Exception:
        pass

    # Method 2: JS — find element with exactly "X followers" or "X abonnés"
    try:
        clicked = await page.evaluate(r"""
        () => {
            const candidates = document.querySelectorAll('a, span, header *');
            for (const el of candidates) {
                const t = (el.textContent || '').trim();
                if (/^\d[\d,.\s\u00a0\u202fKkMm]*\s*(followers|abonnés)$/i.test(t)) {
                    const r = el.getBoundingClientRect();
                    if (r.height < 50) { el.click(); return true; }
                }
            }
            return false;
        }
        """)
        if clicked:
            return True
    except Exception:
        pass

    # Method 3: Playwright get_by_text with strict pattern
    try:
        btn = page.get_by_text(
            re.compile(r"^\d[\d,.\s]*\s*(abonnés|followers)$", re.IGNORECASE)
        ).first
        if await asyncio.wait_for(btn.is_visible(), timeout=2.0):
            await btn.click()
            return True
    except Exception:
        pass

    return False
