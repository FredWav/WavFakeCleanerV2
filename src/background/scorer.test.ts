import { describe, it, expect } from "vitest";
import { scoreUsername, preScoreFromMetadata, scoreProfile } from "./scorer";
import type { ProfileData } from "@shared/types";

/**
 * Regression lock for the scoring engine (the core value of the app).
 *
 * These tests pin the CURRENT behavior so any tweak to scoring-config.ts is
 * caught. Where a test documents a known-aggressive verdict (private accounts),
 * the comment says so — those are the cases task A3 ("durcir les privés") would
 * deliberately change, at which point the expectation should be updated.
 */

function makeProfile(overrides: Partial<ProfileData> = {}): ProfileData {
  return {
    username: "realuser",
    notFound: false,
    isPrivate: false,
    isVerified: false,
    followerCount: 300,
    postCount: 12,
    hasBio: true,
    hasReplies: true,
    hasRealPic: true,
    hasFullName: true,
    hasIgLink: false,
    hasLinkInBio: false,
    fullName: "Real User",
    allPostsRecent: false,
    duplicateRatio: 0,
    hasSpamKeywords: false,
    hasMedia: true,
    error: null,
    ...overrides,
  };
}

describe("scoreUsername", () => {
  it("flags numeric / bot-like usernames", () => {
    expect(scoreUsername("32.870568").bonus).toBeGreaterThanOrEqual(25);
    expect(scoreUsername("user738291637").bonus).toBeGreaterThan(0);
  });

  it("leaves a normal human username untouched", () => {
    expect(scoreUsername("johndoe").bonus).toBe(0);
  });

  it("never exceeds the username bonus cap (45)", () => {
    // Long, all-digits, high digit ratio → many overlapping patterns.
    expect(scoreUsername("1234567890123456789012345678").bonus).toBeLessThanOrEqual(45);
  });
});

describe("scoreProfile", () => {
  it("treats an active, real public account as OK", () => {
    const r = scoreProfile(makeProfile(), 70, false, undefined, undefined);
    expect(r.isFake).toBe(false);
    expect(r.toReview).toBe(false);
  });

  it("flags a clearly empty public account as fake", () => {
    const r = scoreProfile(
      makeProfile({
        username: "abcuser",
        followerCount: 0,
        postCount: 0,
        hasReplies: false,
        hasBio: false,
        hasRealPic: false,
        hasFullName: false,
        hasMedia: false,
      }),
      70,
    );
    expect(r.isFake).toBe(true);
    expect(r.score).toBe(100);
  });

  it("keeps a creator (many followers, follows few) as OK", () => {
    const r = scoreProfile(
      makeProfile({ followerCount: 5000, postCount: 50 }),
      70,
      false,
      100, // followingCount → ratio 0.02 (creator pattern)
    );
    expect(r.isFake).toBe(false);
  });

  it("never auto-flags a private account that has a bio (caps to review)", () => {
    // Safety rule scorer.ts:512 — private + bio must never become auto-fake.
    const r = scoreProfile(
      makeProfile({
        username: "user12345678",
        isPrivate: true,
        hasBio: true,
        followerCount: 5,
        hasRealPic: false,
        hasFullName: false,
        hasMedia: false,
      }),
      70,
    );
    expect(r.isFake).toBe(false);
  });

  it("returns score -1 for a not-found profile", () => {
    expect(scoreProfile(makeProfile({ notFound: true }), 70).score).toBe(-1);
  });

  it("[B-C1/TEST-c] neutralizes post signals when postCount is unknown (-1)", () => {
    // Cœur du fix B-C1 : une page non chargée ne doit pas devenir un faux. Même
    // profil public, seul postCount change : 0 confirmé → faux ; -1 inconnu → OK.
    const base = {
      username: "abcuser",
      followerCount: 300,
      hasBio: false,
      hasReplies: false,
      hasRealPic: true,
      hasFullName: false,
      hasMedia: false,
    } as const;
    // 0 post CONFIRMÉ → les signaux posts comptent → faux.
    expect(scoreProfile(makeProfile({ ...base, postCount: 0 }), 70).isFake).toBe(true);
    // postCount inconnu (-1) → signaux posts/replies/combos neutralisés → pas faux.
    const unknown = scoreProfile(makeProfile({ ...base, postCount: -1 }), 70);
    expect(unknown.isFake).toBe(false);
    expect(unknown.breakdown.join(" ")).toContain("post? (unknown)");
  });

  it("[CURRENT BEHAVIOR — A3 would change] auto-fakes a private account with 0 followers and no bio", () => {
    // Documents the false-positive risk flagged in the audit: a brand-new real
    // private user (no bio/pic yet) scores 100 and is removed. If A3 is shipped,
    // update this expectation to isFake:false / toReview.
    const r = scoreProfile(
      makeProfile({
        username: "abcuser",
        isPrivate: true,
        followerCount: 0,
        hasBio: false,
        hasRealPic: false,
        hasFullName: false,
        hasMedia: false,
        postCount: 0,
        hasReplies: false,
      }),
      70,
    );
    expect(r.isFake).toBe(true);
  });
});

describe("preScoreFromMetadata", () => {
  it("auto-flags an obvious metadata-only fake (score >= 75)", () => {
    const r = preScoreFromMetadata("user12345678", 0, false, null, false, false, false, 200);
    expect(r.score).toBe(100);
  });

  it("defers a legitimate account to full scan (null)", () => {
    const r = preScoreFromMetadata("johndoe", 500, false, "John Doe", true, true, true, 100);
    expect(r.score).toBeNull();
  });

  it("never pre-scores a private account WITH a bio (forces full scan)", () => {
    const r = preScoreFromMetadata("user12345678", 0, true, null, false, true, false, 200);
    expect(r.score).toBeNull();
  });
});
