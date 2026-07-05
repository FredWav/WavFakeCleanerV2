/**
 * Messaging — chrome.runtime.sendMessage wrappers.
 * Replaces frontend/src/lib/api.js (REST calls → message passing).
 */

import type { RequestMessage } from "@shared/messages";
import type { Stats, FollowerRecord, Settings, LicenseInfo, CommunityStatus } from "@shared/types";

async function send<T>(message: RequestMessage): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

export const api = {
  getStats: () => send<Stats>({ type: "GET_STATS" }),

  getFollowers: (filter?: string, limit = 200, search?: string) =>
    send<(FollowerRecord & { profile_url: string })[]>({
      type: "GET_FOLLOWERS",
      payload: { filter, limit, search },
    }),

  getSettings: () => send<Settings>({ type: "GET_SETTINGS" }),

  updateSettings: (settings: Partial<Settings>) =>
    send<Settings>({ type: "UPDATE_SETTINGS", payload: settings }),

  fetch: () => send<{ ok: boolean }>({ type: "START_FETCH" }),

  clean: () =>
    send<{ ok: boolean }>({ type: "START_CLEAN" }),

  analyze: () => send<{ ok: boolean }>({ type: "START_ANALYZE" }),

  rescanAll: () => send<{ ok: boolean }>({ type: "START_RESCAN_ALL" }),

  // usernames = sélection explicite (U-C2). Omis = supprime tous les faux flaggés.
  removeFakes: (usernames?: string[]) =>
    send<{ ok: boolean }>({
      type: "START_REMOVE_FAKES",
      payload: usernames && usernames.length ? { usernames } : undefined,
    }),

  continuous: () => send<{ ok: boolean }>({ type: "START_CONTINUOUS" }),

  stop: () => send<{ ok: boolean }>({ type: "STOP" }),

  resetScanned: () => send<{ ok: boolean; count: number }>({ type: "RESET_SCANNED" }),

  approveFollower: (username: string) =>
    send<{ ok: boolean }>({ type: "APPROVE_FOLLOWER", payload: { username } }),

  rejectFollower: (username: string) =>
    send<{ ok: boolean }>({ type: "REJECT_FOLLOWER", payload: { username } }),

  submitCommunityVote: (username: string, verdict: "fake" | "ok", score: number) =>
    send<{ ok: boolean; error?: string }>({
      type: "SUBMIT_COMMUNITY_VOTE",
      payload: { username, verdict, score },
    }),

  getCommunityStatus: () => send<CommunityStatus>({ type: "GET_COMMUNITY_STATUS" }),

  replayCommunityQueue: () =>
    send<{ replayed: number; dropped: number; remaining: number }>({ type: "COMMUNITY_REPLAY_NOW" }),

  getPrescanEstimate: () =>
    send<{ likelyFakes: number; total: number }>({ type: "GET_PRESCAN_ESTIMATE" }),

  // Plus de paiement ni de licence : l'app est entièrement gratuite. getLicense
  // renvoie toujours un accès actif (le SW le force), gardé pour que l'UI lise
  // simplement cet état.
  getLicense: () => send<LicenseInfo>({ type: "GET_LICENSE" }),
};
