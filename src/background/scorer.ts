/**
 * Scorer — 8-step pure scoring algorithm (0-100) + username heuristics + pre-scoring.
 *
 * Ported from backend/engine/scorer.py with identical logic.
 * Zero network deps — 100% unit-testable.
 *
 * Tuneable thresholds and weights live in @shared/scoring-config; this file
 * intentionally avoids hardcoded magic numbers for any signal that might be
 * adjusted for false-positive/false-negative tuning.
 */

import type { ProfileData, ScoredFollower } from "@shared/types";
import {
  DECISION,
  USERNAME,
  FC_BANDS,
  SIGHTINGS,
  RATIO,
  PRE_SCORE,
  WEIGHTS,
  POSTS,
  COMBOS,
  PRIVATE_ACCOUNT,
} from "@shared/scoring-config";

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
  if (username.length > USERNAME.minLength && digitCount / username.length > USERNAME.digitRatioCutoff) {
    bonus += USERNAME.digitRatioBonus;
    details.push(`@digit_ratio(${digitCount}/${username.length}) +${USERNAME.digitRatioBonus}`);
  }

  // Special char ratio: dots, underscores make up most of the non-digit portion
  const specialCount = [...username].filter((c) => /[._\-]/.test(c)).length;
  const nonLetterRatio = (digitCount + specialCount) / username.length;
  if (username.length > USERNAME.minLength && nonLetterRatio > USERNAME.nonLetterRatioCutoff) {
    bonus += USERNAME.nonLetterBonus;
    details.push(`@no_letters(${Math.round(nonLetterRatio * 100)}%) +${USERNAME.nonLetterBonus}`);
  }

  return { bonus: Math.min(bonus, DECISION.usernameBonusCap), details };
}

// ── Pre-scoring from metadata ──

