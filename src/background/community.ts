/**
 * Community voting — submit votes after scanning, lookup community scores.
 *
 * Only licensed users (with a communityToken) can submit votes.
 * Lookup is open to anyone (no auth required server-side).
 */

import { COMMUNITY_VOTE_URL, COMMUNITY_LOOKUP_URL, COMMUNITY_REPORT_SIGHTINGS_URL, COMMUNITY_CHECK_SIGHTINGS_URL } from "@shared/constants";
import { getLicense } from "./storage";

// ── Crypto helpers ──

async function sha256Hex(str: string): Promise<string> {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomNonce(): string {
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Types ──

export interface CommunityScore {
  voteCount: number;
  fakeRatio: number;      // 0.0–1.0
  consensusScore: number; // 0–100
}

// ── Submit vote ──
// Fire-and-forget: caller should .catch(() => {}) this.

export async function submitVote(
  username: string,
  verdict: "fake" | "ok" | "review",
  score: number,
): Promise<void> {
  const license = await getLicense();
  if (!license.active) return;
  // Use communityToken if available, otherwise fall back to the Stripe session ID directly
  const token = license.communityToken || license.key;
  if (!token) return;

  const targetHash = await sha256Hex(username.toLowerCase());
  const nonce = randomNonce();
  const ts = Date.now();

  await fetch(COMMUNITY_VOTE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetHash,
      communityToken: token,
      verdict,
      score,
      ts,
      nonce,
    }),
  });
}

// ── Report sightings (manual fake confirmations) ──
// Fire-and-forget: caller should .catch(() => {}) this.

export async function reportSightings(usernames: string[]): Promise<void> {
  if (usernames.length === 0) return;

  const license = await getLicense();
  if (!license.active) return;
  const token = license.communityToken || license.key;
  if (!token) return;

  const targetHashes: string[] = [];
  for (const u of usernames) {
    targetHashes.push(await sha256Hex(u.toLowerCase()));
  }

  await fetch(COMMUNITY_REPORT_SIGHTINGS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      communityToken: token,
      targetHashes,
      ts: Date.now(),
      nonce: randomNonce(),
    }),
  });
}

// ── Check sightings (no auth) ──

export async function checkSightings(usernames: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (usernames.length === 0) return result;

  const hashToUsername = new Map<string, string>();
  const targetHashes: string[] = [];
  for (const u of usernames) {
    const hash = await sha256Hex(u.toLowerCase());
    hashToUsername.set(hash, u);
    targetHashes.push(hash);
  }

  try {
    const res = await fetch(COMMUNITY_CHECK_SIGHTINGS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetHashes }),
    });
    if (!res.ok) return result;

    const data = (await res.json()) as { results: Record<string, number> };
    for (const [hash, count] of Object.entries(data.results || {})) {
      const username = hashToUsername.get(hash);
      if (username) result.set(username, count);
    }
  } catch {
    // Network error — non-critical
  }

  return result;
}

// ── Batch lookup ──

export async function batchLookup(
  usernames: string[],
): Promise<Map<string, CommunityScore>> {
  const result = new Map<string, CommunityScore>();
  if (usernames.length === 0) return result;

  // Build hash→username mapping
  const hashToUsername = new Map<string, string>();
  const targetHashes: string[] = [];

  for (const username of usernames) {
    const hash = await sha256Hex(username.toLowerCase());
    hashToUsername.set(hash, username);
    targetHashes.push(hash);
  }

  try {
    const res = await fetch(COMMUNITY_LOOKUP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetHashes }),
    });
    if (!res.ok) return result;

    const data = (await res.json()) as Record<
      string,
      { voteCount: number; fakeRatio: number; consensusScore: number }
    >;

    for (const [hash, score] of Object.entries(data)) {
      const username = hashToUsername.get(hash);
      if (username) result.set(username, score);
    }
  } catch {
    // Network error — return empty map, community features are non-critical
  }

  return result;
}
