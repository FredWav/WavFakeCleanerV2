"""
Cleaner — auto-remove or block fake followers.

Three-step process per profile:
1. Navigate to profile
2. Click ⋯ (three dots menu)
3. Click "Supprimer follower" / "Remove follower" (or "Bloquer" fallback)
4. Confirm the action

Ported from V1 with cleaner architecture.
"""

import asyncio
import re

from playwright.async_api import Page

from backend.core.logger import log


# ── Three-dots menu ──────────────────────────────────────────────────────────

async def click_three_dots(page: Page) -> bool:
    """Click the ⋯ button next to the bell and Instagram icons.
    Returns True if the profile menu appeared."""

    # Dismiss stale popups
    try:
        await page.keyboard.press("Escape")
        await asyncio.sleep(0.3)
    except Exception:
        pass

    # Find SVG-only buttons near the IG link (profile header row)
    try:
        clicked = await page.evaluate(r"""
        () => {
            const igLink = document.querySelector('a[href*="instagram.com"]');
            let container = igLink ? igLink.parentElement : null;

            // Walk up to find the row with 2+ SVG buttons
            for (let depth = 0; depth < 8 && container; depth++) {
                const btns = Array.from(container.querySelectorAll(
                    'div[role="button"], button, [role="button"]'
                )).filter(b => {
                    const t = (b.innerText || '').trim();
                    return b.querySelector('svg')
                        && b.offsetHeight > 0 && b.offsetHeight < 80
                        && (t === '' || t.length <= 3)
                        && !b.closest('a[href*="instagram"]');
                });
                if (btns.length >= 2) {
                    // ⋯ is the last SVG button in the row
                    btns[btns.length - 1].click();
                    return {ok: true, btns: btns.length};
                }
                container = container.parentElement;
            }

            // Fallback: find by follower count area
            const walker = document.createTreeWalker(
                document.body, NodeFilter.SHOW_TEXT,
                {acceptNode: n => (n.textContent.includes('follower') ||
                                   n.textContent.includes('abonné'))
                    ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT}
            );
            const textNode = walker.nextNode();
            if (textNode) {
                let ct = textNode.parentElement;
                for (let d = 0; d < 10 && ct; d++) {
                    const btns = Array.from(ct.querySelectorAll(
                        'div[role="button"], button, [role="button"]'
                    )).filter(b => {
                        const t = (b.innerText || '').trim();
                        return b.querySelector('svg')
                            && b.offsetHeight > 0 && b.offsetHeight < 80
                            && (t === '' || t.length <= 3);
                    });
                    if (btns.length >= 2) {
                        btns[btns.length - 1].click();
                        return {ok: true, btns: btns.length, method: 'follower'};
                    }
                    ct = ct.parentElement;
                }
            }
            return {ok: false};
        }
        """)

        if not clicked or not clicked.get("ok"):
            log.warning("clean", "Three-dots button not found")
            return False

    except Exception as e:
        log.error("clean", f"Three-dots click error: {type(e).__name__}")
        return False

    # Wait for menu to appear
    appeared = await _wait_for_menu(page)

    if not appeared:
        # Maybe we clicked the bell — dismiss and try second-to-last button
        if await _dismiss_bell_popup(page):
            log.debug("clean", "Bell dismissed, retrying second-to-last")
            try:
                await page.evaluate(r"""
                () => {
                    const igLink = document.querySelector('a[href*="instagram.com"]');
                    let ct = igLink ? igLink.parentElement : document.body;
                    for (let d = 0; d < 12 && ct; d++) {
                        const btns = Array.from(ct.querySelectorAll(
                            'div[role="button"], button, [role="button"]'
                        )).filter(b => {
                            const t = (b.innerText || '').trim();
                            return b.querySelector('svg')
                                && b.offsetHeight > 0 && b.offsetHeight < 80
                                && (t === '' || t.length <= 3)
                                && !b.closest('a[href*="instagram"]');
                        });
                        if (btns.length >= 2) {
                            btns[btns.length - 2].click();
                            return true;
                        }
                        ct = ct.parentElement;
                    }
                    return false;
                }
                """)
                appeared = await _wait_for_menu(page)
            except Exception:
                pass

        if not appeared:
            # Escape and retry same button once
            try:
                await page.keyboard.press("Escape")
                await asyncio.sleep(0.5)
            except Exception:
                pass

    return appeared


