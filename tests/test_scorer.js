/**
 * Tests for the JavaScript scorer module.
 * Run with: node tests/test_scorer.js
 */

import { scoreUsername, preScoreFromMetadata, scoreProfile } from "../extension/background/scorer.js";

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function suite(name, fn) {
  console.log(`\n${name}`);
  fn();
}

// ── scoreUsername ────────────────────────────────────────────────────────────

suite("scoreUsername", () => {
  assert(scoreUsername("bot8374629") > 0, "bot+digits detected");
  assert(scoreUsername("jean_dupont") === 0, "normal username = 0");
  assert(scoreUsername("8374629102") > 0, "all digits detected");
  assert(scoreUsername("a".repeat(25)) > 0, "very long username detected");
  assert(scoreUsername("bcdfghjklmnp") > 0, "no vowels detected");
  assert(scoreUsername("user12345678") > 0, "high digit ratio detected");
  assert(scoreUsername("_a_b_c_d_e_") > 0, "underscore heavy detected");
  assert(scoreUsername("_bot_12345678901234567890_bcdfg_") <= 30, "capped at 30");
});

// ── preScoreFromMetadata ────────────────────────────────────────────────────

suite("preScoreFromMetadata", () => {
  const fakeResult = preScoreFromMetadata("bot8374629", 0, false, null, false);
  assert(fakeResult !== null && fakeResult.score >= 75, "obvious fake >= 75");

  const legitResult = preScoreFromMetadata("jean_dupont", 150, false, "Jean Dupont", true);
  assert(legitResult !== null && legitResult.score <= 15, "obvious legit <= 15");

  const ambigResult = preScoreFromMetadata("some_user", 10, false, "Some User", true);
  assert(ambigResult === null, "inconclusive returns null");
});

// ── scoreProfile ────────────────────────────────────────────────────────────

suite("scoreProfile", () => {
  const fakeProfile = {
    username: "bot123456",
    followerCount: 0,
    postCount: 0,
    replyCount: 0,
    isPrivate: false,
    hasBio: false,
    hasProfilePic: false,
    hasLinkInBio: false,
    hasIgLink: false,
    fullName: null,
  };
  const fakeResult = scoreProfile(fakeProfile);
  assert(fakeResult.score >= 50, `fake profile score ${fakeResult.score} >= 50`);

  const legitProfile = {
    username: "jean_dupont",
    followerCount: 200,
    postCount: 50,
    replyCount: 30,
    isPrivate: false,
    hasBio: true,
    hasProfilePic: true,
    hasLinkInBio: true,
    hasIgLink: false,
    fullName: "Jean Dupont",
  };
  const legitResult = scoreProfile(legitProfile);
  assert(legitResult.score < 30, `legit profile score ${legitResult.score} < 30`);
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
