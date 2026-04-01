/**
 * Messaging — chrome.runtime.sendMessage wrappers.
 * Replaces frontend/src/lib/api.js (REST calls → message passing).
 */

import type { RequestMessage } from "@shared/messages";
import type { Stats, FollowerRecord, Settings, LicenseInfo } from "@shared/types";

async function send<T>(message: RequestMessage): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

export const api = {
  getStats: () => send<Stats>({ type: "GET_STATS" }),

  getFollowers: (filter?: string, limit = 200) =>
    send<(FollowerRecord & { profile_url: string })[]>({
      type: "GET_FOLLOWERS",
      payload: { filter, limit },
    }),

  getSettings: () => send<Settings>({ type: "GET_SETTINGS" }),

  updateSettings: (settings: Partial<Settings>) =>
    send<Settings>({ type: "UPDATE_SETTINGS", payload: settings }),

  fetch: () => send<{ ok: boolean }>({ type: "START_FETCH" }),

  scan: (batchSize?: number) =>
    send<{ ok: boolean }>({ type: "START_SCAN", payload: { batchSize } }),

  clean: (batchSize?: number) =>
    send<{ ok: boolean }>({ type: "START_CLEAN", payload: { batchSize } }),

  autopilot: () => send<{ ok: boolean }>({ type: "START_AUTOPILOT" }),

  stop: () => send<{ ok: boolean }>({ type: "STOP" }),

  resetScanned: () => send<{ ok: boolean; count: number }>({ type: "RESET_SCANNED" }),

  approveFollower: (username: string) =>
    send<{ ok: boolean }>({ type: "APPROVE_FOLLOWER", payload: { username } }),

  rejectFollower: (username: string) =>
    send<{ ok: boolean }>({ type: "REJECT_FOLLOWER", payload: { username } }),

  getLicense: () => send<LicenseInfo>({ type: "GET_LICENSE" }),

  activateLicense: (key: string) =>
    send<{ ok: boolean; error?: string }>({ type: "ACTIVATE_LICENSE", payload: { key } }),
};