async def _wait_for_menu(page: Page) -> bool:
    """Poll for the Threads profile menu to appear."""
    thread_items = [
        "supprimer follower", "remove follower",
        "bloquer", "block", "restreindre", "restrict",
        "signaler", "report", "mettre en sourdine", "mute",
        "copier le lien", "copy link",
    ]
    chrome_junk = {"ajouter comme colonne", "add as column",
                   "épingler l'onglet", "pin tab", "fermer l'onglet"}

    for attempt in range(5):
        await asyncio.sleep(1.0 + attempt * 0.3)
        try:
            result = await page.evaluate(r"""
            () => {
                const items = document.querySelectorAll(
                    '[role="menu"] *, [role="menuitem"], '
                    + '[role="dialog"] [role="button"], [role="dialog"] button, '
                    + '[role="dialog"] div[tabindex]'
                );
                const texts = [...new Set(
                    Array.from(items)
                        .map(el => (el.textContent || '').trim().toLowerCase())
                        .filter(t => t.length > 0 && t.length < 60)
                )].slice(0, 15);
                return texts;
            }
            """)
            if not result:
                continue

            clean = [t for t in result
                     if not any(j in t for j in chrome_junk)]
            if any(any(ti in t for ti in thread_items) for t in clean):
                return True

        except Exception:
            continue

    return False


async def _dismiss_bell_popup(page: Page) -> bool:
    """If bell popup is showing, dismiss it."""
    try:
        body = await page.evaluate(
            "() => (document.body?.innerText || '').substring(0, 500)")
        if ("abonner à ses notifications" in body.lower()
                or "subscribe to notifications" in body.lower()):
            for txt in ["Annuler", "Cancel"]:
                try:
                    btn = page.get_by_text(txt, exact=True).first
                    if await asyncio.wait_for(btn.is_visible(), timeout=1.0):
                        await btn.click()
                        await asyncio.sleep(0.5)
                        return True
                except Exception:
                    pass
            await page.keyboard.press("Escape")
            await asyncio.sleep(0.3)
            return True
    except Exception:
        pass
    return False


# ── Remove / Block actions ────────────────────────────────────────────────────

async def click_remove_follower(page: Page,
                                force_block: bool = False) -> str:
    """Click 'Supprimer follower' or fallback to 'Bloquer'.
    Returns 'removed', 'blocked', or '' on failure."""

    remove_patterns = [
        r"supprimer follower", r"remove follower",
        r"supprimer l.abonn", r"retirer.*abonn", r"remove.*follow",
    ]
    block_patterns = [r"^bloquer$", r"^block$"]

    await asyncio.sleep(0.5)

    if force_block:
        result = await _try_click_patterns(page, block_patterns)
        if result:
            return "blocked"
        result = await _try_click_patterns(page, remove_patterns)
        return "removed" if result else ""
    else:
        result = await _try_click_patterns(page, remove_patterns)
        if result:
            return "removed"
        result = await _try_click_patterns(page, block_patterns)
        return "blocked" if result else ""


async def click_confirm(page: Page) -> bool:
    """Click confirmation button (remove/block/oui/yes)."""
    confirm_patterns = [
        r"^supprimer$", r"^remove$", r"^bloquer$", r"^block$",
        r"confirm", r"^oui$", r"^yes$", r"supprimer follower",
    ]
    for pat in confirm_patterns:
        try:
            btn = page.get_by_role(
                "button", name=re.compile(pat, re.IGNORECASE)
            ).first
            if await asyncio.wait_for(btn.is_visible(), timeout=3.0):
                await btn.click()
                return True
        except Exception:
            pass
    return False


async def _try_click_patterns(page: Page, patterns: list[str]) -> bool:
    """Try to click an element matching any of the patterns."""
    # By role
    for role in ["menuitem", "button", "link"]:
        for pat in patterns:
            try:
                item = page.get_by_role(
                    role, name=re.compile(pat, re.IGNORECASE)).first
                if await asyncio.wait_for(item.is_visible(), timeout=2.5):
                    await item.click()
                    return True
            except Exception:
                pass

    # By text
    for pat in patterns:
        try:
            item = page.get_by_text(re.compile(pat, re.IGNORECASE)).first
            if await asyncio.wait_for(item.is_visible(), timeout=2.0):
                await item.click()
                return True
        except Exception:
            pass

    # JS fallback
    for pat in patterns:
        try:
            clicked = await page.evaluate(r"""
            (pattern) => {
                const regex = new RegExp(pattern, 'i');
                const candidates = document.querySelectorAll(
                    '[role="menuitem"], [role="button"], button, a, div[tabindex]'
                );
                for (const el of candidates) {
                    const t = (el.textContent || '').trim();
                    if (regex.test(t) && el.offsetHeight > 0) {
                        el.click(); return true;
                    }
                }
                return false;
            }
            """, pat)
            if clicked:
                return True
        except Exception:
            pass

    return False
