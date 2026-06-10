// ── Message types for chrome.runtime messaging ──

import type {
  Stats,
  Settings,
  FollowerRecord,
  LogEntry,
  PipelineState,
} from "./types";

// Messages FROM sidepanel/popup TO service worker
export type RequestMessage =
  | { type: "GET_STATS" }
  | { type: "GET_FOLLOWERS"; payload: { filter?: string; limit?: number; search?: string } }
  | { type: "GET_SETTINGS" }
  | { type: "UPDATE_SETTINGS"; payload: Partial<Settings> }
  | { type: "START_FETCH" }
  | { type: "START_CLEAN" }
  | { type: "START_CONTINUOUS" }
  | { type: "STOP" }
  | { type: "RESET_SCANNED" }
  | { type: "APPROVE_FOLLOWER"; payload: { username: string } }
  | { type: "REJECT_FOLLOWER"; payload: { username: string } }
  | { type: "SUBMIT_COMMUNITY_VOTE"; payload: { username: string; verdict: "fake" | "ok"; score: number } }
  | { type: "GET_COMMUNITY_STATUS" }
  | { type: "COMMUNITY_REPLAY_NOW" }
  // Sent by the sidepanel when its community-score lookup fails, so the
  // failure is counted/surfaced instead of dying in a silent catch.
  | { type: "COMMUNITY_LOOKUP_FAILED"; payload: { httpStatus: number | null } }
  | { type: "GET_LICENSE" }
  | { type: "ACTIVATE_LICENSE"; payload: { key: string } }
  | { type: "EXPORT_LICENSE" }
  | { type: "IMPORT_LICENSE"; payload: { backup: unknown } }
  | { type: "KEEPALIVE_PING" };

// Messages FROM service worker TO sidepanel (broadcast)
export type BroadcastMessage =
  | { type: "LOG_EVENT"; payload: LogEntry }
  | { type: "STATS_UPDATED"; payload: Stats }
  | { type: "PIPELINE_STATE"; payload: PipelineState }
  // Lightweight ping after any community status change (vote sent/queued/
  // dropped, replay, token check) — the CommunityCard refetches on it.
  | { type: "COMMUNITY_STATUS_UPDATED" };

// Messages FROM content script TO service worker
export type ContentMessage =
  | { type: "CONTENT_READY" }
  | { type: "RATE_LIMIT_DETECTED" }
  | { type: "LOG_FROM_CONTENT"; payload: { level: string; category: string; message: string } }
  // Selector drift: a fallback strategy won over the primary selector. The SW
  // rebroadcasts a LOG_EVENT (UI toast) and reports it to telemetry so stale
  // selectors are visible fleet-wide before they break entirely.
  | { type: "DRIFT_DETECTED"; payload: { lookup: string; winningStrategy: string; rank: number } }
  | { type: "FETCH_PROGRESS"; payload: { page: number; total: number } }
  // Sent after every page of followers is fetched, so the background can persist
  // incrementally and never lose progress when the user clicks Stop.
  | { type: "FOLLOWERS_PAGE"; payload: { users: Record<string, ContentFollowerMeta> } };

// Messages FROM service worker TO content script
export type ContentCommand =
  | { type: "FETCH_FOLLOWERS"; payload: { username: string; knownUsernames?: string[] } }
  | { type: "SCAN_PROFILE"; payload: { username: string } }
  | { type: "REMOVE_FOLLOWER"; payload: { username: string } }
  | { type: "CHECK_PAGE" }
  | { type: "PING" }
  | { type: "STOP_CONTENT" };

// Content script follower metadata
export interface ContentFollowerMeta {
  followerCount: number | null;
  followingCount: number | null;
  isVerified: boolean;
  fullName: string;
  isPrivate: boolean;
  hasProfilePic: boolean;
  biography: string;
  bioLinks: string[];
  externalUrl: string;
}

// Content script profile data (from page visit or API)
export interface ContentProfileData {
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
