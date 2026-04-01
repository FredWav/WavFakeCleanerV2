/**
 * Threads actions — DOM-based follower removal and blocking.
 *
 * Ported from backend/engine/cleaner.py.
 * Replaces Playwright clicks with direct DOM manipulation.
 *
 * v2: Enhanced with better menu detection, Threads blocking detection,
 *     and comprehensive error reporting.
 */

import { SELECTORS } from "@shared/selectors";

// ── State for detecting blocks ──

let lastRemoveAttemptTime = 0;
let consecutiveFailures = 0;

// ── Three-dots menu ──

export async function clickThreeDots(): Promise<boolean> {
  // Dismiss stale popups
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await sleep(400);

  // Strategy 1: Find SVG-only buttons near the IG link (profile header row)
  const igLink = document.querySelector('a[href*="instagram.com"]');
  let container: HTMLElement | null = igLink ? igLink.parentElement : null;

  for (let depth = 0; depth < 8 && container; depth++) {
    const btns = findMenuButtons(container);
    if (btns.length >= 2) {
      const result = await tryMenuButtons(btns);
      if (result) return true;
    }
    container = container.parentElement;
  }

  // Strategy 2: Find buttons near follower count area
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      (n.textContent || "").match(/follower|abonné/i)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });

  const textNode = walker.nextNode();
  if (textNode) {
    let ct: HTMLElement | null = textNode.parentElement;
    for (let d = 0; d < 10 && ct; d++) {
      const btns = findMenuButtons(ct);
      if (btns.length >= 2) {
        const result = await tryMenuButtons(btns);
        if (result) return true;
      }
      ct = ct.parentElement;
    }
  }

  // Strategy 3: Look for ellipsis/more icon buttons anywhere in the header area
  const headerArea = document.querySelector("header") || document.querySelector("main");
  if (headerArea) {
    const allBtns = findMenuButtons(headerArea as HTMLElement);
    if (allBtns.length >= 1) {
      const result = await tryMenuButtons(allBtns);
      if (result) return true;
    }
  }

  // Strategy 4: Look for any button with "more" or aria-label suggesting menu
  const moreBtns = document.querySelectorAll(
    '[aria-label*="ore"], [aria-label*="lus"], [aria-label*="ptions"], [aria-label*="enu"]'
  );
  for (const btn of moreBtns) {
    if ((btn as HTMLElement).offsetHeight > 0 && (btn as HTMLElement).offsetHeight < 80) {
      (btn as HTMLElement).click();
      const appeared = await waitForMenu();
      if (appeared) return true;
      // Dismiss and continue
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await sleep(300);
    }
  }

  console.log("[WFC] clickThreeDots: no menu button found");
  return false;
}

function findMenuButtons(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll('div[role="button"], button, [role="button"]')
  ).filter((b) => {
    const el = b as HTMLElement;
    const t = (el.innerText || "").trim();
    return (
      el.querySelector("svg") &&
      el.offsetHeight > 0 &&
      el.offsetHeight < 80 &&
      (t === "" || t.length <= 3) &&
      !el.closest('a[href*="instagram"]')
    );
  }) as HTMLElement[];
}

async function tryMenuButtons(btns: HTMLElement[]): Promise<boolean> {
  // Try last button first (usually the three dots)
  (btns[btns.length - 1]).click();
  let appeared = await waitForMenu();
  if (appeared) return true;

  // Maybe we clicked the bell — dismiss and try second-to-last
  if (await dismissBellPopup()) {
    if (btns.length >= 2) {
      (btns[btns.length - 2]).click();
      appeared = await waitForMenu();
      if (appeared) return true;
    }
  }

  // Dismiss whatever opened
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await sleep(300);
  return false;
}

// ── Wait for menu to appear ──

