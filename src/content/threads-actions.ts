/**
 * Threads actions — DOM-based follower removal and blocking.
 *
 * Ported from backend/engine/cleaner.py.
 * Replaces Playwright clicks with direct DOM manipulation.
 */

import { SELECTORS } from "@shared/selectors";
import { humanClick } from "./humanize";

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

  // Strategy 3: Look for ellipsis/more icon buttons anywhere in main area
  const mainArea = document.querySelector("main") || document.querySelector("header");
  if (mainArea) {
    const allBtns = findMenuButtons(mainArea as HTMLElement);
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
      await humanClick(btn as HTMLElement);
      const appeared = await waitForMenu();
      if (appeared) return true;
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
  await humanClick(btns[btns.length - 1]);
  let appeared = await waitForMenu();
  if (appeared) return true;

  // Maybe we clicked the bell — dismiss and try second-to-last
  if (await dismissBellPopup()) {
    if (btns.length >= 2) {
      await humanClick(btns[btns.length - 2]);
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
    if (hasMenuContent()) {
      console.log("[WFC] Menu appeared");
      return true;
    }
  }
  console.log("[WFC] waitForMenu: no menu appeared after 6 attempts");
  return false;
}

function hasMenuContent(): boolean {
  // Fast broad check: scan all visible text for menu-specific strings
  const bodyText = (document.body?.innerText || "").toLowerCase();
  for (const mi of SELECTORS.menu.menuItems) {
    if (bodyText.includes(mi)) return true;
  }
  return false;
}

// ── Dismiss bell popup ──

async function dismissBellPopup(): Promise<boolean> {
  const body = (document.body?.innerText || "").substring(0, 800).toLowerCase();
  if (
    body.includes("abonner à ses notifications") ||
    body.includes("subscribe to notifications") ||
    body.includes("turn on notifications") ||
    body.includes("activer les notifications") ||
    body.includes("notifications for") ||
    body.includes("notifications de")
  ) {
    for (const txt of [
      "Annuler", "Cancel", "Non merci", "No thanks",
      "Not now", "Pas maintenant", "Close", "Fermer",
    ]) {
      const buttons = document.querySelectorAll("button, [role='button']");
      for (const btn of buttons) {
        if ((btn.textContent || "").trim() === txt && (btn as HTMLElement).offsetHeight > 0) {
          await humanClick(btn as HTMLElement);
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
  await sleep(800);

  for (const pat of SELECTORS.menu.confirmPatterns) {
    const buttons = document.querySelectorAll('button, [role="button"]');
    for (const btn of buttons) {
      const text = (btn.textContent || "").trim();
      if (pat.test(text) && (btn as HTMLElement).offsetHeight > 0) {
        await humanClick(btn as HTMLElement);
        console.log("[WFC] Clicked confirm button:", text);
        return true;
      }
    }
  }

  // Repli prudent (B-H4) : ne JAMAIS cliquer « le premier bouton rouge court »
  // au hasard (l'ancien code matchait aussi rgb(255,255,255) blanc et n'importe
  // quel texte rouge n'importe où sur la page → risque de mauvaise action).
  // On se limite à la boîte de confirmation (role=dialog / aria-modal) et on
  // exige un signal FIABLE : libellé de confirmation OU vrai rouge destructif.
  // Hors d'un dialog identifié, on exige les DEUX. À défaut, on échoue plutôt
  // que de cliquer une cible non vérifiée.
  const modal = document.querySelector('[role="dialog"], [aria-modal="true"]') as HTMLElement | null;
  const scope: ParentNode = modal || document;
  for (const btn of scope.querySelectorAll('button, [role="button"]')) {
    const el = btn as HTMLElement;
    if (el.offsetHeight <= 0) continue;
    const text = (el.textContent || "").trim();
    if (!text || text.length >= 30) continue;
    const style = window.getComputedStyle(el);
    const red = isDestructiveRed(style.color) || isDestructiveRed(style.backgroundColor);
    const wordy = CONFIRM_WORD_RE.test(text);
    const accept = modal ? (red || wordy) : (red && wordy);
    if (accept) {
      await humanClick(el);
      console.log("[WFC] Clicked confirm button (fallback):", text);
      return true;
    }
  }

  console.log("[WFC] clickConfirm: no confirm button found");
  return false;
}

// Libellés de confirmation multilingues (sur-ensemble des confirmPatterns) pour
// le repli prudent de clickConfirm. Volontairement large mais borné.
const CONFIRM_WORD_RE =
  /\b(supprimer|retirer|remove|delete|bloquer|block|bloquear|blockieren|confirmer|confirm|confirmar|oui|yes|s[ií]|ok)\b/i;

// Vrai rouge destructif (boutons « Supprimer » de Threads), PAS du blanc
// rgb(255,255,255) ni un texte rouge décoratif : canal rouge élevé, vert/bleu bas.
function isDestructiveRed(rgb: string): boolean {
  const m = (rgb || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return false;
  const r = +m[1], g = +m[2], b = +m[3];
  return r >= 180 && g <= 120 && b <= 120;
}

// ── Full remove flow with blocking detection ──

export async function performRemoveFollower(
  username: string
): Promise<{ success: boolean; action: string; error?: string; blocked?: boolean }> {
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

    // Step 4: Verify
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

    // B-H5 : pas de preuve de retrait (boîte de confirmation encore ouverte) →
    // on NE marque PAS removed. L'abonné reste en file pour un nouvel essai.
    if (verifyResult.removed === false) {
      consecutiveFailures++;
      return {
        success: false,
        action,
        error: "remove_unconfirmed",
        blocked: false,
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

// ── Detect Threads generic error page ──

const TRANSIENT_ERROR_PATTERNS = [
  /une erreur s.est produite/i,
  /an error occur/i,
  /something went wrong/i,
  /un problème est survenu/i,
  /oops.+wrong/i,
];

const RETRY_BUTTON_TEXTS = [
  "Réessayer", "Retry", "Try again", "Essayer à nouveau",
  "Actualiser", "Refresh", "Recharger", "Reload",
];

export function isTransientErrorPage(): boolean {
  const bodyText = (document.body?.innerText || "").toLowerCase();
  return TRANSIENT_ERROR_PATTERNS.some((p) => p.test(bodyText));
}

export async function recoverFromErrorPage(): Promise<boolean> {
  if (!isTransientErrorPage()) return false;

  console.log("[WFC] Detected Threads error page — recovering with backoff");

  for (let attempt = 0; attempt < 3; attempt++) {
    const backoff = [3000, 8000, 15000][attempt];
    await sleep(backoff);

    const buttons = document.querySelectorAll("button, [role='button'], a");
    let clicked = false;
    for (const btn of buttons) {
      const text = (btn.textContent || "").trim();
      if (RETRY_BUTTON_TEXTS.some((rt) => text.toLowerCase() === rt.toLowerCase()) &&
          (btn as HTMLElement).offsetHeight > 0) {
        await humanClick(btn as HTMLElement);
        console.log("[WFC] Clicked retry button (attempt " + (attempt + 1) + "):", text);
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      window.location.reload();
      console.log("[WFC] No retry button, reloading page (attempt " + (attempt + 1) + ")");
    }

    await sleep(4000);

    if (!isTransientErrorPage()) {
      console.log("[WFC] Page recovered after attempt " + (attempt + 1));
      return true;
    }
  }

  console.log("[WFC] Error page persists after 3 recovery attempts");
  return true;
}

// ── Verify removal ──

// Toast/texte de SUCCÈS explicite de retrait (multilingue) — preuve positive.
const REMOVED_TOAST_RE =
  /removed|supprim[ée]|retir[ée]|ne (?:vous|te) suit plus|no longer follows|eliminad[oa]|entfernt|rimoss[oa]/i;

// La boîte de confirmation est-elle ENCORE ouverte (libellé supprimer/confirmer
// toujours visible) ? Si oui, le clic « Confirmer » n'a rien fait → non confirmé.
function removalUiStillOpen(): boolean {
  const dialog = document.querySelector('[role="dialog"], [aria-modal="true"]') as HTMLElement | null;
  if (!dialog || dialog.offsetHeight <= 0) return false;
  const txt = (dialog.innerText || "").toLowerCase();
  return /supprimer|retirer|remove|confirm|bloquer|block/i.test(txt);
}

/**
 * Vérifie le résultat du clic « Confirmer ».
 *
 * B-H5 : avant, la fonction concluait « succès » par simple ABSENCE de message
 * de blocage — un clic qui n'avait rien supprimé (UI qui n'a pas réagi, mauvais
 * bouton) était compté comme succès et l'abonné marqué removed alors qu'il
 * restait. Désormais : si la boîte de confirmation est toujours ouverte, on
 * renvoie removed:false (→ retry, jamais de faux succès). On garde removed:true
 * uniquement quand l'UI de confirmation a bien disparu (ou sur toast de succès).
 */
async function verifyRemoval(_username: string): Promise<{ removed?: boolean; blocked: boolean; reason: string }> {
  const bodyText = (document.body?.innerText || "").toLowerCase();

  // Transient error page = action likely succeeded
  if (isTransientErrorPage()) {
    console.log("[WFC] Transient error page after removal — action likely succeeded");
    await recoverFromErrorPage();
    return { removed: true, blocked: false, reason: "" };
  }

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
  ];

  for (const pat of blockPatterns) {
    if (pat.test(bodyText)) {
      return { blocked: true, reason: pat.source };
    }
  }

  const toasts = document.querySelectorAll(
    '[role="alert"], [role="status"], [class*="toast"], [class*="snack"]'
  );
  for (const toast of toasts) {
    const text = (toast.textContent || "").toLowerCase();
    if (
      text.includes("blocked") ||
      text.includes("bloqué") ||
      text.includes("try again later") ||
      text.includes("réessayez plus tard")
    ) {
      return { blocked: true, reason: `toast: ${text.substring(0, 80)}` };
    }
    if (REMOVED_TOAST_RE.test(text)) {
      return { removed: true, blocked: false, reason: "removed_toast" };
    }
  }

  // Pas de blocage : exiger une preuve que l'action a bien été prise en compte.
  if (removalUiStillOpen()) {
    return { removed: false, blocked: false, reason: "confirm_ui_still_open" };
  }

  return { removed: true, blocked: false, reason: "" };
}

// ── Pattern matching click helper ──

async function tryClickPatterns(patterns: RegExp[]): Promise<boolean> {
  // Phase 1: precise selectors
  for (const selector of ['[role="menuitem"]', 'button', '[role="button"]', "a"]) {
    const elements = document.querySelectorAll(selector);
    for (const el of elements) {
      const text = (el.textContent || "").trim();
      if (patterns.some((p) => p.test(text)) && (el as HTMLElement).offsetHeight > 0) {
        console.log("[WFC] Clicking:", text, "via selector:", selector);
        await humanClick(el as HTMLElement);
        return true;
      }
    }
  }

  // Phase 2: broader — all visible elements (catches menus without ARIA roles)
  const all = document.querySelectorAll("div, span, a, button, [role], div[tabindex]");
  for (const el of all) {
    const h = el as HTMLElement;
    if (h.offsetHeight <= 0 || h.offsetHeight > 80) continue;
    const text = (h.textContent || "").trim();
    if (text.length < 3 || text.length > 60) continue;
    if (patterns.some((p) => p.test(text))) {
      console.log("[WFC] Clicking (broad):", text);
      await humanClick(h);
      return true;
    }
  }

  return false;
}

// ── Utility ──

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
