/**
 * Scorer — 9-step pure scoring algorithm (0-100).
 * Port from Python backend scorer.py — identical logic.
 *
 * Zero network deps — 100% unit-testable.
 * Each scored profile gets a full score_breakdown for auditability.
 */

// ── Username pattern detection ──────────────────────────────────────────────

const BOT_PATTERNS = [
  { re: /^[a-z]{1,6}\d{6,}$/i, pts: 20, label: "bot_digits" },
  { re: /^[a-z]{2,8}\d{5,}$/i, pts: 15, label: "name+digits" },
  { re: /^_.*_.*_.*_/,         pts: 10, label: "underscore_heavy" },
  { re: /^\d[\d_]{8,}$/,       pts: 25, label: "all_digits" },
  { re: /^[a-z]+\.[a-z]+\.\d{3,}$/i, pts: 15, label: "dot_dot_num" },
  { re: /^.{26,}$/,            pts: 10, label: "very_long" },
  { re: /[^aeiou_.\d]{6,}/i,   pts: 10, label: "no_vowels" },
];

export function scoreUsername(username) {
  let bonus = 0;
  const details = [];

  for (const { re, pts, label } of BOT_PATTERNS) {
    if (re.test(username)) {
      bonus += pts;
      details.push(`@pattern(${label}) +${pts}`);
    }
  }

  // Digit ratio
  const digitCount = [...username].filter(c => /\d/.test(c)).length;
  if (username.length > 4 && digitCount / username.length > 0.5) {
    bonus += 15;
    details.push(`@digit_ratio(${digitCount}/${username.length}) +15`);
  }

  return { bonus: Math.min(bonus, 30), details };
}


// ── Pre-scoring from metadata only ──────────────────────────────────────────

export function preScoreFromMetadata(username, followerCount, isPrivate, fullName, hasProfilePic) {
  let score = 0;
  const details = [];

  // Username patterns
  const { bonus, details: uDetails } = scoreUsername(username);
  score += bonus;
  details.push(...uDetails);

  // Follower count
  if (followerCount !== null && followerCount !== undefined) {
    if (followerCount === 0) { score += 15; details.push("pre:0abn +15"); }
    else if (followerCount <= 10) { score += 10; details.push(`pre:${followerCount}abn +10`); }
    else if (followerCount >= 500) { score -= 15; details.push(`pre:${followerCount}abn -15`); }
    else if (followerCount >= 100) { score -= 10; details.push(`pre:${followerCount}abn -10`); }
  }

  if (!hasProfilePic) { score += 20; details.push("pre:!pic +20"); }
  else { score -= 5; details.push("pre:pic -5"); }

  if (fullName && fullName.length >= 3) { score -= 5; details.push("pre:name -5"); }
  else if (!fullName) { score += 10; details.push("pre:!name +10"); }

  if (isPrivate && !fullName && !hasProfilePic) {
    score += 15;
    details.push("pre:private(!name,!pic) +15");
  }

  score = Math.max(0, Math.min(100, score));
  if (score >= 75) return { score, details };
  if (score <= 15) return { score, details };
  return { score: null, details }; // Inconclusive
}


// ── Full profile scoring ────────────────────────────────────────────────────

/**
 * @param {Object} data - Profile data extracted from page
 * @param {number} threshold - Score threshold for fake detection (default 60)
 * @returns {{ score: number, details: string[] }}
 */