async function waitForMenu(): Promise<boolean> {
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(800 + attempt * 200);

    // Check for role="menu" or role="dialog" content
    const items = document.querySelectorAll(
      '[role="menu"] *, [role="menuitem"], [role="dialog"] [role="button"], [role="dialog"] button, [role="dialog"] div[tabindex], [role="listbox"] *'
    );

    const texts = [
      ...new Set(
        Array.from(items)
          .map((el) => (el.textContent || "").trim().toLowerCase())
          .filter((t) => t.length > 0 && t.length < 60)
      ),
    ].slice(0, 20);

    const clean = texts.filter(
      (t) => !Array.from(SELECTORS.menu.chromeJunk).some((j) => t.includes(j))
    );

    if (clean.some((t) => SELECTORS.menu.menuItems.some((mi) => t.includes(mi)))) {
      console.log("[WFC] Menu appeared with items:", clean.join(", "));
      return true;
    }
  }
  console.log("[WFC] waitForMenu: no menu appeared after 6 attempts");
  return false;
}

// ── Dismiss bell popup ──

async function dismissBellPopup(): Promise<boolean> {
  const body = (document.body?.innerText || "").substring(0, 500).toLowerCase();
  if (
    body.includes("abonner à ses notifications") ||
    body.includes("subscribe to notifications") ||
    body.includes("turn on notifications") ||
    body.includes("activer les notifications")
  ) {
    for (const txt of ["Annuler", "Cancel", "Non merci", "No thanks", "Not now", "Pas maintenant"]) {
      const buttons = document.querySelectorAll("button, [role='button']");
      for (const btn of buttons) {
        if ((btn.textContent || "").trim() === txt && (btn as HTMLElement).offsetHeight > 0) {
          (btn as HTMLElement).click();
          await sleep(500);
          return true;
        }
      }
    }
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(300);
    return true;
  }
  return false;
}

// ── Remove / Block actions ──

export async function clickRemoveFollower(forceBlock = false): Promise<"removed" | "blocked" | ""> {
  await sleep(500);

  if (forceBlock) {
    if (await tryClickPatterns(SELECTORS.menu.blockPatterns)) return "blocked";
    if (await tryClickPatterns(SELECTORS.menu.removePatterns)) return "removed";
    return "";
  }

  if (await tryClickPatterns(SELECTORS.menu.removePatterns)) return "removed";
  if (await tryClickPatterns(SELECTORS.menu.blockPatterns)) return "blocked";
  return "";
}

export async function clickConfirm(): Promise<boolean> {
  // Wait a moment for confirmation dialog
  await sleep(800);

  for (const pat of SELECTORS.menu.confirmPatterns) {
    const buttons = document.querySelectorAll('button, [role="button"]');
    for (const btn of buttons) {
      const text = (btn.textContent || "").trim();
      if (pat.test(text) && (btn as HTMLElement).offsetHeight > 0) {
        (btn as HTMLElement).click();
        console.log("[WFC] Clicked confirm button:", text);
        return true;
      }
    }
  }

  // Also look for red/destructive buttons as confirmation
  const allButtons = document.querySelectorAll('button, [role="button"]');
  for (const btn of allButtons) {
    const el = btn as HTMLElement;
    if (el.offsetHeight <= 0) continue;
    const style = window.getComputedStyle(el);
    const color = style.color || "";
    const bg = style.backgroundColor || "";
    // Red-ish buttons are usually destructive confirmation
    if ((color.includes("rgb(255") || bg.includes("rgb(255")) && el.textContent && el.textContent.trim().length < 30) {
      el.click();
      console.log("[WFC] Clicked red button as confirm:", el.textContent?.trim());
      return true;
    }
  }

  console.log("[WFC] clickConfirm: no confirm button found");
  return false;
}

// ── Full remove flow with blocking detection ──