export function preScoreFromMetadata(
  username: string,
  followerCount: number | null,
  isPrivate: boolean,
  fullName: string | null,
  hasProfilePic: boolean,
  hasBio?: boolean,   // from API biography field (reliable when provided)
  isVerified?: boolean,
  followingCount?: number | null,
  seenByCount?: number
): { score: number | null; details: string[] } {
  let score = 0;
  const details: string[] = [];

  // Verified badge — strong legitimacy signal
  if (isVerified) {
    score += PRE_SCORE.verifiedBonus;
    details.push(`pre:verified ${PRE_SCORE.verifiedBonus}`);
  }

  // Username patterns
  const { bonus, details: uDetails } = scoreUsername(username);
  score += bonus;
  details.push(...uDetails);

  // Follower count
  if (followerCount !== null) {
    if (followerCount === FC_BANDS.zero) {
      score += PRE_SCORE.fcZeroBonus;
      details.push(`pre:0abn +${PRE_SCORE.fcZeroBonus}`);
    } else if (followerCount <= FC_BANDS.veryLow) {
      score += PRE_SCORE.fcVeryLowBonus;
      details.push(`pre:${followerCount}abn +${PRE_SCORE.fcVeryLowBonus}`);
    } else if (followerCount >= FC_BANDS.high) {
      score += PRE_SCORE.fcHighPenalty;
      details.push(`pre:${followerCount}abn ${PRE_SCORE.fcHighPenalty}`);
    } else if (followerCount >= FC_BANDS.medium) {
      score += PRE_SCORE.fcMediumPenalty;
      details.push(`pre:${followerCount}abn ${PRE_SCORE.fcMediumPenalty}`);
    }
  }

  // No profile pic
  if (!hasProfilePic) {
    score += PRE_SCORE.noPicBonus;
    details.push(`pre:!pic +${PRE_SCORE.noPicBonus}`);
  }

  // Full name
  if (!fullName) {
    score += PRE_SCORE.noFullNameBonus;
    details.push(`pre:!name +${PRE_SCORE.noFullNameBonus}`);
  }

  // Private with no name and no pic → suspicious
  if (isPrivate && !fullName && !hasProfilePic) {
    score += PRE_SCORE.privateAnonymousBonus;
    details.push(`pre:private(!name,!pic) +${PRE_SCORE.privateAnonymousBonus}`);
  }

  // Private + < N followers + no bio = fake (API biography field is reliable)
  if (
    isPrivate &&
    hasBio === false &&
    followerCount !== null &&
    followerCount < PRE_SCORE.privateLowFollowersNoBio.maxFc
  ) {
    score += PRE_SCORE.privateLowFollowersNoBio.bonus;
    details.push(`pre:private(<${PRE_SCORE.privateLowFollowersNoBio.maxFc},!bio) +${PRE_SCORE.privateLowFollowersNoBio.bonus}`);
  }

  // Following/Follower ratio (metadata-level)
  if (followingCount !== null && followingCount !== undefined) {
    if (
      followerCount !== null &&
      followerCount > 0 &&
      followerCount < PRE_SCORE.massFollow.maxFc &&
      followingCount >= PRE_SCORE.massFollow.minFollowing
    ) {
      score += PRE_SCORE.massFollow.bonus;
      details.push(`pre:ratio(<${PRE_SCORE.massFollow.maxFc}abn,${followingCount}suivi) +${PRE_SCORE.massFollow.bonus}`);
    } else if (followerCount === 0 && followingCount >= PRE_SCORE.ghostFollow.minFollowing) {
      score += PRE_SCORE.ghostFollow.bonus;
      details.push(`pre:ghost(0abn,${followingCount}suivi) +${PRE_SCORE.ghostFollow.bonus}`);
    } else if (followerCount !== null && followerCount > 0) {
      const ratio = followingCount / followerCount;
      if (ratio >= PRE_SCORE.highRatio.minRatio) {
        score += PRE_SCORE.highRatio.bonus;
        details.push(`pre:ratio(${Math.round(ratio)}x) +${PRE_SCORE.highRatio.bonus}`);
      }
    }
  }

  // Cross-user sightings: other WFC2 users manually flagged this account
  if (seenByCount !== undefined && seenByCount >= SIGHTINGS.thresholdLow) {
    if (seenByCount >= SIGHTINGS.thresholdHigh) {
      score += SIGHTINGS.bonusHigh;
      details.push(`pre:cross_users(${seenByCount}) +${SIGHTINGS.bonusHigh}`);
    } else if (seenByCount >= SIGHTINGS.thresholdMid) {
      score += SIGHTINGS.bonusMid;
      details.push(`pre:cross_users(${seenByCount}) +${SIGHTINGS.bonusMid}`);
    } else {
      score += SIGHTINGS.bonusLow;
      details.push(`pre:cross_users(${seenByCount}) +${SIGHTINGS.bonusLow}`);
    }
  }

  // Decision: only pre-score obvious fakes. Low scores stay pending for full scan.
  score = Math.max(0, Math.min(100, score));

  // RULE: private + bio → never pre-score as fake, always needs full scan
  if (isPrivate && hasBio === true && score >= DECISION.preScoreFakeMin) {
    return { score: null, details }; // Force full scan instead of auto-flagging
  }

  if (score >= DECISION.preScoreFakeMin) return { score, details }; // Obvious fake → mark immediately

  return { score: null, details }; // Everything else needs full scan
}

// ── Pure scoring function (8 steps) ──

