"""
First login helper - opens a visible Chromium browser so you can
log into Threads manually. Saves cookies to data/storage_state.json.

Usage:
    python login.py
"""

import asyncio
import json
from pathlib import Path
from playwright.async_api import async_playwright

DATA_DIR = Path(__file__).parent / "data"
STORAGE_PATH = DATA_DIR / "storage_state.json"


async def main() -> None:
    DATA_DIR.mkdir(exist_ok=True)

    print()
    print("  ==========================================")
    print("  Wav Fake Cleaner V2 - Connexion Threads")
    print("  ==========================================")
    print()
    print("  Un navigateur va s'ouvrir.")
    print("  -> Connecte-toi a ton compte Threads.")
    print("  -> Une fois connecte, reviens ici et appuie sur Entree.")
    print()

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=False)

        ctx_opts = {"viewport": {"width": 1280, "height": 900}}
        if STORAGE_PATH.exists():
            ctx_opts["storage_state"] = str(STORAGE_PATH)
            print("  (Session precedente detectee, tentative de restauration...)")
            print()

        ctx = await browser.new_context(**ctx_opts)
        page = await ctx.new_page()
        await page.goto("https://www.threads.net/", wait_until="domcontentloaded")

        input("  Appuie sur Entree quand tu es connecte... ")

        state = await ctx.storage_state()
        STORAGE_PATH.write_text(json.dumps(state, indent=2), encoding="utf-8")

        await browser.close()

    print()
    print(f"  OK - Session sauvegardee dans: {STORAGE_PATH}")
    print("  Tu peux maintenant lancer: start.bat")
    print()


if __name__ == "__main__":
    asyncio.run(main())
