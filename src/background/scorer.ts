/**
 * Scorer — 8-step pure scoring algorithm (0-100) + username heuristics + pre-scoring.
 *
 * Ported from backend/engine/scorer.py with identical logic.
 * Zero network deps — 100% unit-testable.
 */

import type { ProfileData, ScoredFollower } from "@shared/types";

// ── Username pattern detection ──

interface UsernamePattern {
  regex: RegExp;
  points: number;
  label: string;
}

const BOT_USERNAME_PATTERNS: UsernamePattern[] = [
  // ── HIGH confidence patterns ──

  // Pure numeric with dots/separators: 32.870568, 123_456_789
  { regex: /^\d[\d._]{4,}$/, points: 30, label: "pure_numeric" },
  // Digit.digit pattern: 32.870568
  { regex: /^\d+\.\d+$/, points: 25, label: "digit_dot_digit" },
  // Mostly digits: user738291637
  { regex: /^[a-z]{1,6}\d{6,}$/i, points: 20, label: "bot_digits" },
  // All digits except maybe 1-2 letters or underscores
  { regex: /^\d[\d_]{8,}$/, points: 25, label: "all_digits" },

  // ── MEDIUM confidence patterns ──

  // Random string ending with many digits: sara847362
  { regex: /^[a-z]{2,8}\d{5,}$/i, points: 15, label: "name+digits" },
  // Pattern: word.word.digits (common bot pattern)
  { regex: /^[a-z]+\.[a-z]+\.\d{3,}$/i, points: 15, label: "dot_dot_num" },
  // Digits then name: 123john, 456_sara
  { regex: /^\d{3,}[._]?[a-z]{2,}$/i, points: 15, label: "digits_then_name" },

  // ── LOW confidence patterns ──

  // Underscore-heavy: __x_x__y__
  { regex: /^_.*_.*_.*_/, points: 10, label: "underscore_heavy" },
  // Very long usernames (>25 chars)
  { regex: /^.{26,}$/, points: 10, label: "very_long" },
  // Random consonant clusters (no vowels in 5+ char stretch)
  { regex: /[^aeiou_.\\d]{6,}/i, points: 10, label: "no_vowels" },
];

export function scoreUsername(username: string): { bonus: number; details: string[] } {
  let bonus = 0;
  const details: string[] = [];

  for (const { regex, points, label } of BOT_USERNAME_PATTERNS) {
    if (regex.test(username)) {
      bonus += points;
      details.push(`@pattern(${label}) +${points}`);
    }
  }

  // Digit ratio: if >50% of username is digits
  const digitCount = [...username].filter((c) => /\d/.test(c)).length;
  if (username.length > 4 && digitCount / username.length > 0.5) {
    bonus += 15;
    details.push(`@digit_ratio(${digitCount}/${username.length}) +15`);
  }

  // Special char ratio: dots, underscores make up most of the non-digit portion
  const specialCount = [...username].filter((c) => /[._\-]/.test(c)).length;
  const nonLetterRatio = (digitCount + specialCount) / username.length;
  if (username.length > 4 && nonLetterRatio > 0.8) {
    bonus += 10;
    details.push(`@no_letters(${Math.round(nonLetterRatio * 100)}%) +10`);
  }

  return { bonus: Math.min(bonus, 45), details }; // Cap at +45 (was 30)
}

// ── Pre-scoring from metadata ──

