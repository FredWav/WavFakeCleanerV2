/**
 * Scoring configuration — tuneable thresholds and weights.
 *
 * Single source of truth for scorer.ts. Values here can be overridden at
 * runtime via chrome.storage.local "scoringOverrides" (deep merge) for A/B
 * tuning without rebuilding the extension.
 *
 * Group conventions:
 *   - DECISION_*  : final score → fake/review/ok cutoffs
 *   - WEIGHTS_*   : individual signal points added to the score
 *   - BANDS_*     : numeric thresholds that switch a rule on/off
 */

// ── Decision thresholds (tied to user-facing settings.scoreThreshold) ──

export const DECISION = {
  /** Default fake threshold when settings.scoreThreshold is unset (0/false). */
  defaultFakeMin: 70,
  /** Pre-score auto-flag threshold: skip full scan if metadata score ≥ this. */
  preScoreFakeMin: 75,
  /** Review window: scores in [threshold-window, threshold) flagged as toReview. */
  reviewWindow: 20,
  /** Cap for accumulated username pattern bonuses. */
  usernameBonusCap: 45,
} as const;

// ── Username heuristic ratios ──

export const USERNAME = {
  /** Skip ratio checks under this length to avoid false positives on short names. */
  minLength: 4,
  /** Digit fraction (0–1) above which the +digitBonus applies. */
  digitRatioCutoff: 0.5,
  digitRatioBonus: 15,
  /** (digit+special)/length above which the +nonLetterBonus applies. */
  nonLetterRatioCutoff: 0.8,
  nonLetterBonus: 10,
} as const;

// ── Follower count bands (used by both pre-score and full scoring) ──

export const FC_BANDS = {
  zero: 0,
  veryLow: 10,
  low: 50,
  medium: 100,
  high: 500,
  /** Auto-skip threshold: verified + ≥this followers → score = 0 (legitimate). */
  verifiedSkipMin: 500,
} as const;

// ── Cross-user sightings (community pool) ──

export const SIGHTINGS = {
  /** Minimum sightings to trigger any bonus. */
  thresholdLow: 2,
  thresholdMid: 3,
  thresholdHigh: 5,
  bonusLow: 15,
  bonusMid: 20,
  bonusHigh: 25,
} as const;

// ── Following / Follower ratio rules ──

export const RATIO = {
  /** <maxFc followers + ≥minFollowing following → very strong fake signal. */
  massFollowVeryHigh: { maxFc: 10, minFollowing: 100, bonus: 30 },
  /** ≥minFollowing following + <maxFc followers → extreme ratio. */
  extremeRatio: { maxFc: 100, minFollowing: 2000, bonus: 30 },
  /** ≥minFollowing following + <maxFc followers → high ratio. */
  highRatio: { maxFc: 50, minFollowing: 500, bonus: 20 },
  /** <maxFc + ≥minFollowing → mass-follow small. */
  massFollowSmall: { maxFc: 10, minFollowing: 50, bonus: 20 },
  /** Plain ratio ≥ minRatio → suspicious. */
  suspicious: { minRatio: 20, bonus: 15 },
  /** Plain ratio ≥ minRatio → elevated. */
  elevated: { minRatio: 10, bonus: 10 },
  /** Creator pattern: ratio ≤ maxRatio + ≥minFc followers → legitimate. */
  creator: { maxRatio: 0.5, minFc: 200, bonus: -10 },
  /** 0 followers + ≥minFollowing → ghost mass-follower. */
  ghost: { minFollowing: 50, bonus: 25 },
} as const;

// ── Pre-score (metadata-only) weights ──

