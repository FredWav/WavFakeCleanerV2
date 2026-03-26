"""
Connexion a Threads — ouvre un navigateur pour te connecter manuellement.
Sauvegarde ta session dans data/storage_state.json.

Usage :
    python login.py
"""

import asyncio
import json
import sys
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"
STORAGE_PATH = DATA_DIR / "storage_state.json"


async def main() -> None:
    DATA_DIR.mkdir(exist_ok=True)

    print()
    print("  ==========================================")
    print("   Wav Fake Cleaner V2 - Connexion Threads")
    print("  ==========================================")
    print()
    print("  Un navigateur va s'ouvrir.")
    print("  1. Connecte-toi a ton compte Threads")
    print("  2. Verifie que tu vois ton fil d'actualite")
    print("  3. Reviens ici et appuie sur Entree")
    print()

    try:
        from playwright.async_api import async_playwright
    except ImportError:
        print("  ==================================================")
        print("   ERREUR : Playwright n'est pas installe !")
        print()
        print("   Lance d'abord : setup.bat (Windows)")
        print("               ou : ./setup.sh (Mac/Linux)")
        print("  ==================================================")
        sys.exit(1)

    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(headless=False)

            ctx_opts: dict = {"viewport": {"width": 1280, "height": 900}}
            if STORAGE_PATH.exists():
                ctx_opts["storage_state"] = str(STORAGE_PATH)
                print("  (Session precedente trouvee, on essaie de la reutiliser...)")
                print()

            ctx = await browser.new_context(**ctx_opts)
            page = await ctx.new_page()
            await page.goto("https://www.threads.net/", wait_until="domcontentloaded")

            input("  Appuie sur Entree quand tu es connecte... ")

            state = await ctx.storage_state()
            STORAGE_PATH.write_text(json.dumps(state, indent=2), encoding="utf-8")

            await browser.close()

    except Exception as e:
        err = str(e).lower()
        if "executable doesn't exist" in err or "browsertype.launch" in err:
            print()
            print("  ERREUR : Le navigateur Chromium n'est pas installe.")
            print("  Lance :  python -m playwright install chromium")
            print()
            sys.exit(1)
        raise

    print()
    print("  ==================================================")
    print()
    print("   CONNEXION REUSSIE !")
    print()
    print("   Ta session est sauvegardee.")
    print("   Tu peux maintenant lancer : start.bat")
    print("                           ou : ./start.sh")
    print()
    print("  ==================================================")
    print()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n  Annule par l'utilisateur.")
    except Exception as e:
        print()
        print(f"  ERREUR INATTENDUE : {e}")
        print()
        print("  Si le probleme persiste, relance setup.bat / setup.sh")
        print()
        sys.exit(1)