export async function performRemoveFollower(
  username: string
): Promise<{ success: boolean; action: string; error?: string; blocked?: boolean }> {
  const startTime = Date.now();

  try {
    // Step 1: Open menu
    const menuOpened = await clickThreeDots();
    if (!menuOpened) {
      consecutiveFailures++;
      return {
        success: false,
        action: "",
        error: "menu_not_found",
        blocked: consecutiveFailures >= 3,
      };
    }

    // Step 2: Click remove
    const action = await clickRemoveFollower();
    if (!action) {
      consecutiveFailures++;
      // Dismiss menu
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await sleep(300);
      return {
        success: false,
        action: "",
        error: "remove_button_not_found",
        blocked: consecutiveFailures >= 3,
      };
    }

    // Step 3: Confirm
    await sleep(1000);
    const confirmed = await clickConfirm();
    if (!confirmed) {
      consecutiveFailures++;
      // Check if we got a "try again later" or rate limit message
      const bodyText = (document.body?.innerText || "").toLowerCase();
      const isBlocked =
        bodyText.includes("try again later") ||
        bodyText.includes("réessayez plus tard") ||
        bodyText.includes("too many") ||
        bodyText.includes("slow down") ||
        bodyText.includes("action blocked") ||
        bodyText.includes("action bloquée");

      return {
        success: false,
        action,
        error: isBlocked ? "threads_blocked" : "confirm_failed",
        blocked: isBlocked || consecutiveFailures >= 3,
      };
    }

    // Step 4: Verify the action succeeded
    await sleep(1500);
    const verifyResult = await verifyRemoval(username);

    if (verifyResult.blocked) {
      consecutiveFailures++;
      return {
        success: false,
        action,
        error: "threads_blocked",
        blocked: true,
      };
    }

    // Success!
    consecutiveFailures = 0;
    lastRemoveAttemptTime = Date.now();

    return {
      success: true,
      action,
      blocked: false,
    };
  } catch (e) {
    consecutiveFailures++;
    return {
      success: false,
      action: "",
      error: String(e),
      blocked: consecutiveFailures >= 3,
    };
  }
}

// ── Verify removal succeeded (check for blocking messages) ──

async function verifyRemoval(username: string): Promise<{ blocked: boolean; reason: string }> {
  const bodyText = (document.body?.innerText || "").toLowerCase();

  // Check for Threads blocking messages
  const blockPatterns = [
    /try again later/i,
    /réessayez plus tard/i,
    /action.?blocked/i,
    /action.?bloquée/i,
    /temporarily.?blocked/i,
    /temporairement.?bloqué/i,
    /too many.?(request|action)/i,
    /slow down/i,
    /rate.?limit/i,
    /something went wrong/i,
    /un problème est survenu/i,
  ];

  for (const pat of blockPatterns) {
    if (pat.test(bodyText)) {
      return { blocked: true, reason: pat.source };
    }
  }

  // Check for error toast/snackbar
  const toasts = document.querySelectorAll(
    '[role="alert"], [role="status"], [class*="toast"], [class*="snack"], [class*="error"]'
  );
  for (const toast of toasts) {
    const text = (toast.textContent || "").toLowerCase();
    if (
      text.includes("error") ||
      text.includes("erreur") ||
      text.includes("problem") ||
      text.includes("try again") ||
      text.includes("blocked")
    ) {
      return { blocked: true, reason: `toast: ${text.substring(0, 80)}` };
    }
  }

  return { blocked: false, reason: "" };
}

// ── Pattern matching click helper ──

async function tryClickPatterns(patterns: RegExp[]): Promise<boolean> {
  // By role
  for (const selector of ['[role="menuitem"]', 'button', '[role="button"]', "a"]) {
    const elements = document.querySelectorAll(selector);
    for (const el of elements) {
      const text = (el.textContent || "").trim();
      if (
        patterns.some((p) => p.test(text)) &&
        (el as HTMLElement).offsetHeight > 0
      ) {
        console.log("[WFC] Clicking:", text, "via selector:", selector);
        (el as HTMLElement).click();
        return true;
      }
    }
  }

  // Broader search with tabindex
  const candidates = document.querySelectorAll(
    '[role="menuitem"], [role="button"], button, a, div[tabindex]'
  );
  for (const el of candidates) {
    const t = (el.textContent || "").trim();
    if (patterns.some((p) => p.test(t)) && (el as HTMLElement).offsetHeight > 0) {
      console.log("[WFC] Clicking (broad):", t);
      (el as HTMLElement).click();
      return true;
    }
  }

  return false;
}

// ── Utility ──

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