export function scoreProfile(
  data: ProfileData,
  threshold = 0,
  strictPrivate = false,
  followingCount?: number | null,
  seenByCount?: number
): ScoredFollower {
  if (data.notFound) {
    return { score: -1, breakdown: ["Not found"], isFake: false, toReview: false };
  }
  if (data.error && data.error !== "429_RATE_LIMIT") {
    return { score: -1, breakdown: [data.error.substring(0, 40)], isFake: false, toReview: false };
  }

  let score = 0;
  const details: string[] = [];
  const fc = data.followerCount;

  // ── Step 0: Verified badge (strong legitimacy signal, but not automatic OK) ──
  if (data.isVerified) {
    score += WEIGHTS.verified;
    details.push(`verified ${WEIGHTS.verified}`);
  }

  // ── Step 1: Username pattern ──
  const { bonus: uBonus, details: uDetails } = scoreUsername(data.username);
  if (uBonus > 0) {
    score += uBonus;
    details.push(...uDetails);
  }

  // ── Step 2: Follower count ──
  if (fc !== null) {
    if (fc === FC_BANDS.zero) {
      score += WEIGHTS.fcZero;
      details.push(`0abn +${WEIGHTS.fcZero}`);
    } else if (fc <= FC_BANDS.veryLow) {
      score += WEIGHTS.fcVeryLow;
      details.push(`${fc}abn +${WEIGHTS.fcVeryLow}`);
    } else if (fc <= FC_BANDS.low) {
      score += WEIGHTS.fcLow;
      details.push(`${fc}abn +${WEIGHTS.fcLow}`);
    } else if (fc >= FC_BANDS.high) {
      score += WEIGHTS.fcHigh;
      details.push(`${fc}abn ${WEIGHTS.fcHigh}`);
    } else if (fc >= FC_BANDS.medium) {
      score += WEIGHTS.fcMedium;
      details.push(`${fc}abn ${WEIGHTS.fcMedium}`);
    }
  } else {
    score += WEIGHTS.fcUnknown;
    details.push(`abn? +${WEIGHTS.fcUnknown}`);
  }

  // ── Step 2b: Following/Follower ratio ──
  if (followingCount !== null && followingCount !== undefined) {
    if (fc !== null && fc > 0) {
      const ratio = followingCount / fc;
      if (fc < RATIO.massFollowVeryHigh.maxFc && followingCount >= RATIO.massFollowVeryHigh.minFollowing) {
        // Very low followers + many following → mass-follow bot
        score += RATIO.massFollowVeryHigh.bonus;
        details.push(`ratio(<${RATIO.massFollowVeryHigh.maxFc}abn,${followingCount}suivi) +${RATIO.massFollowVeryHigh.bonus}`);
      } else if (followingCount >= RATIO.extremeRatio.minFollowing && fc < RATIO.extremeRatio.maxFc) {
        score += RATIO.extremeRatio.bonus;
        details.push(`ratio(${followingCount}/${fc}=${Math.round(ratio)}x) +${RATIO.extremeRatio.bonus}`);
      } else if (followingCount >= RATIO.highRatio.minFollowing && fc < RATIO.highRatio.maxFc) {
        score += RATIO.highRatio.bonus;
        details.push(`ratio(${followingCount}/${fc}=${Math.round(ratio)}x) +${RATIO.highRatio.bonus}`);
      } else if (fc < RATIO.massFollowSmall.maxFc && followingCount >= RATIO.massFollowSmall.minFollowing) {
        score += RATIO.massFollowSmall.bonus;
        details.push(`ratio(<${RATIO.massFollowSmall.maxFc}abn,${followingCount}suivi) +${RATIO.massFollowSmall.bonus}`);
      } else if (ratio >= RATIO.suspicious.minRatio) {
        score += RATIO.suspicious.bonus;
        details.push(`ratio(${Math.round(ratio)}x) +${RATIO.suspicious.bonus}`);
      } else if (ratio >= RATIO.elevated.minRatio) {
        score += RATIO.elevated.bonus;
        details.push(`ratio(${Math.round(ratio)}x) +${RATIO.elevated.bonus}`);
      } else if (ratio <= RATIO.creator.maxRatio && fc >= RATIO.creator.minFc) {
        // Followed by many, follows few → creator pattern → legit
        score += RATIO.creator.bonus;
        details.push(`ratio(${Math.round(ratio * 10) / 10}x,${fc}abn) ${RATIO.creator.bonus}`);
      }
    } else if (fc === 0 && followingCount >= RATIO.ghost.minFollowing) {
      // 0 followers but follows many → mass-follow bot
      score += RATIO.ghost.bonus;
      details.push(`ghost_follow(0abn,${followingCount}suivi) +${RATIO.ghost.bonus}`);
    }
  }

  // ── Step 3: Posts ──
  let hasPosts = false;
  let isSpambot = false;
  const postCountUnknown = data.postCount < 0; // -1 means unknown (metadata-only scan)

  if (!data.isPrivate) {
    if (postCountUnknown) {
      // Post count unknown (metadata-only scan) — don't add/subtract post points
      // This keeps the score neutral for posts, letting other signals decide
      details.push("post? (unknown)");
    } else if (data.postCount === 0) {
      score += WEIGHTS.zeroPosts;
      details.push(`0post +${WEIGHTS.zeroPosts}`);
    } else if (data.postCount <= POSTS.fewPostsMax) {
      score += WEIGHTS.fewPosts;
      details.push(`${data.postCount}post +${WEIGHTS.fewPosts}`);
      if (data.allPostsRecent) {
        score += WEIGHTS.spamRecent;
        details.push(`spam(<72h) +${WEIGHTS.spamRecent}`);
      }
    } else if (data.postCount <= POSTS.somePostsMax) {
      score += WEIGHTS.somePosts;
      details.push(`${data.postCount}post +${WEIGHTS.somePosts}`);
      if (data.allPostsRecent) {
        score += WEIGHTS.spamRecent;
        details.push(`spam(<72h) +${WEIGHTS.spamRecent}`);
      }
    } else if (data.postCount >= POSTS.activePostsMin) {
      hasPosts = true;
      score += WEIGHTS.activePosts;
      details.push(`${data.postCount}post ${WEIGHTS.activePosts}`);
    }

    // Step 2b: Spam detection (only when post count is known)
    if (!postCountUnknown && data.duplicateRatio >= POSTS.duplicateRatioMin && data.postCount >= POSTS.duplicateMinPosts) {
      isSpambot = true;
      if (hasPosts) {
        score += WEIGHTS.cancelDupePostBonus;
        details.push("dupes! cancel post");
      }
      score += WEIGHTS.duplicatePosts;
      details.push(`spam_dupes(${Math.round(data.duplicateRatio * 100)}%) +${WEIGHTS.duplicatePosts}`);
    }

    if (data.hasSpamKeywords) {
      score += WEIGHTS.spamKeywords;
      details.push(`spam_keywords +${WEIGHTS.spamKeywords}`);
      isSpambot = true;
    }
  }

  // ── Step 3: Replies ──
  if (!data.isPrivate) {
    if (postCountUnknown) {
      // Replies status is also unknown in metadata-only scan — skip
      details.push("rep? (unknown)");
    } else if (!data.hasReplies) {
      score += WEIGHTS.noReplies;
      details.push(`0rep +${WEIGHTS.noReplies}`);
    } else if (isSpambot) {
      score += WEIGHTS.repliesSpam;
      details.push(`rep_spam +${WEIGHTS.repliesSpam}`);
    } else if (hasPosts) {
      score += WEIGHTS.repliesActive;
      details.push(`rep+posts ${WEIGHTS.repliesActive}`);
    } else {
      score += WEIGHTS.repliesNoPosts;
      details.push(`rep_no_post +${WEIGHTS.repliesNoPosts}`);
    }
  }

  // ── Step 4: Combos ──
  if (!data.isPrivate && !postCountUnknown) {
    if (data.postCount === 0 && !data.hasReplies) {
      score += WEIGHTS.zeroPostsZeroReplies;
      details.push(`combo(0p+0r) +${WEIGHTS.zeroPostsZeroReplies}`);
    }
    if (data.postCount === 0 && data.hasReplies) {
      score += WEIGHTS.zeroPostsHasReplies;
      details.push(`spammer(0p+rep) +${WEIGHTS.zeroPostsHasReplies}`);
    }
    // Inactive: few posts, no replies, no bio → strong fake indicator
    if (
      data.postCount >= COMBOS.inactiveMinPosts &&
      data.postCount <= COMBOS.inactiveMaxPosts &&
      !data.hasReplies &&
      !data.hasBio
    ) {
      score += WEIGHTS.inactiveProfile;
      details.push(`inactive +${WEIGHTS.inactiveProfile}`);
    }
    // Low followers + very few posts + no replies = ghost account
    if (
      fc !== null &&
      fc <= COMBOS.ghostMaxFollowers &&
      data.postCount <= COMBOS.ghostMaxPosts &&
      !data.hasReplies
    ) {
      score += WEIGHTS.ghostAccount;
      details.push(`ghost(<${COMBOS.ghostMaxFollowers}abn,<${COMBOS.ghostMaxPosts + 1}post,0rep) +${WEIGHTS.ghostAccount}`);
    }
  }

  // ── Step 5: Bio ──
  const zeroActivity = data.postCount === 0 && !data.hasReplies && !data.isPrivate;
  if (data.hasBio) {
    if (zeroActivity) {
      score += WEIGHTS.bioInactive;
      details.push(`bio(inactive) ${WEIGHTS.bioInactive}`);
    } else {
      score += WEIGHTS.bio;
      details.push(`bio ${WEIGHTS.bio}`);
    }
  } else {
    score += WEIGHTS.noBio;
    details.push(`!bio +${WEIGHTS.noBio}`);
  }

  // ── Step 6: Private ──
  if (data.isPrivate) {
    if (strictPrivate) {
      score += PRIVATE_ACCOUNT.strictBonus;
      details.push(`private +${PRIVATE_ACCOUNT.strictBonus}`);
    } else {
      // Count legitimacy signals
      const legit = [data.hasBio, data.hasLinkInBio, data.hasRealPic, data.hasIgLink].filter(
        Boolean
      ).length;
      if (legit >= PRIVATE_ACCOUNT.legitSignalsHigh.min) {
        score += PRIVATE_ACCOUNT.legitSignalsHigh.bonus;
        details.push(`private(legit:${legit}sig) ${PRIVATE_ACCOUNT.legitSignalsHigh.bonus}`);
      } else if (legit >= PRIVATE_ACCOUNT.legitSignalsMid.min) {
        score += PRIVATE_ACCOUNT.legitSignalsMid.bonus;
        details.push(`private(semi:${legit}sig) ${PRIVATE_ACCOUNT.legitSignalsMid.bonus}`);
      } else if (fc !== null && fc < PRIVATE_ACCOUNT.veryLowFollowers.maxFc) {
        score += PRIVATE_ACCOUNT.veryLowFollowers.bonus;
        details.push(`private(<${PRIVATE_ACCOUNT.veryLowFollowers.maxFc}abn) +${PRIVATE_ACCOUNT.veryLowFollowers.bonus}`);
      } else if (fc !== null && fc < PRIVATE_ACCOUNT.lowFollowersAnon.maxFc) {
        if (!data.hasBio && !data.hasRealPic) {
          score += PRIVATE_ACCOUNT.lowFollowersAnon.bonus;
          details.push(`private(<${PRIVATE_ACCOUNT.lowFollowersAnon.maxFc},!bio,!pic) +${PRIVATE_ACCOUNT.lowFollowersAnon.bonus}`);
        } else if (!data.hasBio || !data.hasRealPic) {
          score += PRIVATE_ACCOUNT.lowFollowersPartial.bonus;
          details.push(`private(<${PRIVATE_ACCOUNT.lowFollowersPartial.maxFc},partial) +${PRIVATE_ACCOUNT.lowFollowersPartial.bonus}`);
        } else {
          score += PRIVATE_ACCOUNT.lowFollowersOk.bonus;
          details.push(`private(<${PRIVATE_ACCOUNT.lowFollowersOk.maxFc},bio+pic) +${PRIVATE_ACCOUNT.lowFollowersOk.bonus}`);
        }
      } else {
        score += PRIVATE_ACCOUNT.standard.bonus;
        details.push(`private(${PRIVATE_ACCOUNT.lowFollowersOk.maxFc}+) +${PRIVATE_ACCOUNT.standard.bonus}`);
      }

      // ── Private combo rules (additive, applied after base private scoring) ──
      // Rule 1: private + < N followers + no bio = fake
      // (real users who bother following you usually have at least a bio)
      if (!data.hasBio && fc !== null && fc < PRIVATE_ACCOUNT.noBioLowFollowers.maxFc) {
        score += PRIVATE_ACCOUNT.noBioLowFollowers.bonus;
        details.push(`private(<${PRIVATE_ACCOUNT.noBioLowFollowers.maxFc},!bio) +${PRIVATE_ACCOUNT.noBioLowFollowers.bonus}`);
      }
    }
  }

  // ── Step 7: Full name ──
  // IMPORTANT: Having a name is NOT a strong legitimacy signal (fakes often have realistic names)
  if (!data.hasFullName) {
    score += WEIGHTS.noFullName;
    details.push(`!name +${WEIGHTS.noFullName}`);
  }
  // Having a name: no bonus/penalty (was -5 before)

  // ── Step 8: Legitimacy signals (links + media) ──
  if (data.hasLinkInBio) {
    score += WEIGHTS.linkInBio;
    details.push(`link_bio ${WEIGHTS.linkInBio}`);
  }
  if (data.hasIgLink) {
    if (data.hasBio || data.hasLinkInBio) {
      score += WEIGHTS.igLinkWithBio;
      details.push(`ig_link(bio) ${WEIGHTS.igLinkWithBio}`);
    }
  }
  if (data.hasMedia) {
    score += WEIGHTS.hasMedia;
    details.push(`has_media ${WEIGHTS.hasMedia}`);
  }

  // ── Step 9: Cross-user sightings ──
  if (seenByCount !== undefined && seenByCount >= SIGHTINGS.thresholdLow) {
    if (seenByCount >= SIGHTINGS.thresholdHigh) {
      score += SIGHTINGS.bonusHigh;
      details.push(`cross_users(${seenByCount}) +${SIGHTINGS.bonusHigh}`);
    } else if (seenByCount >= SIGHTINGS.thresholdMid) {
      score += SIGHTINGS.bonusMid;
      details.push(`cross_users(${seenByCount}) +${SIGHTINGS.bonusMid}`);
    } else {
      score += SIGHTINGS.bonusLow;
      details.push(`cross_users(${seenByCount}) +${SIGHTINGS.bonusLow}`);
    }
  }

  let finalScore = Math.max(0, Math.min(100, score));
  const effectiveThreshold = threshold || DECISION.defaultFakeMin;

  // RULE: private + bio → always "to review", never auto-fake
  if (data.isPrivate && data.hasBio && finalScore >= effectiveThreshold) {
    finalScore = effectiveThreshold - 1;
    details.push("private+bio → review (cap)");
  }

  // SETTING: compte privé = toujours à vérifier (jamais fake auto)
  if (strictPrivate && data.isPrivate && finalScore >= effectiveThreshold) {
    finalScore = effectiveThreshold - 1;
    details.push("private → review (setting)");
  }

  return {
    score: finalScore,
    breakdown: details,
    isFake: finalScore >= effectiveThreshold,
    toReview: finalScore >= effectiveThreshold - DECISION.reviewWindow && finalScore < effectiveThreshold,
  };
}
