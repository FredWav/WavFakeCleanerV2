// ── Follower profile data (from API or DOM scraping) ──

export interface FollowerProfile {
  username: string;
  fullName: string;
  bio: string;
  followersCount: number | null;
  followingCount: number | null;
  postsCount: number | null;
  hasProfilePic: boolean;
  isPrivate: boolean;
  isVerified: boolean;
  mediaCount: number | null;
  externalUrl: string;
  bioLinks: string[];
}

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

export type PipelineStage = "idle" | "fetching" | "scanning" | "cleaning" | "autopilot";

export interface PipelineState {
  stage: PipelineStage;
  sessionId: number | null;
  progress: number;
  total: number;
  lastError: string | null;
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
  rate: {
    actionsToday: number;
    actionsThisHour: number;
    limitDay: number;
    limitHour: number;
    consecutiveErrors: number;
  };
}

// ── Settings ──

export type SafetyProfile = "gratuit" | "prudent" | "normal" | "agressif";

export interface Settings {
  threadsUsername: string;
  scoreThreshold: number;
  safetyProfile: SafetyProfile;
}

// ── License ──

export interface LicenseInfo {
  active: boolean;
  key: string | null;
  activatedAt: number | null;
}

// ── Free tier limits ──

export const FREE_LIMITS = {
  scansPerDay: 200,
  removalsPerDay: 50,
} as const;

// ── Log entry ──

export interface LogEntry {
  ts: string;
  level: "INFO" | "WARNING" | "ERROR" | "DEBUG";
  category: string;
  message: string;
}
