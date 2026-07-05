// ── Rate limits ──
// Intentionally very high: pacing is enforced by HumanPacer's randomized
// delays between actions, not by a hard hourly cap. This counter exists for
// telemetry/UI display.
export const RATE_LIMIT_HOUR = 9999;

// ── Error thresholds ──

export const CONSECUTIVE_ERROR_LIMIT = 8;
export const ERROR_RATE_WINDOW = 20;
export const ERROR_RATE_THRESHOLD = 0.6;

// ── Default settings ──

export const DEFAULT_SETTINGS = {
  threadsUsername: "",
  scoreThreshold: 70,
  privateAlwaysReview: false,
  // Anonymous technical telemetry — ON by default since v3 (opt-out in
  // settings). Existing users are migrated once in onInstalled with a
  // one-time notice banner. See PRIVACY.md for the exact fields.
  telemetry: true,
};

// ── Licence (Stripe + Cloudflare Worker) ──
export const PAYMENT_LINK = "https://buy.stripe.com/7sYdR84WU5z3cPobdKcMM0u";
export const LICENCE_VERIFY_URL = "https://restless-credit-5e6a.fred-olalde.workers.dev/verify";
export const LICENCE_RECOVER_URL = "https://restless-credit-5e6a.fred-olalde.workers.dev/recover";
export const LICENCE_PRICE = "7,99 €";

// ── Community voting (Cloudflare Worker + D1) ──
export const COMMUNITY_VOTE_URL = "https://restless-credit-5e6a.fred-olalde.workers.dev/vote";
export const COMMUNITY_LOOKUP_URL = "https://restless-credit-5e6a.fred-olalde.workers.dev/lookup";
export const COMMUNITY_STATS_URL = "https://restless-credit-5e6a.fred-olalde.workers.dev/community-stats";
export const COMMUNITY_REPORT_SIGHTINGS_URL = "https://restless-credit-5e6a.fred-olalde.workers.dev/report-sightings";
export const COMMUNITY_CHECK_SIGHTINGS_URL = "https://restless-credit-5e6a.fred-olalde.workers.dev/check-sightings";
export const COMMUNITY_TOKEN_CHECK_URL = "https://restless-credit-5e6a.fred-olalde.workers.dev/token-check";

// ── Anonymous error telemetry (opt-in via Settings.telemetry) ──
export const TELEMETRY_URL = "https://restless-credit-5e6a.fred-olalde.workers.dev/telemetry";

// ── Cycle constants (scan+remove combined) ──

export const CYCLE_SIZE = 50;
export const INTER_CYCLE_PAUSE = [300, 900] as [number, number];

// ── Session limits for continuous mode ──
// After this many hours of continuous operation, take a mandatory long break.
export const CONTINUOUS_SESSION_MAX_HOURS = 4;
// Duration of the mandatory break in seconds (2–3 hours, randomized).
export const CONTINUOUS_LONG_BREAK = [7200, 10800] as [number, number];
// When a hard 429 is detected (error page persists after retries), pause this long (seconds).
export const HARD_429_PAUSE = [3600, 5400] as [number, number]; // 1–1.5 hours
// When the account is fully clean (continuous mode finds nothing to do), idle
// this long before re-fetching/re-scanning instead of spinning empty cycles.
export const CONTINUOUS_IDLE_PAUSE = [1800, 3600] as [number, number]; // 30–60 min

// ── Threads API ──

export const THREADS_API = {
  appId: "238260118697367",          // app Threads (Barcelona) — endpoints natifs (followers)
  // web_profile_info est un endpoint Instagram WEB : il exige l'app-id WEB d'IG,
  // sinon Meta répond 400 {"message":"useragent mismatch"} (l'app-id mobile ne
  // colle pas au User-Agent navigateur). On l'envoie donc uniquement pour cet
  // endpoint, pas pour les endpoints Threads natifs.
  webAppId: "936619743392459",       // app Instagram web = web_profile_info
  followersEndpoint: "/api/v1/friendships/{user_id}/followers/",
  profileEndpoint: "/api/v1/users/web_profile_info/",
  searchEndpoint: "/api/v1/users/search/",
  pageSize: 50,
};

// ── Default pic patterns ──

export const DEFAULT_PIC_PATTERNS = ["default", "empty", "placeholder", "/44884218_345"];
