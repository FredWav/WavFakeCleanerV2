/**
 * Pipeline timings — all magic numbers controlling pipeline pacing.
 *
 * Centralizing timings here makes the pipeline tuneable without touching the
 * orchestration code. Values are in seconds unless otherwise noted.
 */

// ── Tab lifecycle ──

export const TAB = {
  /** Wait this long after a tab navigates before sending it commands. */
  postNavSettleMs: 2000,
  /** Maximum wait for chrome.tabs to report status === "complete". */
  loadTimeoutMs: 15000,
} as const;

// ── Profile visit pacing (clean cycle, scan loop) ──

export const PROFILE_VISIT = {
  /** Sleep before injecting content script after navigation (sec). */
  preInjectMin: 6,
  preInjectMax: 14,           // 6 + Math.random()*8
  /** Sleep before triggering removal on already-scored fakes (sec). */
  preRemoveMin: 8,
  preRemoveMax: 20,           // 8 + Math.random()*12
} as const;

// ── Block / 429 cooldowns ──

export const COOLDOWN = {
  /** Consecutive blocked profiles before a forced pause (slowdown signal). */
  consecutiveBlockedThreshold: 5,
  /** Pause duration when slowdown is detected (sec). */
  slowdownPauseSec: 300,      // 5 min
  /** Consecutive Threads error pages before triggering long 429 backoff. */
  consecutiveErrorPagesThreshold: 3,
  /** Per-error-page exponential cooldown unit (sec). */
  errorPageBaseCooldownSec: 120,
  /** Sleep when a 429 is detected mid-scan (sec). */
  rateLimitMin: 30,
  rateLimitMax: 60,           // 30 + Math.random()*30
  /** Maximum number of remove retries per follower before re-navigating. */
  removeRetryMax: 2,
} as const;

// ── Human pacer defaults ──

export const PACER = {
  /** Mean inter-action pause floor (sec). */
  baseMin: 15,
  /** Mean inter-action pause ceiling (sec). */
  baseMax: 30,
} as const;
