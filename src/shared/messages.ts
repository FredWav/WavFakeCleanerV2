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
  | { type: "GET_FOLLOWERS"; payload: { filter?: string; limit?: number } }
  | { type: "GET_SETTINGS" }
  | { type: "UPDATE_SETTINGS"; payload: Partial<Settings> }
  | { type: "START_FETCH" }
  | { type: "START_SCAN"; payload?: { batchSize?: number } }
  | { type: "START_CLEAN"; payload?: { batchSize?: number } }
  | { type: "START_AUTOPILOT" }
  | { type: "STOP" }
  | { type: "RESET_SCANNED" }
  | { type: "APPROVE_FOLLOWER"; payload: { username: string } }
  | { type: "REJECT_FOLLOWER"; payload: { username: string } }
  | { type: "GET_LICENSE" }
  | { type: "ACTIVATE_LICENSE"; payload: { key: string } }
  | { type: "KEEPALIVE_PING" };

// Messages FROM service worker TO sidepanel (broadcast)
export type BroadcastMessage =
  | { type: "LOG_EVENT"; payload: LogEntry }
  | { type: "STATS_UPDATED"; payload: Stats }
  | { type: "PIPELINE_STATE"; payload: PipelineState };

// Messages FROM content script TO service worker
export type ContentMessage =
  | { type: "FOLLOWERS_DATA"; payload: { users: Record<string, ContentFollowerMeta> } }
  | { type: "PROFILE_DATA"; payload: ContentProfileData }
  | { type: "ACTION_RESULT"; payload: { username: string; action: string; success: boolean; error?: string } }
  | { type: "CONTENT_READY" }
  | { type: "RATE_LIMIT_DETECTED" }
  | { type: "LOG_FROM_CONTENT"; payload: { level: string; category: string; message: string } }
  | { type: "FETCH_PROGRESS"; payload: { page: number; total: number } };

// Messages FROM service worker TO content script
export type ContentCommand =
  | { type: "FETCH_FOLLOWERS"; payload: { username: string } }
  | { type: "SCAN_PROFILE"; payload: { username: string } }
  | { type: "REMOVE_FOLLOWER"; payload: { username: string } }
  | { type: "FETCH_PROFILE_API"; payload: { username: string } }
  | { type: "PING" };

// Content script follower metadata
export interface ContentFollowerMeta {
  followerCount: number | null;
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
  error: string | null;
}
