// ── Scored follower (after scoring algorithm) ──

export interface ScoredFollower {
  score: number;
  breakdown: string[];
  isFake: boolean;
  toReview: boolean;
}

// ── Profile data extracted from page visit ──

export interface ProfileData {
  username: string;
  notFound: boolean;
  isPrivate: boolean;
  isVerified: boolean;
  followerCount: number | null;
  postCount: number;
  hasBio: boolean;
  hasReplies: boolean;
  hasRealPic: boolean;
  hasFullName: boolean;
  hasIgLink: boolean;
  hasLinkInBio: boolean;
  fullName: string;
  allPostsRecent: boolean;
  duplicateRatio: number;
  hasSpamKeywords: boolean;
  hasMedia: boolean;
  error: string | null;
}

// ── IndexedDB records ──

export type FollowerStatus = "pending" | "scanned" | "fake" | "removed" | "approved";

export interface FollowerRecord {
  username: string; // primary key
  fullName: string;
  bio: string;
  followersCount: number | null;
  followingCount: number | null;
  postsCount: number | null;
  hasProfilePic: boolean;
  isPrivate: boolean;
  isVerified: boolean;
  // Scoring
  score: number | null;
  scoreBreakdown: string | null; // JSON string
  isFake: boolean | null;
  toReview: boolean;
  approved: boolean;
  // Status
  status: FollowerStatus;
  scanned: boolean;
  removed: boolean;
  scanError: string | null;
  // Timestamps
  createdAt: number;
  scannedAt: number | null;
  removedAt: number | null;
}

export interface ActionLogRecord {
  id?: number; // auto-increment
  actionType: "fetch" | "scan" | "remove" | "block";
  target: string | null;
  status: "ok" | "error_429" | "error_timeout" | "error_other";
  errorDetail: string | null;
  durationMs: number | null;
  createdAt: number;
}

export interface ScanSessionRecord {
  id?: number; // auto-increment
  status: "running" | "completed" | "stopped" | "error";
  totalFollowers: number;
  scannedCount: number;
  fakeCount: number;
  removedCount: number;
  errors429: number;
  errorsTimeout: number;
  startedAt: number;
  finishedAt: number | null;
}

// ── Pipeline state ──

export type PipelineStage = "idle" | "fetching" | "cleaning";

export interface PipelineState {
  stage: PipelineStage;
  sessionId: number | null;
  progress: number;
  total: number;
  lastError: string | null;
  // Set while the pipeline sleeps through a long anti-block pause so the UI can
  // show a countdown instead of a frozen progress bar. Cleared when not paused.
  pausedUntil?: number | null;
  pauseReason?: string | null;
}

// ── Stats for UI ──

export interface Stats {
  totalFollowers: number;
  pending: number;
  scanned: number;
  fakes: number;
  toReview: number;
  removed: number;
  isRunning: boolean;
  // Last user-facing error from the pipeline (cleared when a new run starts).
  // Null when the last run succeeded or no run has happened yet.
  lastError: string | null;
  // When the pipeline is in a long anti-block pause: epoch ms when it resumes,
  // plus a reason code the UI maps to a label. Null/absent when not paused.
  pausedUntil?: number | null;
  pauseReason?: string | null;
  // Nettoyage automatique (mode continu) : intention MÉMORISÉE de l'utilisateur.
  // Reste true même si le cycle s'est arrêté (SW suspendu) → l'UI affiche « activé
  // — Reprendre » au lieu de redemander l'activation.
  autoCleanupEnabled?: boolean;
  rate: {
    actionsThisHour: number;
    limitHour: number;
    consecutiveErrors: number;
  };
}

// ── Settings ──

export interface Settings {
  threadsUsername: string;
  scoreThreshold: number;
  privateAlwaysReview?: boolean;
  // Anonymous technical telemetry (errors, community queue health, selector
  // drift). ON by default since v3; this is the opt-out switch.
  telemetry?: boolean;
  // One-time v3 migration marker: existing users had an explicit `false`
  // persisted by the settings form, which is indistinguishable from a real
  // opt-out — the migration flips everyone ON once and shows a notice.
  telemetryMigratedV3?: boolean;
}

// ── License ──

export interface LicenseInfo {
  active: boolean;
  key: string | null;
  activatedAt: number | null;
  communityToken: string | null; // HMAC token issued by the Worker on activation
  /**
   * The raw activation token (cs_live_… for Stripe, wfc_lic_…. for owner
   * tokens). Stored for backup / re-activation flows. For Stripe, this is
   * identical to `key`. For owner-issued tokens, `key` is an obfuscated
   * "owner-<userId>" handle for display, while recoveryToken keeps the
   * original signed token so an export → import round-trip works.
   */
  recoveryToken?: string | null;
}

// ── Community status (visibility into the vote/sighting submission path) ──

export type CommunityTokenStatus = "ok" | "invalid" | "unknown";

/**
 * Why a community contribution was lost (or failed to submit).
 *   http_403      — Worker rejected the token (invalid/revoked licence)
 *   http_4xx      — other client error (validation, replayed nonce, …)
 *   max_attempts  — dropped after exhausting replay attempts
 *   overflow      — trimmed by the queue's FIFO cap
 *   quota         — chrome.storage write failed (quota exhausted)
 *   expired       — sat in the queue past its TTL
 *   network       — network error (lookups only; submissions retry instead)
 */
export type CommunityFailureReason =
  | "http_403"
  | "http_4xx"
  | "max_attempts"
  | "overflow"
  | "quota"
  | "expired"
  | "network";

export interface CommunityReplaySummary {
  ts: number;
  replayed: number;
  dropped: number;
  remaining: number;
}

export interface CommunityStatus {
  /** Contributions delivered to the Worker (votes + sighting reports). */
  sent: number;
  /** Contributions that entered the retry queue at least once. */
  enqueued: number;
  /** Contributions lost forever. */
  dropped: number;
  droppedByReason: Partial<Record<CommunityFailureReason, number>>;
  lastDropReason: CommunityFailureReason | null;
  lastReplay: CommunityReplaySummary | null;
  tokenStatus: CommunityTokenStatus;
  tokenCheckedAt: number | null;
  /** Live length of the retry queue (computed, not stored). */
  queueLength: number;
  updatedAt: number;
}

// ── Free tier limits ──

// Source de vérité unique du plan gratuit (U-H6) : 1 nettoyage/jour de 50
// comptes max, et la liste des faux masquée au-delà de 5 visibles. Toutes les
// chaînes i18n et la logique de paywall doivent pointer ici, pas re-coder « 5 ».
export const FREE_LIMITS = {
  cyclesPerDay: 1,
  cycleSize: 50,
  visibleFakes: 5,
} as const;

// ── Log entry ──

export interface LogEntry {
  ts: string;
  level: "INFO" | "WARNING" | "ERROR" | "DEBUG";
  category: string;
  message: string;
}
