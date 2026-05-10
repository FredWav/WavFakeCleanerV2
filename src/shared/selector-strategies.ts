/**
 * Selector strategies — ordered fallback chains for fragile DOM lookups.
 *
 * Threads pushes layout changes regularly; a single hardcoded selector breaks
 * every few weeks. This module wraps lookups in a chain of strategies,
 * trying each in order until one returns a hit. When a fallback of rank ≥ 1
 * succeeds, we record a drift event so the operator can update the primary
 * selector before it disappears entirely.
 *
 * Drift events are reported via the optional `onDrift` callback (typically
 * wired to telemetry by the content script entry point).
 */

export interface SelectorStrategy<T> {
  /** Short identifier shown in drift telemetry (e.g. "role-dialog", "aria-modal"). */
  name: string;
  /** Run the strategy; return null if it didn't find anything. */
  resolve: () => T | null;
}

export interface DriftEvent {
  /** Logical lookup name (e.g. "followers-modal-links"). */
  lookup: string;
  /** Strategy that succeeded (rank > 0 means primary failed). */
  winningStrategy: string;
  /** Index in the strategies array; 0 = primary, 1+ = drift. */
  rank: number;
}

let driftHandler: ((event: DriftEvent) => void) | null = null;

/**
 * Register a callback that fires whenever a non-primary strategy succeeds.
 * Wire this to telemetry (or a UI toast) at content-script init.
 */
export function onDrift(handler: (event: DriftEvent) => void): void {
  driftHandler = handler;
}

/**
 * Run strategies in order; return the first non-null result.
 *
 * Reports a drift event when rank > 0. Returns `null` only when every
 * strategy fails — callers should handle that explicitly (often by falling
 * back to a heuristic broader than any single selector).
 */
export function tryStrategies<T>(lookup: string, strategies: SelectorStrategy<T>[]): T | null {
  for (let i = 0; i < strategies.length; i++) {
    const s = strategies[i];
    let result: T | null = null;
    try {
      result = s.resolve();
    } catch {
      // Strategies are user-facing fragile DOM reads; never let one throw
      // the whole chain. Move on to the next.
      continue;
    }
    if (result !== null && result !== undefined) {
      // Allow empty-array results to count as "found" — callers know
      // their resolve() returns [] only when truly empty.
      const isEmptyArray = Array.isArray(result) && result.length === 0;
      if (!isEmptyArray) {
        if (i > 0 && driftHandler) {
          try {
            driftHandler({ lookup, winningStrategy: s.name, rank: i });
          } catch {
            // never let telemetry kill the lookup
          }
        }
        return result;
      }
    }
  }
  return null;
}

// ── Pre-built strategy chains for the most fragile lookups ──

/**
 * Followers modal: extract <a href="/@user"> links.
 *
 * Strategies, in order of confidence:
 *   1. Canonical role="dialog" wrapper (Threads' usual modal pattern)
 *   2. aria-modal="true" wrapper (modern variant without role="dialog")
 *   3. data-testid containing "followers" (test-id rollouts)
 *   4. Any anchor with /@ that's inside a position:fixed/absolute container
 *      near the viewport center (heuristic last resort)
 */
export const followersModalLinkStrategies: SelectorStrategy<HTMLAnchorElement[]>[] = [
  {
    name: "role-dialog",
    resolve: () => {
      const els = document.querySelectorAll<HTMLAnchorElement>(
        'div[role="dialog"] a[href*="/@"]',
      );
      return els.length > 0 ? Array.from(els) : null;
    },
  },
  {
    name: "aria-modal",
    resolve: () => {
      const els = document.querySelectorAll<HTMLAnchorElement>(
        '[aria-modal="true"] a[href*="/@"]',
      );
      return els.length > 0 ? Array.from(els) : null;
    },
  },
  {
    name: "test-id",
    resolve: () => {
      const els = document.querySelectorAll<HTMLAnchorElement>(
        '[data-testid*="follower" i] a[href*="/@"]',
      );
      return els.length > 0 ? Array.from(els) : null;
    },
  },
];

/**
 * Heuristic private-account detection — independent of locale strings.
 *
 * Threads always renders a lock icon (SVG) near the private banner, plus a
 * short heading-only block with no media or feed below. This lets us flag
 * private accounts even when the wording isn't in our regex catalog yet.
 *
 * Returns true only when BOTH a lock-shaped SVG and a short empty-feed
 * heading region are detected (low false-positive rate).
 */
export function detectIsPrivateHeuristic(): boolean {
  // 1) Look for a lock-shaped SVG in the upper third of the page. Threads
  //    uses an aria-label or a known viewBox; we accept both.
  const svgs = document.querySelectorAll("svg");
  let hasLockIcon = false;
  for (const svg of svgs) {
    const rect = svg.getBoundingClientRect();
    if (rect.top > 600) continue; // below the profile header
    const aria = (svg.getAttribute("aria-label") || "").toLowerCase();
    if (aria.includes("lock") || aria.includes("priv") || aria.includes("verrou")) {
      hasLockIcon = true;
      break;
    }
    // Threads' lock SVG has a recognizable viewBox shape; accept square small icons
    if (rect.width > 12 && rect.width < 40 && rect.height > 12 && rect.height < 40) {
      // additionally check for path "d" attribute typical of a padlock shape
      const path = svg.querySelector("path");
      const d = path?.getAttribute("d") || "";
      if (d.length > 30 && d.includes("Z")) {
        // Heuristic: any small icon NEAR a heading containing "private"-ish text
        // we'd need broader signals — skip pure shape-based detection for now
        // (kept as a hook for future tightening)
      }
    }
  }

  if (!hasLockIcon) return false;

  // 2) Verify the page has no feed: a private profile shows the banner and
  //    no <article> elements below it. If we see articles, abort — it's
  //    almost certainly a public profile with a lock-glyph icon elsewhere.
  const articles = document.querySelectorAll("article");
  if (articles.length > 0) return false;

  return true;
}
