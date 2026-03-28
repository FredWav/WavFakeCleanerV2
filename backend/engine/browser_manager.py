"""
BrowserManager — Playwright browser lifecycle + resource blocking.

Uses storage_state for auth (no CDP dependency).
Blocks images/fonts/media for 3-5x speed gain.
Fingerprint rotation to avoid detection.
"""

import asyncio
import random
from pathlib import Path

import yaml
from playwright.async_api import async_playwright, Browser, BrowserContext, Page, Playwright

from backend.core.config import settings
from backend.core.logger import log

SELECTORS_PATH = Path(__file__).parent / "selectors.yaml"
BLOCK_EXTENSIONS = {"png", "jpg", "jpeg", "gif", "woff2", "woff", "ttf",
                    "mp4", "webp", "ico", "svg"}

# ── Fingerprint pools for rotation ───────────────────────────────────────────

_USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
]

_VIEWPORTS = [
    {"width": 1280, "height": 900},
    {"width": 1366, "height": 768},
    {"width": 1440, "height": 900},
    {"width": 1536, "height": 864},
    {"width": 1920, "height": 1080},
    {"width": 1280, "height": 800},
    {"width": 1360, "height": 768},
    {"width": 1400, "height": 900},
]

_TIMEZONES = [
    "Europe/Paris",
    "Europe/London",
    "Europe/Berlin",
    "America/New_York",
    "America/Chicago",
    "America/Los_Angeles",
]

_LOCALES = ["fr-FR", "en-US", "en-GB", "fr-BE", "de-DE"]


def _random_fingerprint() -> dict:
    """Generate a randomized browser fingerprint."""
    return {
        "user_agent": random.choice(_USER_AGENTS),
        "viewport": random.choice(_VIEWPORTS),
        "timezone_id": random.choice(_TIMEZONES),
        "locale": random.choice(_LOCALES),
    }


def load_selectors() -> dict:
    """Load selectors from YAML (hot-updatable)."""
    with open(SELECTORS_PATH, encoding="utf-8") as f:
        return yaml.safe_load(f)


class BrowserManager:
    def __init__(self) -> None:
        self._pw: Playwright | None = None
        self._browser: Browser | None = None
        self._semaphore = asyncio.Semaphore(settings.max_browser_contexts)
        self._selectors: dict = {}

    @property
    def selectors(self) -> dict:
        if not self._selectors:
            self._selectors = load_selectors()
        return self._selectors

    def reload_selectors(self) -> dict:
        self._selectors = load_selectors()
        log.info("browser", "Selectors reloaded from YAML")
        return self._selectors

    async def start(self) -> None:
        """Launch Playwright and browser."""
        self._pw = await async_playwright().start()
        storage = settings.storage_state_path
        storage_exists = Path(storage).exists()

        self._browser = await self._pw.chromium.launch(
            headless=settings.headless,
        )
        log.info("browser", f"Browser started (headless={settings.headless}, "
                 f"storage={'found' if storage_exists else 'MISSING'})")

    async def stop(self) -> None:
        """Close browser and Playwright."""
        if self._browser:
            await self._browser.close()
            self._browser = None
        if self._pw:
            await self._pw.stop()
            self._pw = None
        log.info("browser", "Browser stopped")

    async def new_context(self, block_resources: bool = True) -> BrowserContext:
        """Create a new browser context with storage state, resource blocking,
        and randomized fingerprint."""
        if not self._browser:
            raise RuntimeError("Browser not started — call start() first")

        await self._semaphore.acquire()

        fp = _random_fingerprint()
        opts: dict = {
            "viewport": fp["viewport"],
            "user_agent": fp["user_agent"],
            "timezone_id": fp["timezone_id"],
            "locale": fp["locale"],
        }
        storage = settings.storage_state_path
        if Path(storage).exists():
            opts["storage_state"] = storage

        ctx = await self._browser.new_context(**opts)

        log.info("browser",
                 f"New context: {fp['viewport']['width']}x{fp['viewport']['height']} "
                 f"{fp['timezone_id']} {fp['locale']}")

        if block_resources:
            await ctx.route(
                "**/*.{" + ",".join(BLOCK_EXTENSIONS) + "}",
                lambda route: asyncio.ensure_future(route.abort()),
            )

        return ctx

    def release_context(self) -> None:
        """Release the semaphore slot after closing a context."""
        self._semaphore.release()

    async def new_page(self, block_resources: bool = True) -> tuple[BrowserContext, Page]:
        """Convenience: create context + page in one call."""
        ctx = await self.new_context(block_resources)
        page = await ctx.new_page()
        return ctx, page

    async def wait_for_profile(self, page: Page, timeout_ms: int = 6000) -> None:
        """Wait for profile page to load."""
        sel = self.selectors.get("profile", {}).get(
            "loaded_check", "header,main,h1")
        try:
            await page.wait_for_function(
                f"() => document.querySelector('{sel}') !== null",
                timeout=timeout_ms,
            )
        except Exception:
            pass


# Singleton
browser_manager = BrowserManager()
