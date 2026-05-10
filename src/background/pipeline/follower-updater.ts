/**
 * Follower update helpers — dedupe the patterns used across pipeline.ts.
 *
 * Each helper covers one transition in the follower lifecycle (scanned,
 * fake, removed, not-found). They preserve the OR-logic for `isPrivate`
 * and the nullish-fallback for follower count / full name / verified that
 * the previous inline blocks had to repeat a dozen times.
 */

import type { FollowerRecord } from "@shared/types";
import type { ContentProfileData } from "@shared/messages";
import { updateFollower } from "../storage";

/**
 * Merge fresh profile metadata onto an existing follower record.
 *
 * `isPrivate` uses OR-logic: if either the API followers feed or the DOM
 * scan ever saw the account as private, we keep that flag. The DOM scan
 * sometimes misses the private banner; the API value is authoritative when
 * available, but we never demote a previously-private account to public.
 */
export function mergeProfileData(
  existing: Pick<FollowerRecord, "followersCount" | "fullName" | "isPrivate" | "isVerified">,
  profile: ContentProfileData,
): Pick<FollowerRecord, "followersCount" | "fullName" | "isPrivate" | "isVerified"> {
  return {
    followersCount: profile.followerCount ?? existing.followersCount,
    fullName: profile.fullName || existing.fullName,
    isPrivate: profile.isPrivate || existing.isPrivate,
    isVerified: profile.isVerified ?? existing.isVerified,
  };
}

interface ScanVerdict {
  score: number;
  breakdown: string[];
}

/**
 * Mark a follower as scanned + fake (will be removed in the same cycle).
 */
export async function markFake(
  follower: FollowerRecord,
  verdict: ScanVerdict,
  profile: ContentProfileData,
): Promise<void> {
  await updateFollower(follower.username, {
    score: verdict.score,
    scoreBreakdown: JSON.stringify(verdict.breakdown),
    isFake: true,
    scanned: true,
    status: "fake",
    scannedAt: Date.now(),
    ...mergeProfileData(follower, profile),
  });
}

/**
 * Mark a follower as scanned + flagged for human review.
 */
export async function markToReview(
  follower: FollowerRecord,
  verdict: ScanVerdict,
  profile: ContentProfileData,
): Promise<void> {
  await updateFollower(follower.username, {
    score: verdict.score,
    scoreBreakdown: JSON.stringify(verdict.breakdown),
    isFake: false,
    toReview: true,
    scanned: true,
    status: "scanned",
    scannedAt: Date.now(),
    ...mergeProfileData(follower, profile),
  });
}

/**
 * Mark a follower as scanned + OK (legitimate, no action).
 */
export async function markOk(
  follower: FollowerRecord,
  verdict: ScanVerdict,
  profile: ContentProfileData,
): Promise<void> {
  await updateFollower(follower.username, {
    score: verdict.score,
    scoreBreakdown: JSON.stringify(verdict.breakdown),
    isFake: false,
    toReview: false,
    scanned: true,
    status: "scanned",
    scannedAt: Date.now(),
    ...mergeProfileData(follower, profile),
  });
}

/**
 * Mark a follower as removed (post-Threads-action). Idempotent.
 */
export async function markRemoved(username: string): Promise<void> {
  await updateFollower(username, {
    removed: true,
    status: "removed",
    removedAt: Date.now(),
  });
}

/**
 * Mark a profile that returned 404 — removed from Threads' side.
 *
 * We treat the not-found case as a confirmed fake (score 100) and write
 * both scanned + removed in one shot to avoid a second update pass.
 */
export async function markNotFound(username: string): Promise<void> {
  const now = Date.now();
  await updateFollower(username, {
    score: 100,
    scoreBreakdown: JSON.stringify(["not_found"]),
    isFake: true,
    scanned: true,
    removed: true,
    status: "removed",
    scannedAt: now,
    removedAt: now,
  });
}

/**
 * Mark a transient scan error — keeps the follower pending for retry.
 */
export async function markScanError(
  username: string,
  errorCode: string,
): Promise<void> {
  await updateFollower(username, {
    scanError: errorCode,
    status: "pending",
  });
}
