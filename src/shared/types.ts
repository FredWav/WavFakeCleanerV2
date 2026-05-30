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
  // Opt-in: send anonymous error telemetry to the developer's worker so bugs
  // can be diagnosed without the user having to copy logs manually. Default off.
  telemetry?: boolean;
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

// ── Free tier limits ──

export const FREE_LIMITS = {
  cyclesPerDay: 1,
  cycleSize: 50,
} as const;

// ── Log entry ──

export interface LogEntry {
  ts: string;
  level: "INFO" | "WARNING" | "ERROR" | "DEBUG";
  category: string;
  message: string;
}