export function preScoreFromMetadata(
  username: string,
  followerCount: number | null,
  isPrivate: boolean,
  fullName: string | null,
  hasProfilePic: boolean
): { score: number | null; details: string[] } {
  let score = 0;
  const details: string[] = [];

  // Username patterns
  const { bonus, details: uDetails } = scoreUsername(username);
  score += bonus;
  details.push(...uDetails);

  // Follower count
  if (followerCount !== null) {
    if (followerCount === 0) {
      score += 15;
      details.push("pre:0abn +15");
    } else if (followerCount <= 10) {
      score += 10;
      details.push(`pre:${followerCount}abn +10`);
    } else if (followerCount >= 500) {
      score -= 15;
      details.push(`pre:${followerCount}abn -15`);
    } else if (followerCount >= 100) {
      score -= 10;
      details.push(`pre:${followerCount}abn -10`);
    }
  }

  // No profile pic — bonus, but having one is NOT a legitimacy signal (fakes have pics)
  if (!hasProfilePic) {
    score += 20;
    details.push("pre:!pic +20");
  }
  // Having a pic subtracts nothing (was -5 before — fakes often have pics)

  // Full name — subtracts very little (fakes often have realistic names)
  if (!fullName) {
    score += 10;
    details.push("pre:!name +10");
  }
  // Having a name subtracts nothing (was -5 before)

  // Private with no name and no pic → suspicious
  if (isPrivate && !fullName && !hasProfilePic) {
    score += 15;
    details.push("pre:private(!name,!pic) +15");
  }

  // Decision: only pre-score obvious fakes. Low scores stay pending for full scan.
  score = Math.max(0, Math.min(100, score));
  if (score >= 75) return { score, details }; // Obvious fake → mark immediately

  return { score: null, details }; // Everything else needs full scan
}

// ── Pure scoring function (8 steps) ──