export const PRE_SCORE = {
  verifiedBonus: -25,
  fcZeroBonus: 15,
  fcVeryLowBonus: 10,        // ≤10 followers
  fcMediumPenalty: -10,      // ≥100 followers
  fcHighPenalty: -15,        // ≥500 followers
  noPicBonus: 20,
  noFullNameBonus: 10,
  privateAnonymousBonus: 15, // private + !name + !pic
  privateLowFollowersNoBio: { maxFc: 50, bonus: 40 },
  ghostFollow: { minFollowing: 50, bonus: 25 },         // 0 fc + 50+ following
  massFollow: { maxFc: 10, minFollowing: 100, bonus: 25 },
  highRatio: { minRatio: 20, bonus: 15 },
} as const;

// ── Full-scan weights ──

export const WEIGHTS = {
  // Strong legitimacy (negative = lower fake score)
  verified: -25,
  hasMedia: -15,
  linkInBio: -15,
  igLinkWithBio: -10,
  bio: -10,
  bioInactive: -5,           // bio present but zero activity → smaller bonus

  // Strong fake signals
  noBio: 20,
  noPic: 20,
  noFullName: 5,             // weak — fakes often have realistic names
  zeroPosts: 35,
  noReplies: 25,
  spamKeywords: 25,
  duplicatePosts: 40,
  cancelDupePostBonus: 15,   // when dupes detected, undo activePosts bonus

  // Activity / engagement combos
  fewPosts: 25,              // 1-2 posts
  somePosts: 15,             // 3-4 posts
  spamRecent: 20,            // all posts in last 72h
  activePosts: -15,          // 5+ posts
  repliesActive: -15,        // hasReplies + hasPosts
  repliesNoPosts: 10,        // replies but no posts
  repliesSpam: 10,           // replies on a spambot
  zeroPostsZeroReplies: 20,
  zeroPostsHasReplies: 10,
  inactiveProfile: 15,       // 1-4 posts + !replies + !bio
  ghostAccount: 10,          // ≤50 followers + ≤2 posts + !replies

  // Follower count bands (full-scan)
  fcZero: 15,
  fcVeryLow: 10,             // ≤10
  fcLow: 5,                  // ≤50
  fcMedium: -5,              // ≥100
  fcHigh: -10,               // ≥500
  fcUnknown: 5,
} as const;

// ── Posts rules ──

export const POSTS = {
  fewPostsMax: 2,            // 1-2
  somePostsMax: 4,           // 3-4
  activePostsMin: 5,         // 5+
  duplicateRatioMin: 0.5,
  duplicateMinPosts: 3,
} as const;

// ── Engagement combos ──

export const COMBOS = {
  inactiveMinPosts: 1,
  inactiveMaxPosts: 4,
  ghostMaxFollowers: 50,
  ghostMaxPosts: 2,
} as const;

// ── Private account scoring ──

export const PRIVATE_ACCOUNT = {
  /** When settings.privateAlwaysReview is true, force review (small flat bonus). */
  strictBonus: 10,
  /** Legitimacy signals (hasBio, hasLinkInBio, hasRealPic, hasIgLink). */
  legitSignalsHigh: { min: 3, bonus: -15 },
  legitSignalsMid: { min: 2, bonus: -5 },
  /** Tiered penalties by follower count. */
  veryLowFollowers: { maxFc: 10, bonus: 40 },
  lowFollowersAnon: { maxFc: 30, bonus: 30 },     // <30 + !bio + !pic
  lowFollowersPartial: { maxFc: 30, bonus: 20 },  // <30 + (!bio || !pic)
  lowFollowersOk: { maxFc: 30, bonus: 5 },        // <30 + bio + pic
  standard: { bonus: 5 },                          // 30+ followers
  /** Additive combo: !bio + <maxFc followers. */
  noBioLowFollowers: { maxFc: 50, bonus: 40 },
} as const;

// ── Runtime override hook ──

export interface ScoringOverrides {
  decision?: Partial<typeof DECISION>;
  username?: Partial<typeof USERNAME>;
  fcBands?: Partial<typeof FC_BANDS>;
  sightings?: Partial<typeof SIGHTINGS>;
  weights?: Partial<typeof WEIGHTS>;
  preScore?: Partial<typeof PRE_SCORE>;
}