export function scoreProfile(data, threshold = 60) {
  if (data.notFound) return { score: -1, details: ["Not found"] };
  if (data.error && data.error !== "429_RATE_LIMIT") return { score: -1, details: [data.error.substring(0, 40)] };
  if (data.isVerified) return { score: 0, details: ["Verified"] };

  let score = 0;
  const details = [];
  const fc = data.followerCount;

  // ── Step 0: Username pattern ──
  const { bonus: uBonus, details: uDetails } = scoreUsername(data.username);
  if (uBonus > 0) {
    score += uBonus;
    details.push(...uDetails);
  }

  // ── Step 1: Follower count ──
  if (fc !== null && fc !== undefined) {
    if (fc === 0) { score += 15; details.push("0abn +15"); }
    else if (fc <= 10) { score += 10; details.push(`${fc}abn +10`); }
    else if (fc <= 50) { score += 5; details.push(`${fc}abn +5`); }
    else if (fc >= 500) { score -= 10; details.push(`${fc}abn -10`); }
    else if (fc >= 100) { score -= 5; details.push(`${fc}abn -5`); }
  } else {
    score += 5; details.push("abn? +5");
  }

  // ── Step 2: Posts ──
  let hasPosts = false;
  let isSpambot = false;

  if (!data.isPrivate) {
    if (data.postCount === 0) {
      score += 35; details.push("0post +35");
    } else if (data.postCount <= 2) {
      score += 20; details.push(`${data.postCount}post +20`);
      if (data.allPostsRecent) { score += 20; details.push("spam(<72h) +20"); }
    } else if (data.postCount <= 4) {
      score += 10; details.push(`${data.postCount}post +10`);
      if (data.allPostsRecent) { score += 20; details.push("spam(<72h) +20"); }
    } else if (data.postCount >= 5) {
      hasPosts = true;
      score -= 15; details.push(`${data.postCount}post -15`);
    }

    // Spam detection
    if (data.duplicateRatio >= 0.5 && data.postCount >= 3) {
      isSpambot = true;
      if (hasPosts) { score += 15; details.push("dupes! cancel post"); }
      score += 40; details.push(`spam_dupes(${Math.round(data.duplicateRatio * 100)}%) +40`);
    }
    if (data.hasSpamKeywords) {
      score += 25; details.push("spam_keywords +25");
      isSpambot = true;
    }
  }

  // ── Step 3: Replies ──
  if (!data.isPrivate) {
    if (!data.hasReplies) {
      score += 25; details.push("0rep +25");
    } else if (isSpambot) {
      score += 10; details.push("rep_spam +10");
    } else if (hasPosts) {
      score -= 15; details.push("rep+posts -15");
    } else {
      score += 10; details.push("rep_no_post +10");
    }
  }

  // ── Step 4: Combos ──
  if (!data.isPrivate) {
    if (data.postCount === 0 && !data.hasReplies) {
      score += 20; details.push("combo(0p+0r) +20");
    }
    if (data.postCount === 0 && data.hasReplies) {
      score += 10; details.push("spammer(0p+rep) +10");
    }
    if (data.postCount >= 1 && data.postCount <= 4 && !data.hasReplies && !data.hasBio) {
      score += 10; details.push("inactive +10");
    }
  }

  // ── Step 5: Bio ──
  const zeroActivity = data.postCount === 0 && !data.hasReplies && !data.isPrivate;
  if (data.hasBio) {
    if (zeroActivity) { score -= 5; details.push("bio(inactive) -5"); }
    else { score -= 10; details.push("bio -10"); }
  } else {
    score += 15; details.push("!bio +15");
  }

  // ── Step 6: Private ──
  if (data.isPrivate) {
    const legit = [data.hasBio, data.hasLinkInBio, data.hasRealPic, data.hasIgLink]
      .filter(Boolean).length;
    if (legit >= 3) {
      score -= 15; details.push(`private(legit:${legit}sig) -15`);
    } else if (legit >= 2) {
      score -= 5; details.push(`private(semi:${legit}sig) -5`);
    } else if (fc !== null && fc < 10) {
      score += 40; details.push("private(<10abn) +40");
    } else if (fc !== null && fc < 30) {
      if (!data.hasBio && !data.hasRealPic) {
        score += 30; details.push("private(<30,!bio,!pic) +30");
      } else if (!data.hasBio || !data.hasRealPic) {
        score += 20; details.push("private(<30,partial) +20");
      } else {
        score += 5; details.push("private(<30,bio+pic) +5");
      }
    } else {
      score += 5; details.push("private(30+) +5");
    }
  }

  // ── Step 7: Full name ──
  if (data.hasFullName) { score -= 5; details.push("name -5"); }

  // ── Step 8: Legitimacy signals (links) ──
  if (data.hasLinkInBio) { score -= 15; details.push("link_bio -15"); }
  if (data.hasIgLink) { score -= 10; details.push("ig_link -10"); }

  return {
    score: Math.max(0, Math.min(100, score)),
    details,
  };
}