export function scoreProfile(
  data: ProfileData,
  threshold = 0,
  strictPrivate = false
): ScoredFollower {
  if (data.notFound) {
    return { score: -1, breakdown: ["Not found"], isFake: false, toReview: false };
  }
  if (data.error && data.error !== "429_RATE_LIMIT") {
    return { score: -1, breakdown: [data.error.substring(0, 40)], isFake: false, toReview: false };
  }
  if (data.isVerified) {
    return { score: 0, breakdown: ["Verified"], isFake: false, toReview: false };
  }

  let score = 0;
  const details: string[] = [];
  const fc = data.followerCount;

  // ── Step 0: Username pattern ──
  const { bonus: uBonus, details: uDetails } = scoreUsername(data.username);
  if (uBonus > 0) {
    score += uBonus;
    details.push(...uDetails);
  }

  // ── Step 1: Follower count ──
  if (fc !== null) {
    if (fc === 0) {
      score += 15;
      details.push("0abn +15");
    } else if (fc <= 10) {
      score += 10;
      details.push(`${fc}abn +10`);
    } else if (fc <= 50) {
      score += 5;
      details.push(`${fc}abn +5`);
    } else if (fc >= 500) {
      score -= 10;
      details.push(`${fc}abn -10`);
    } else if (fc >= 100) {
      score -= 5;
      details.push(`${fc}abn -5`);
    }
  } else {
    score += 5;
    details.push("abn? +5");
  }

  // ── Step 2: Posts ──
  let hasPosts = false;
  let isSpambot = false;
  const postCountUnknown = data.postCount < 0; // -1 means unknown (metadata-only scan)

  if (!data.isPrivate) {
    if (postCountUnknown) {
      // Post count unknown (metadata-only scan) — don't add/subtract post points
      // This keeps the score neutral for posts, letting other signals decide
      details.push("post? (unknown)");
    } else if (data.postCount === 0) {
      score += 35;
      details.push("0post +35");
    } else if (data.postCount <= 2) {
      score += 25;
      details.push(`${data.postCount}post +25`);
      if (data.allPostsRecent) {
        score += 20;
        details.push("spam(<72h) +20");
      }
    } else if (data.postCount <= 4) {
      score += 15;
      details.push(`${data.postCount}post +15`);
      if (data.allPostsRecent) {
        score += 20;
        details.push("spam(<72h) +20");
      }
    } else if (data.postCount >= 5) {
      hasPosts = true;
      score -= 15;
      details.push(`${data.postCount}post -15`);
    }

    // Step 2b: Spam detection (only when post count is known)
    if (!postCountUnknown && data.duplicateRatio >= 0.5 && data.postCount >= 3) {
      isSpambot = true;
      if (hasPosts) {
        score += 15;
        details.push("dupes! cancel post");
      }
      score += 40;
      details.push(`spam_dupes(${Math.round(data.duplicateRatio * 100)}%) +40`);
    }

    if (data.hasSpamKeywords) {
      score += 25;
      details.push("spam_keywords +25");
      isSpambot = true;
    }
  }

  // ── Step 3: Replies ──
  if (!data.isPrivate) {
    if (postCountUnknown) {
      // Replies status is also unknown in metadata-only scan — skip
      details.push("rep? (unknown)");
    } else if (!data.hasReplies) {
      score += 25;
      details.push("0rep +25");
    } else if (isSpambot) {
      score += 10;
      details.push("rep_spam +10");
    } else if (hasPosts) {
      score -= 15;
      details.push("rep+posts -15");
    } else {
      score += 10;
      details.push("rep_no_post +10");
    }
  }

  // ── Step 4: Combos ──
  if (!data.isPrivate && !postCountUnknown) {
    if (data.postCount === 0 && !data.hasReplies) {
      score += 20;
      details.push("combo(0p+0r) +20");
    }
    if (data.postCount === 0 && data.hasReplies) {
      score += 10;
      details.push("spammer(0p+rep) +10");
    }
    // Inactive: few posts, no replies, no bio → strong fake indicator
    if (data.postCount >= 1 && data.postCount <= 4 && !data.hasReplies && !data.hasBio) {
      score += 15;
      details.push("inactive +15");
    }
    // Low followers + very few posts + no replies = ghost account
    if (fc !== null && fc <= 50 && data.postCount <= 2 && !data.hasReplies) {
      score += 10;
      details.push("ghost(<50abn,<3post,0rep) +10");
    }
  }

  // ── Step 5: Bio ──
  const zeroActivity = data.postCount === 0 && !data.hasReplies && !data.isPrivate;
  if (data.hasBio) {
    if (zeroActivity) {
      score -= 5;
      details.push("bio(inactive) -5");
    } else {
      score -= 10;
      details.push("bio -10");
    }
  } else {
    score += 20;
    details.push("!bio +20");
  }

  // ── Step 6: Private ──
  if (data.isPrivate) {
    if (strictPrivate) {
      score += 10;
      details.push("private +10");
    } else {
      // Count legitimacy signals
      const legit = [data.hasBio, data.hasLinkInBio, data.hasRealPic, data.hasIgLink].filter(
        Boolean
      ).length;
      if (legit >= 3) {
        score -= 15;
        details.push(`private(legit:${legit}sig) -15`);
      } else if (legit >= 2) {
        score -= 5;
        details.push(`private(semi:${legit}sig) -5`);
      } else if (fc !== null && fc < 10) {
        score += 40;
        details.push("private(<10abn) +40");
      } else if (fc !== null && fc < 30) {
        if (!data.hasBio && !data.hasRealPic) {
          score += 30;
          details.push("private(<30,!bio,!pic) +30");
        } else if (!data.hasBio || !data.hasRealPic) {
          score += 20;
          details.push("private(<30,partial) +20");
        } else {
          score += 5;
          details.push("private(<30,bio+pic) +5");
        }
      } else {
        score += 5;
        details.push("private(30+) +5");
      }
    }
  }

  // ── Step 7: Full name ──
  // IMPORTANT: Having a name is NOT a strong legitimacy signal (fakes often have realistic names)
  if (!data.hasFullName) {
    score += 5;
    details.push("!name +5");
  }
  // Having a name: no bonus/penalty (was -5 before)

  // ── Step 8: Legitimacy signals (links) ──
  if (data.hasLinkInBio) {
    score -= 15;
    details.push("link_bio -15");
  }
  if (data.hasIgLink) {
    // Only deduct if there's also a bio (real IG link)
    // An instagram link inside a post should NOT count as legitimacy
    if (data.hasBio || data.hasLinkInBio) {
      score -= 10;
      details.push("ig_link(bio) -10");
    }
    // else: IG link is from a repost, don't reward it
  }

  const finalScore = Math.max(0, Math.min(100, score));
  const effectiveThreshold = threshold || 70;

  return {
    score: finalScore,
    breakdown: details,
    isFake: finalScore >= effectiveThreshold,
    toReview: finalScore >= effectiveThreshold - 20 && finalScore < effectiveThreshold,
  };
}
