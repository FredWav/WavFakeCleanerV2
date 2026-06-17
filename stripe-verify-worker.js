/**
 * Cloudflare Worker — Stripe licence verify + Community voting API.
 *
 * Privacy model:
 *   - Every identifier stored in D1 is HMAC-SHA256(env.HMAC_SALT, ...).
 *   - The salt lives only as a Cloudflare secret; the extension never sees it.
 *   - A DB dump alone cannot be brute-forced back to usernames or session IDs.
 *
 * ROUTES :
 *   GET  /verify?session_id=cs_xxx  - verifie paiement Stripe, retourne communityToken
 *   GET  /success?session_id=cs_xxx - page de succes Stripe (HTML)
 *   POST /vote                       - soumet un vote communautaire
 *   POST /lookup                     - lookup batch de scores communautaires
 *   GET  /community-stats            - stats agregees pour affichage public
 *   POST /report-sightings           - signale des fakes (batch, auth)
 *   POST /check-sightings            - verifie combien d'users ont signale un compte (batch, no auth)
 *   POST /telemetry                  - rapport d'erreur anonyme opt-in (no auth, rate-limited)
 */

// ── Crypto helpers ──

let cachedHmacKey = null;
let cachedHmacKeyForSalt = null;

async function getHmacKey(salt) {
  if (cachedHmacKey && cachedHmacKeyForSalt === salt) return cachedHmacKey;
  cachedHmacKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(salt),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  cachedHmacKeyForSalt = salt;
  return cachedHmacKey;
}

async function hmacHex(salt, data) {
  const key = await getHmacKey(salt);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── CORS helpers ──
// Only extension origins are served: no content script calls the Worker (all
// calls come from the service worker / sidepanel), so the old threads.net
// entries were dead allowance and are gone. When the EXTENSION_IDS secret is
// set (comma-separated extension IDs), it becomes a strict allowlist; unset,
// any chrome-extension:// origin is accepted (pre-v3 behavior) so the
// tightening can ship independently once the production IDs are known.

let extensionIdAllowlist = null; // parsed once per isolate — env is static

function loadExtensionAllowlist(env) {
  if (extensionIdAllowlist !== null) return;
  extensionIdAllowlist = String(env?.EXTENSION_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isAllowedOrigin(origin) {
  if (!origin || !origin.startsWith("chrome-extension://")) return false;
  const ids = extensionIdAllowlist || [];
  if (ids.length === 0) return true; // allowlist not configured
  const id = origin.slice("chrome-extension://".length).replace(/\/+$/, "");
  return ids.includes(id);
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  if (!origin || !isAllowedOrigin(origin)) return {};
  return { "Access-Control-Allow-Origin": origin };
}

// Hardening headers for every HTML response (/success, /admin).
const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

// ── Response helpers ──

function json(body, status = 200, request = null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...(request ? corsHeaders(request) : {}) },
  });
}

const STRIPE_RE = /^cs_(live|test)_[A-Za-z0-9]{20,80}$/;
const HEX64_RE = /^[a-f0-9]{64}$/;

// Short licence codes issued to customers after payment.
// Alphabet excludes 0/O/1/I/L to avoid dictation/typing confusion.
// 8 useful chars from a 31-char alphabet → 31^8 ≈ 8.5 × 10^11 codes.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_RE = /^WFC-[A-Z2-9]{4}-[A-Z2-9]{4}$/;

function generateLicenseCode() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let chars = "";
  for (const b of bytes) chars += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `WFC-${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}

// Normalize an email for hashing: trim + lowercase so the HMAC computed at
// issuance matches the one computed at /recover time regardless of casing or
// stray whitespace. Returns "" for missing/obviously-invalid input (so we
// never hash garbage as if it were a recovery key).
function normalizeEmail(email) {
  if (typeof email !== "string") return "";
  const e = email.trim().toLowerCase();
  // Not a full RFC validator — just "looks like an address".
  if (e.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return "";
  return e;
}

// Idempotent: returns the existing code if this Stripe session was already
// turned into a licence. Otherwise generates a fresh code (with collision
// retry) and registers its HMAC as a community-vote token.
//
// `email` is the Stripe customer's email (present on every paid checkout
// session). We store HMAC(SALT, normalized email) so the licence can later be
// recovered by email — never the raw address. On the idempotent path we
// backfill email_hash if a pre-recover-by-email row had it NULL.
async function getOrCreateLicenseCode(env, sessionId, email) {
  const sessionIdHash = await hmacHex(env.HMAC_SALT, sessionId);
  const normalized = normalizeEmail(email);
  const emailHash = normalized ? await hmacHex(env.HMAC_SALT, normalized) : null;

  const existing = await env.DB.prepare(
    "SELECT code, email_hash FROM licenses WHERE session_id_hash = ? AND revoked = 0"
  ).bind(sessionIdHash).first();
  if (existing) {
    // Backfill the email hash the first time a legacy customer re-verifies.
    if (emailHash && !existing.email_hash) {
      await env.DB.prepare(
        "UPDATE licenses SET email_hash = ? WHERE code = ? AND email_hash IS NULL"
      ).bind(emailHash, existing.code).run();
    }
    return existing.code;
  }

  // Generate and insert. The PK constraint on `code` makes collisions
  // visible as INSERT failures; retry up to 5 times (collisions are
  // astronomically rare given the entropy, but be defensive).
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateLicenseCode();
    try {
      await env.DB.prepare(
        "INSERT INTO licenses (code, session_id_hash, email_hash, created_at) VALUES (?, ?, ?, ?)"
      ).bind(code, sessionIdHash, emailHash, Date.now()).run();
      // Register the code's HMAC as a community-vote token so /vote works
      // immediately for the new licensee.
      const tokenHash = await hmacHex(env.HMAC_SALT, code);
      await env.DB.prepare(
        "INSERT OR IGNORE INTO tokens (token_hash, created_at) VALUES (?, ?)"
      ).bind(tokenHash, Date.now()).run();
      return code;
    } catch (e) {
      lastErr = e;
      // The UNIQUE on session_id_hash means a concurrent /verify for the
      // same payment may have inserted; re-check.
      const raced = await env.DB.prepare(
        "SELECT code FROM licenses WHERE session_id_hash = ?"
      ).bind(sessionIdHash).first();
      if (raced) return raced.code;
    }
  }
  throw lastErr || new Error("code_generation_failed");
}

// ── Rate limiting ──

const RATE_LIMITS = {
  vote: 200,            // votes per hour per token
  sightings: 20,        // sighting batches per hour per token
  telemetry: 50,        // telemetry events per hour per anon hash
  token_check: 30,      // token health checks per hour per IP hash
  // Per-IP limits on the previously unlimited open endpoints. Generous —
  // the extension does one /lookup per table load — but they bound abuse.
  lookup: 120,
  check_sightings: 120,
  verify: 30,
  community_stats: 60,
  recover: 10,          // recover-by-email attempts per hour per IP
  recover_email: 5,     // recover-by-email attempts per hour per email
};

// Collapse an IPv6 address to its /64 network prefix before bucketing, so a
// client can't mint unlimited rate-limit buckets by rotating through its (a
// typical allocation is a full /64). IPv4 and non-IP values pass through
// unchanged. This is the standard granularity for IPv6 rate limiting.
function ipRateLimitKey(ip) {
  if (!ip.includes(":")) return ip; // IPv4 or "unknown"
  const [headStr, tailStr] = ip.split("::");
  const head = headStr ? headStr.split(":") : [];
  const hasCompression = tailStr !== undefined;
  const tail = hasCompression && tailStr ? tailStr.split(":") : [];
  const groups = hasCompression
    ? head.concat(Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), tail)
    : head;
  // First 4 groups = /64. Strip leading zeros per group so e.g. "0db8" and
  // "db8" map to the same bucket.
  return groups.slice(0, 4).map((g) => (g || "0").replace(/^0+(?=[0-9a-fA-F])/, "").toLowerCase()).join(":");
}

// HMAC an IP for per-IP rate limiting without ever storing the raw address.
async function ipHash(env, request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  return hmacHex(env.HMAC_SALT, "ip:" + ipRateLimitKey(ip));
}

async function checkAndBumpRateLimit(env, tokenHash, endpoint) {
  const bucket = Math.floor(Date.now() / 3_600_000);
  const limit = RATE_LIMITS[endpoint] ?? 100;

  // Atomic increment-and-read: prevents the SELECT-then-INSERT race where
  // N concurrent requests all see count < limit and each bumps past it.
  // The request that pushes count past `limit` is the first one rejected;
  // earlier ones within the window were already counted and allowed.
  const result = await env.DB.prepare(
    "INSERT INTO rate_limits (token_hash, hour_bucket, endpoint, count) VALUES (?, ?, ?, 1) " +
    "ON CONFLICT (token_hash, hour_bucket, endpoint) DO UPDATE SET count = count + 1 " +
    "RETURNING count"
  ).bind(tokenHash, bucket, endpoint).first();

  if (result && result.count > limit) {
    return { allowed: false, retryAfter: 3600 - (Math.floor(Date.now() / 1000) % 3600) };
  }

  return { allowed: true };
}

// ── Housekeeping ──
// Runs deterministically from the daily cron trigger, plus a 1% per-write
// lottery as belt-and-braces between cron runs.

async function runCleanup(env) {
  const cutoffNonces = Date.now() - 600_000;          // 10 min
  const cutoffBuckets = Math.floor(Date.now() / 3_600_000) - 25; // keep 25 hour-buckets
  const cutoffTelemetry = Date.now() - 90 * 24 * 3_600_000; // keep 90 days
  await env.DB.batch([
    env.DB.prepare("DELETE FROM nonces WHERE used_at < ?").bind(cutoffNonces),
    env.DB.prepare("DELETE FROM rate_limits WHERE hour_bucket < ?").bind(cutoffBuckets),
    env.DB.prepare("DELETE FROM telemetry WHERE created_at < ?").bind(cutoffTelemetry),
  ]);
}

async function maybeCleanup(env) {
  if (Math.random() >= 0.01) return;
  try {
    await runCleanup(env);
  } catch {
    // non-critical; the cron (or another request) will clean later
  }
}

// ── Main handler ──

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    loadExtensionAllowlist(env);

    if (request.method === "OPTIONS") {
      const origin = request.headers.get("Origin");
      if (!origin || !isAllowedOrigin(origin)) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    try {
      if (url.pathname === "/verify") return handleVerify(request, env, url);
      if (url.pathname === "/recover" && request.method === "POST") return handleRecover(request, env);
      if (url.pathname === "/success") return handleSuccess(request, env, url);
      if (url.pathname === "/vote" && request.method === "POST") return handleVote(request, env);
      if (url.pathname === "/lookup" && request.method === "POST") return handleLookup(request, env);
      if (url.pathname === "/community-stats") return handleCommunityStats(request, env);
      if (url.pathname === "/report-sightings" && request.method === "POST") return handleReportSightings(request, env);
      if (url.pathname === "/check-sightings" && request.method === "POST") return handleCheckSightings(request, env);
      if (url.pathname === "/token-check" && request.method === "POST") return handleTokenCheck(request, env);
      if (url.pathname === "/telemetry" && request.method === "POST") return handleTelemetry(request, env);
      // Operator dashboard (no CORS — same-origin browser use only)
      if (url.pathname === "/admin" && request.method === "GET") return handleAdminPage();
      if (url.pathname === "/admin/api/overview" && request.method === "GET") return handleAdminOverview(request, env, url);
      if (url.pathname === "/admin/api/revoke" && request.method === "POST") return handleAdminRevoke(request, env);
      if (url.pathname === "/admin/api/backfill-emails" && request.method === "POST") return handleAdminBackfillEmails(request, env);
      return json({ error: "not_found" }, 404, request);
    } catch (e) {
      // Log the real error to worker logs (visible only to the operator);
      // never leak stack traces or internal IDs to the client.
      console.error("[worker] internal_error:", e);
      return json({ error: "internal_error" }, 500, request);
    }
  },

  // Daily cron (wrangler.toml [triggers]) — deterministic housekeeping.
  async scheduled(_event, env, _ctx) {
    try {
      await runCleanup(env);
      console.log("[worker] scheduled cleanup done");
    } catch (e) {
      console.error("[worker] scheduled cleanup failed:", e);
    }
  },
};

// ── /verify ──

async function handleVerify(request, env, url) {
  if (!env.HMAC_SALT) {
    return json({ valid: false, error: "server_misconfigured" }, 500, request);
  }

  // Per-IP limit: this endpoint fans out to the Stripe API and issues codes —
  // the most expensive unauthenticated call we have.
  if (env.DB) {
    const rl = await checkAndBumpRateLimit(env, await ipHash(env, request), "verify");
    if (!rl.allowed) {
      return json({ valid: false, error: "rate_limited", retryAfter: rl.retryAfter }, 429, request);
    }
  }

  // ── Path A : lookup by short licence code (post-2.2 customers) ──
  const code = url.searchParams.get("code");
  if (code) {
    if (!CODE_RE.test(code)) {
      return json({ valid: false, error: "invalid_code" }, 200, request);
    }
    if (!env.DB) {
      return json({ valid: false, error: "db_not_configured" }, 503, request);
    }
    try {
      const row = await env.DB.prepare(
        "SELECT code, revoked FROM licenses WHERE code = ?"
      ).bind(code).first();
      if (!row || row.revoked) {
        return json({ valid: false }, 200, request);
      }
      // The code IS the community token (HMAC stored at creation time).
      return json({ valid: true, code, communityToken: code }, 200, request);
    } catch (e) {
      console.error("[worker] /verify (code) failed:", e);
      return json({ valid: false, error: "verify_failed" }, 200, request);
    }
  }

  // ── Path B : verify Stripe session, issue (or reuse) a short code ──
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId || !STRIPE_RE.test(sessionId)) {
    return json({ valid: false, error: "invalid_session_id" }, 200, request);
  }

  try {
    const r = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
    );
    const session = await r.json();
    const valid = session.payment_status === "paid";

    if (!valid) return json({ valid: false }, 200, request);

    // No DB → fall back to the legacy behavior (session ID as community token).
    if (!env.DB) {
      return json({ valid: true, communityToken: sessionId }, 200, request);
    }

    // Generate or retrieve the short code; use it as the community token.
    let issuedCode;
    try {
      issuedCode = await getOrCreateLicenseCode(env, sessionId, session.customer_details?.email);
    } catch (e) {
      console.error("[worker] code issuance failed, falling back to session_id:", e);
      // Last-resort: legacy behavior (session ID as token) so the user
      // is never blocked from activating.
      const tokenHash = await hmacHex(env.HMAC_SALT, sessionId);
      await env.DB.prepare(
        "INSERT OR IGNORE INTO tokens (token_hash, created_at) VALUES (?, ?)"
      ).bind(tokenHash, Date.now()).run();
      return json({ valid: true, communityToken: sessionId }, 200, request);
    }

    return json(
      { valid: true, code: issuedCode, communityToken: issuedCode },
      200,
      request,
    );
  } catch (e) {
    console.error("[worker] /verify failed:", e);
    return json({ valid: false, error: "verify_failed" }, 200, request);
  }
}

// ── /recover ──
//
// Recover-by-email: a user who lost their local storage (browser reinstall,
// OS reset, switched browsers) retypes the email they paid with and gets
// their licence code back. We only ever compare HMAC(email) against the
// stored email_hash — the raw address is never logged or persisted, and it
// travels in the POST body (not the query string) to stay out of access logs.
//
// Deliberate trade-off (product decision): knowing a buyer's email is enough
// to recover their code. A per-IP limit (collapsed to /64 for IPv6) plus a
// per-email limit bound casual enumeration; a determined attacker rotating
// across many networks could still probe a known email list — acceptable
// given the low value of what's returned (a lifetime licence code).
async function handleRecover(request, env) {
  if (!env.DB) return json({ found: false, error: "db_not_configured" }, 503, request);
  if (!env.HMAC_SALT) return json({ found: false, error: "server_misconfigured" }, 500, request);

  // Per-IP limit first — cheap, and the main brute-force guard.
  const ipRl = await checkAndBumpRateLimit(env, await ipHash(env, request), "recover");
  if (!ipRl.allowed) {
    return json({ found: false, error: "rate_limited", retryAfter: ipRl.retryAfter }, 429, request);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ found: false, error: "invalid_request" }, 400, request);
  }

  const normalized = normalizeEmail(body && body.email);
  if (!normalized) {
    return json({ found: false, error: "invalid_email" }, 400, request);
  }
  const emailHash = await hmacHex(env.HMAC_SALT, normalized);

  // Per-email limit — stops someone hammering a single address from rotating
  // IPs, and bounds enumeration of any one inbox.
  const emailRl = await checkAndBumpRateLimit(env, "recover:" + emailHash, "recover_email");
  if (!emailRl.allowed) {
    return json({ found: false, error: "rate_limited", retryAfter: emailRl.retryAfter }, 429, request);
  }

  try {
    const row = await env.DB.prepare(
      "SELECT code FROM licenses WHERE email_hash = ? AND revoked = 0 ORDER BY created_at DESC LIMIT 1"
    ).bind(emailHash).first();
    if (!row) return json({ found: false }, 200, request);
    return json({ found: true, code: row.code }, 200, request);
  } catch (e) {
    console.error("[worker] /recover failed:", e);
    return json({ found: false, error: "recover_failed" }, 200, request);
  }
}

// ── /success ──

async function handleSuccess(request, env, url) {
  const sessionId = url.searchParams.get("session_id") || "";
  // Defensive: only render strings that pass the strict Stripe ID format.
  // Anything else gets blanked out — never reflected back to the page.
  const safeSessionId = STRIPE_RE.test(sessionId) ? sessionId : "";

  // Issue the licence code server-side so it's ready to display BEFORE the
  // page renders. If anything fails (Stripe down, DB down, etc.), we fall
  // back to showing the session ID so the user is never stuck.
  let licenseCode = "";
  if (safeSessionId && env.HMAC_SALT && env.DB && env.STRIPE_SECRET_KEY) {
    try {
      const r = await fetch(
        `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(safeSessionId)}`,
        { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } },
      );
      const session = await r.json();
      if (session.payment_status === "paid") {
        licenseCode = await getOrCreateLicenseCode(env, safeSessionId, session.customer_details?.email);
      }
    } catch (e) {
      console.error("[worker] /success code issuance failed:", e);
    }
  }

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Wav Fake Cleaner — Paiement confirme</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f0f11; color: #e5e7eb;
           display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #1a1a2e; border: 1px solid #2d2d40; border-radius: 16px;
            padding: 32px; max-width: 480px; width: 90%; text-align: center; }
    h1 { color: #a855f7; margin: 0 0 8px; font-size: 1.4rem; }
    .sub { font-size: .85rem; color: #9ca3af; margin: 0 0 18px; }
    .code-box { font-family: ui-monospace, "Courier New", monospace;
                font-size: 1.6rem; font-weight: 700; letter-spacing: .08em;
                color: #c084fc; background: #0f0f11; border: 1px solid #3b3b52;
                border-radius: 12px; padding: 18px 12px; margin: 14px 0;
                cursor: pointer; user-select: all; }
    .code-box:hover { border-color: #6d4aff; }
    .copy-hint { font-size: .7rem; color: #6b7280; margin-top: 6px; }
    .steps { text-align: left; font-size: .8rem; color: #9ca3af;
             background: #15152a; border-radius: 10px; padding: 12px 16px; margin-top: 16px; }
    .steps ol { margin: 6px 0 0; padding-left: 22px; }
    .steps li { margin: 4px 0; }
    #wfc-status { margin-top: 16px; }
    .fallback-hint { font-size: .75rem; color: #6b7280; margin-top: 22px; }
    .auto-msg { color: #34d399; font-size: .85rem; margin-top: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Paiement confirme</h1>
    <p class="sub">Voici ta licence Wav Fake Cleaner :</p>

    ${licenseCode
      ? `<div class="code-box" id="wfc-code"
              onclick="navigator.clipboard.writeText('${licenseCode}').then(function(){
                document.getElementById('copy-hint').textContent = 'Copie !';
              })">${licenseCode}</div>
         <div class="copy-hint" id="copy-hint">Clique pour copier</div>`
      : `<div class="code-box" style="color:#fbbf24;font-size:1rem">
            Code temporairement indisponible — utilise l'ID Stripe ci-dessous
         </div>
         <div class="code-box" style="font-size:.8rem">${safeSessionId}</div>
         <div class="copy-hint">Recharge la page pour obtenir un code plus court</div>`}

    <div id="wfc-status"
         data-state="loading"
         data-session-id="${safeSessionId}"
         data-license-code="${licenseCode}">
      <p style="color:#9ca3af;font-size:.85rem">Tentative d'activation automatique…</p>
    </div>

    <div class="steps">
      <strong>Activation manuelle :</strong>
      <ol>
        <li>Clique sur l'icone de l'extension Wav Fake Cleaner dans Chrome</li>
        <li>Clique sur le bouton <strong>Licence</strong> en haut a droite</li>
        <li>Colle le code ci-dessus dans le champ d'activation</li>
        <li>Clique <strong>Activer</strong> — le statut passe en vert</li>
      </ol>
    </div>

    <p class="fallback-hint">Probleme ? Ecris a <a href="mailto:contact@fredwav.com" style="color:#a855f7">contact@fredwav.com</a> en mentionnant ton code.</p>
  </div>
  <script>
    // After 3s, if the in-extension activator hasn't taken over, switch to
    // the "manual" message. The activator updates data-state when it runs.
    setTimeout(function () {
      var el = document.getElementById('wfc-status');
      if (el && el.dataset.state === 'loading') {
        el.dataset.state = 'no-extension';
        el.innerHTML = '<div style="color:#fbbf24;font-size:.85rem">Extension non detectee dans ce navigateur — copie le code ci-dessus et colle-le manuellement.</div>';
      }
    }, 3000);
  </script>
</body>
</html>`;
  return new Response(html, { headers: HTML_HEADERS });
}

// ── /vote ──

async function handleVote(request, env) {
  if (!env.DB) return json({ error: "db_not_configured" }, 503, request);
  if (!env.HMAC_SALT) return json({ error: "server_misconfigured" }, 500, request);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid_json" }, 400, request); }

  const { targetHash: clientTargetHash, communityToken, verdict, score, ts, nonce } = body || {};

  if (!clientTargetHash || !communityToken || !verdict || score === undefined || !ts || !nonce) {
    return json({ error: "missing_fields" }, 400, request);
  }
  if (!HEX64_RE.test(String(clientTargetHash))) {
    return json({ error: "invalid_target_hash" }, 400, request);
  }
  if (!["fake", "ok", "review"].includes(verdict)) {
    return json({ error: "invalid_verdict" }, 400, request);
  }
  if (typeof score !== "number" || score < 0 || score > 100) {
    return json({ error: "invalid_score" }, 400, request);
  }

  // Timestamp freshness: +/-5 minutes
  if (Math.abs(Date.now() - ts) > 5 * 60 * 1000) {
    return json({ error: "timestamp_expired" }, 400, request);
  }

  // HMAC the identifiers BEFORE any DB lookup
  const tokenHash = await hmacHex(env.HMAC_SALT, communityToken);
  const targetHash = await hmacHex(env.HMAC_SALT, clientTargetHash);

  // Verify community token
  const tokenRow = await env.DB.prepare(
    "SELECT token_hash FROM tokens WHERE token_hash = ?"
  ).bind(tokenHash).first();
  if (!tokenRow) return json({ error: "invalid_token" }, 403, request);

  // Per-token rate limit
  const rl = await checkAndBumpRateLimit(env, tokenHash, "vote");
  if (!rl.allowed) {
    return json({ error: "rate_limited", retryAfter: rl.retryAfter }, 429, request);
  }

  // Nonce dedup (prevent replay)
  const nonceRow = await env.DB.prepare(
    "SELECT nonce FROM nonces WHERE nonce = ?"
  ).bind(nonce).first();
  if (nonceRow) return json({ error: "nonce_replayed" }, 400, request);

  await env.DB.prepare(
    "INSERT INTO nonces (nonce, used_at) VALUES (?, ?)"
  ).bind(nonce, Date.now()).run();

  // Upsert vote
  await env.DB.prepare(`
    INSERT INTO votes (target_hash, token_hash, verdict, score, ts, nonce)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (target_hash, token_hash) DO UPDATE SET
      verdict = excluded.verdict,
      score   = excluded.score,
      ts      = excluded.ts,
      nonce   = excluded.nonce
  `).bind(targetHash, tokenHash, verdict, score, ts, nonce).run();

  await maybeCleanup(env);
  return json({ ok: true }, 200, request);
}

// ── /lookup ──

async function handleLookup(request, env) {
  if (!env.DB) return json({ error: "db_not_configured" }, 503, request);
  if (!env.HMAC_SALT) return json({ error: "server_misconfigured" }, 500, request);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid_json" }, 400, request); }

  const { targetHashes: clientTargetHashes } = body || {};
  if (!Array.isArray(clientTargetHashes) || clientTargetHashes.length === 0) {
    return json({ error: "missing_target_hashes" }, 400, request);
  }
  if (clientTargetHashes.length > 200) {
    return json({ error: "too_many_hashes" }, 400, request);
  }

  const rl = await checkAndBumpRateLimit(env, await ipHash(env, request), "lookup");
  if (!rl.allowed) {
    return json({ error: "rate_limited", retryAfter: rl.retryAfter }, 429, request);
  }

  // Translate client SHA-256 hashes to server HMACs
  const hmacToClient = new Map();
  const targetHashes = [];
  for (const h of clientTargetHashes) {
    if (!HEX64_RE.test(String(h))) continue;
    const hmac = await hmacHex(env.HMAC_SALT, h);
    hmacToClient.set(hmac, h);
    targetHashes.push(hmac);
  }
  if (targetHashes.length === 0) return json({}, 200, request);

  const placeholders = targetHashes.map(() => "?").join(", ");
  const rows = await env.DB.prepare(`
    SELECT
      target_hash,
      COUNT(*) AS vote_count,
      CAST(ROUND(AVG(score)) AS INTEGER) AS consensus_score,
      CAST(ROUND(
        SUM(CASE WHEN verdict = 'fake' THEN 100.0 ELSE 0.0 END) / COUNT(*)
      ) AS INTEGER) AS fake_pct
    FROM votes
    WHERE target_hash IN (${placeholders})
    GROUP BY target_hash
  `).bind(...targetHashes).all();

  const result = {};
  for (const row of rows.results) {
    const clientHash = hmacToClient.get(row.target_hash);
    if (!clientHash) continue;
    result[clientHash] = {
      voteCount: row.vote_count,
      fakeRatio: row.fake_pct / 100,
      consensusScore: row.consensus_score,
    };
  }

  return json(result, 200, request);
}

// ── /community-stats ──

async function handleCommunityStats(request, env) {
  if (!env.DB) return json({ totalFakesDetected: 0 }, 200, request);
  try {
    const rl = await checkAndBumpRateLimit(env, await ipHash(env, request), "community_stats");
    if (!rl.allowed) {
      return json({ error: "rate_limited", retryAfter: rl.retryAfter }, 429, request);
    }
    const row = await env.DB.prepare(
      "SELECT COUNT(DISTINCT target_hash) AS total FROM votes WHERE verdict = 'fake'"
    ).first();
    return json({ totalFakesDetected: row?.total ?? 0 }, 200, request);
  } catch {
    return json({ totalFakesDetected: 0 }, 200, request);
  }
}

// ── /report-sightings ── (batch, auth required)

async function handleReportSightings(request, env) {
  if (!env.DB) return json({ error: "db_not_configured" }, 503, request);
  if (!env.HMAC_SALT) return json({ error: "server_misconfigured" }, 500, request);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid_json" }, 400, request); }

  const { communityToken, targetHashes: clientTargetHashes, ts, nonce } = body || {};
  if (!communityToken || !Array.isArray(clientTargetHashes) || !ts || !nonce) {
    return json({ error: "missing_fields" }, 400, request);
  }
  if (clientTargetHashes.length === 0 || clientTargetHashes.length > 50) {
    return json({ error: "invalid_batch_size" }, 400, request);
  }
  if (Math.abs(Date.now() - ts) > 5 * 60 * 1000) {
    return json({ error: "timestamp_expired" }, 400, request);
  }

  // Verify token (HMAC)
  const tokenHash = await hmacHex(env.HMAC_SALT, communityToken);
  const tokenRow = await env.DB.prepare(
    "SELECT token_hash FROM tokens WHERE token_hash = ?"
  ).bind(tokenHash).first();
  if (!tokenRow) return json({ error: "invalid_token" }, 403, request);

  // Per-token rate limit
  const rl = await checkAndBumpRateLimit(env, tokenHash, "sightings");
  if (!rl.allowed) {
    return json({ error: "rate_limited", retryAfter: rl.retryAfter }, 429, request);
  }

  // Nonce dedup
  const nonceRow = await env.DB.prepare(
    "SELECT nonce FROM nonces WHERE nonce = ?"
  ).bind(nonce).first();
  if (nonceRow) return json({ error: "nonce_replayed" }, 400, request);
  await env.DB.prepare(
    "INSERT INTO nonces (nonce, used_at) VALUES (?, ?)"
  ).bind(nonce, Date.now()).run();

  // Batch insert sightings (HMAC each target hash) — one D1 round trip
  // instead of N awaited inserts.
  const now = Date.now();
  const statements = [];
  for (const clientHash of clientTargetHashes) {
    if (!HEX64_RE.test(String(clientHash))) continue;
    const targetHash = await hmacHex(env.HMAC_SALT, clientHash);
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO sightings (target_hash, reporter_hash, created_at) VALUES (?, ?, ?)"
      ).bind(targetHash, tokenHash, now)
    );
  }
  if (statements.length > 0) await env.DB.batch(statements);

  await maybeCleanup(env);
  return json({ ok: true, reported: statements.length }, 200, request);
}

// ── /check-sightings ── (batch, no auth)

async function handleCheckSightings(request, env) {
  if (!env.DB) return json({ results: {} }, 200, request);
  if (!env.HMAC_SALT) return json({ error: "server_misconfigured" }, 500, request);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid_json" }, 400, request); }

  const { targetHashes: clientTargetHashes } = body || {};
  if (!Array.isArray(clientTargetHashes) || clientTargetHashes.length === 0) {
    return json({ error: "missing_target_hashes" }, 400, request);
  }
  if (clientTargetHashes.length > 200) {
    return json({ error: "too_many_hashes" }, 400, request);
  }

  const rl = await checkAndBumpRateLimit(env, await ipHash(env, request), "check_sightings");
  if (!rl.allowed) {
    return json({ error: "rate_limited", retryAfter: rl.retryAfter }, 429, request);
  }

  // Translate client SHA-256 hashes to server HMACs
  const hmacToClient = new Map();
  const targetHashes = [];
  for (const h of clientTargetHashes) {
    if (!HEX64_RE.test(String(h))) continue;
    const hmac = await hmacHex(env.HMAC_SALT, h);
    hmacToClient.set(hmac, h);
    targetHashes.push(hmac);
  }
  if (targetHashes.length === 0) return json({ results: {} }, 200, request);

  const placeholders = targetHashes.map(() => "?").join(", ");
  const rows = await env.DB.prepare(
    `SELECT target_hash, COUNT(DISTINCT reporter_hash) AS cnt FROM sightings WHERE target_hash IN (${placeholders}) GROUP BY target_hash`
  ).bind(...targetHashes).all();

  const results = {};
  for (const row of rows.results) {
    const clientHash = hmacToClient.get(row.target_hash);
    if (clientHash) results[clientHash] = row.cnt;
  }

  return json({ results }, 200, request);
}

// ── /token-check ── (community token health, no auth, per-IP rate limited)
//
// Lets the extension distinguish "my licence is revoked/invalid" from
// transient failures, instead of dropping every vote on a silent 403 forever.
// Returns { valid: boolean } — nothing else, so it leaks no licence metadata.

async function handleTokenCheck(request, env) {
  if (!env.DB) return json({ error: "db_not_configured" }, 503, request);
  if (!env.HMAC_SALT) return json({ error: "server_misconfigured" }, 500, request);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid_json" }, 400, request); }

  const { communityToken } = body || {};
  if (typeof communityToken !== "string" || communityToken.length < 8 || communityToken.length > 120) {
    return json({ error: "invalid_token_format" }, 400, request);
  }

  // Per-IP rate limit (hashed — raw IPs never touch D1)
  const rl = await checkAndBumpRateLimit(env, await ipHash(env, request), "token_check");
  if (!rl.allowed) {
    return json({ error: "rate_limited", retryAfter: rl.retryAfter }, 429, request);
  }

  const tokenHash = await hmacHex(env.HMAC_SALT, communityToken);
  const tokenRow = await env.DB.prepare(
    "SELECT token_hash FROM tokens WHERE token_hash = ?"
  ).bind(tokenHash).first();
  if (!tokenRow) return json({ valid: false }, 200, request);

  // WFC codes also honor licence revocation: a revoked licence must lose its
  // voting rights even though its token row was created at issuance.
  if (CODE_RE.test(communityToken)) {
    const lic = await env.DB.prepare(
      "SELECT revoked FROM licenses WHERE code = ?"
    ).bind(communityToken).first();
    if (lic && lic.revoked) return json({ valid: false }, 200, request);
  }

  return json({ valid: true }, 200, request);
}

// ── /telemetry ── (anonymous opt-in error reports, no auth)
//
// Body shape (all optional except anonId, errorCode, ts):
//   {
//     anonId: string (UUID v4 from the client, used for dedup),
//     v: string (extension version),
//     lang: string,
//     ts: number (client ms),
//     category: string,
//     errorCode: string,
//     reason?: string,
//     stage?: string
//   }

async function handleTelemetry(request, env) {
  if (!env.DB) return json({ error: "db_not_configured" }, 503, request);
  if (!env.HMAC_SALT) return json({ error: "server_misconfigured" }, 500, request);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid_json" }, 400, request); }

  const { anonId, v, lang, ts, category, errorCode, reason, stage, value } = body || {};

  if (typeof anonId !== "string" || anonId.length < 16 || anonId.length > 100) {
    return json({ error: "invalid_anon_id" }, 400, request);
  }
  if (typeof errorCode !== "string" || errorCode.length === 0 || errorCode.length > 80) {
    return json({ error: "invalid_error_code" }, 400, request);
  }
  if (typeof ts !== "number" || Math.abs(Date.now() - ts) > 10 * 60 * 1000) {
    return json({ error: "timestamp_expired" }, 400, request);
  }
  // Soft-cap free-form fields to bound storage and avoid abuse
  const safe = (s, max) =>
    typeof s === "string" ? s.slice(0, max).replace(/[^\x20-\x7e]/g, "") : null;
  // Optional numeric payload (v4): clamp to a sane integer range.
  const safeValue =
    typeof value === "number" && Number.isFinite(value)
      ? Math.max(-2_147_483_648, Math.min(2_147_483_647, Math.round(value)))
      : null;

  const anonHash = await hmacHex(env.HMAC_SALT, anonId);

  // Per-anonId rate limit
  const rl = await checkAndBumpRateLimit(env, anonHash, "telemetry");
  if (!rl.allowed) {
    return json({ error: "rate_limited", retryAfter: rl.retryAfter }, 429, request);
  }

  await env.DB.prepare(`
    INSERT INTO telemetry (anon_hash, v, lang, category, error_code, reason, stage, ts, value)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    anonHash,
    safe(v, 20) || "unknown",
    safe(lang, 8) || "unknown",
    safe(category, 32),
    safe(errorCode, 80),
    safe(reason, 80),
    safe(stage, 32),
    ts,
    safeValue
  ).run();

  await maybeCleanup(env);
  return json({ ok: true }, 200, request);
}

// ════════════════════════════════════════════════════════════════════════
// Operator dashboard — /admin (HTML shell), /admin/api/overview (data),
// /admin/api/revoke (kill a licence + its voting token).
//
// Auth: Bearer token compared via HMAC against the ADMIN_TOKEN secret
// (`wrangler secret put ADMIN_TOKEN`). Comparing HMACs instead of raw
// strings gives constant-time behavior with the primitives at hand. The
// shell page itself contains no data; the token lives in sessionStorage,
// never in the URL. No CORS on these routes — same-origin browser use only.
// ════════════════════════════════════════════════════════════════════════

async function isAdminAuthorized(request, env) {
  if (!env.ADMIN_TOKEN || !env.HMAC_SALT) return false;
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  const provided = auth.slice(7).trim();
  if (!provided) return false;
  const a = await hmacHex(env.HMAC_SALT, "admin:" + provided);
  const b = await hmacHex(env.HMAC_SALT, "admin:" + env.ADMIN_TOKEN);
  return a === b;
}

async function handleAdminOverview(request, env, url) {
  if (!(await isAdminAuthorized(request, env))) {
    return json({ error: "unauthorized" }, 403);
  }
  if (!env.DB) return json({ error: "db_not_configured" }, 503);

  const days = Math.max(1, Math.min(90, parseInt(url.searchParams.get("days") || "14", 10) || 14));
  const now = Date.now();
  const cutoff = now - days * 24 * 3_600_000;
  const cutoff7d = now - 7 * 24 * 3_600_000;
  const cutoff30d = now - 30 * 24 * 3_600_000;
  const currentBucket = Math.floor(now / 3_600_000);
  const DAY = "strftime('%Y-%m-%d', created_at/1000, 'unixepoch')";

  const results = await env.DB.batch([
    env.DB.prepare(`SELECT ${DAY} AS day, COUNT(*) AS votes, SUM(verdict='fake') AS fakeVotes FROM votes WHERE created_at > ? GROUP BY day ORDER BY day`).bind(cutoff),
    env.DB.prepare("SELECT COUNT(DISTINCT token_hash) AS n FROM votes WHERE created_at > ?").bind(cutoff7d),
    env.DB.prepare("SELECT COUNT(DISTINCT token_hash) AS n FROM votes WHERE created_at > ?").bind(cutoff30d),
    env.DB.prepare("SELECT COUNT(DISTINCT target_hash) AS n FROM votes WHERE verdict = 'fake'"),
    env.DB.prepare(`SELECT ${DAY} AS day, COUNT(*) AS n FROM sightings WHERE created_at > ? GROUP BY day ORDER BY day`).bind(cutoff),
    env.DB.prepare("SELECT COUNT(DISTINCT reporter_hash) AS n FROM sightings WHERE created_at > ?").bind(cutoff7d),
    env.DB.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(revoked), 0) AS revoked FROM licenses"),
    env.DB.prepare(`SELECT ${DAY} AS day, COUNT(*) AS n FROM licenses WHERE created_at > ? GROUP BY day ORDER BY day`).bind(cutoff),
    env.DB.prepare("SELECT category, error_code AS errorCode, COUNT(*) AS n FROM telemetry WHERE created_at > ? GROUP BY category, error_code ORDER BY n DESC LIMIT 25").bind(cutoff),
    env.DB.prepare("SELECT COALESCE(reason, '?') AS reason, COUNT(*) AS events, SUM(COALESCE(value, 1)) AS items FROM telemetry WHERE category = 'community' AND error_code IN ('vote_dropped','sightings_dropped','queue_overflow') AND created_at > ? GROUP BY reason ORDER BY items DESC").bind(cutoff),
    env.DB.prepare("SELECT CAST(ROUND(AVG(value)) AS INTEGER) AS avg, MAX(value) AS max FROM telemetry WHERE category = 'community' AND error_code = 'replay_summary' AND value IS NOT NULL AND created_at > ?").bind(cutoff),
    env.DB.prepare("SELECT error_code AS lookup, COALESCE(reason, '?') AS strategy, COUNT(*) AS n, COUNT(DISTINCT anon_hash) AS users, MAX(created_at) AS lastSeen FROM telemetry WHERE category = 'drift' AND created_at > ? GROUP BY error_code, reason ORDER BY n DESC LIMIT 20").bind(cutoff),
    env.DB.prepare("SELECT v, COUNT(DISTINCT anon_hash) AS users FROM telemetry WHERE created_at > ? GROUP BY v ORDER BY users DESC LIMIT 10").bind(cutoff),
    env.DB.prepare("SELECT COUNT(*) AS n FROM nonces"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM rate_limits"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM telemetry"),
    env.DB.prepare("SELECT endpoint, MAX(count) AS peak FROM rate_limits WHERE hour_bucket = ? GROUP BY endpoint ORDER BY peak DESC").bind(currentBucket),
  ]);

  const r = (i) => results[i].results || [];
  const first = (i) => (results[i].results || [])[0] || {};

  return json({
    generatedAt: now,
    days,
    licenses: {
      total: first(6).total ?? 0,
      revoked: first(6).revoked ?? 0,
      activationsPerDay: r(7),
    },
    votes: {
      perDay: r(0),
      voters7d: first(1).n ?? 0,
      voters30d: first(2).n ?? 0,
      fakesDetected: first(3).n ?? 0,
    },
    sightings: {
      perDay: r(4),
      reporters7d: first(5).n ?? 0,
    },
    topErrors: r(8),
    communityDrops: r(9),
    queueDepth: { avg: first(10).avg ?? null, max: first(10).max ?? null },
    drift: r(11),
    versions: r(12),
    health: {
      nonces: first(13).n ?? 0,
      rateLimitRows: first(14).n ?? 0,
      telemetryRows: first(15).n ?? 0,
      currentHourPressure: r(16),
    },
  }, 200);
}

async function handleAdminRevoke(request, env) {
  if (!(await isAdminAuthorized(request, env))) {
    return json({ error: "unauthorized" }, 403);
  }
  if (!env.DB) return json({ error: "db_not_configured" }, 503);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid_json" }, 400); }

  const { code } = body || {};
  if (typeof code !== "string" || !CODE_RE.test(code)) {
    return json({ error: "invalid_code" }, 400);
  }

  const row = await env.DB.prepare("SELECT code, revoked FROM licenses WHERE code = ?").bind(code).first();
  if (!row) return json({ ok: false, error: "not_found" }, 404);

  // Revoke the licence AND delete its community token in one shot — before
  // v3 a revoked licence kept voting forever (the token row created at
  // issuance was never cleaned up, and /vote only checks `tokens`).
  const tokenHash = await hmacHex(env.HMAC_SALT, code);
  await env.DB.batch([
    env.DB.prepare("UPDATE licenses SET revoked = 1 WHERE code = ?").bind(code),
    env.DB.prepare("DELETE FROM tokens WHERE token_hash = ?").bind(tokenHash),
  ]);

  return json({ ok: true, code, alreadyRevoked: !!row.revoked }, 200);
}

// Server-side recover-by-email backfill. Walks Stripe checkout sessions and
// fills licenses.email_hash for legacy rows (issued before recover-by-email),
// using the Worker's own HMAC_SALT + STRIPE_SECRET_KEY secrets — the operator
// never needs to know either. Idempotent (only fills NULLs) and safe to re-run.
//
// Paginates in bounded chunks per call (MAX_PAGES) so we stay well under the
// Worker subrequest/CPU limits; the dashboard loops with `nextStartingAfter`
// until `done`.
async function handleAdminBackfillEmails(request, env) {
  if (!(await isAdminAuthorized(request, env))) return json({ error: "unauthorized" }, 403);
  if (!env.DB) return json({ error: "db_not_configured" }, 503);
  if (!env.STRIPE_SECRET_KEY) return json({ error: "stripe_not_configured" }, 503);

  let body = {};
  try { body = await request.json(); } catch { /* empty body is fine */ }
  // "report" = read-only (tally amounts, no writes). "apply" = create/keep the
  // real licences AND delete licence rows wrongly created for other payments.
  const mode = body.mode === "apply" ? "apply" : "report";
  // Which (currency:amount_cents) count as a real licence purchase. This Stripe
  // account also sells unrelated coaching/other products, so we whitelist ONLY
  // the WFC licence price: 799 = 7,99€. (The 14,99€ "original" price was never
  // actually charged — 0 sessions.) Every other paid session is a different
  // product and must NOT be a licence — the first backfill wrongly made one for
  // every paid session. Override with keepKeys in the body if needed.
  const DEFAULT_KEEP = ["eur:799"];
  const keep = new Set(
    Array.isArray(body.keepKeys) && body.keepKeys.length ? body.keepKeys.map(String) : DEFAULT_KEEP
  );
  let startingAfter = typeof body.startingAfter === "string" ? body.startingAfter : null;

  const MAX_PAGES = 5; // bound Stripe subrequests + D1 work per call

  let scanned = 0;
  let paid = 0;
  let linked = 0;   // real licence sessions ensured (row + email hash)
  let deleted = 0;  // wrong licence rows removed
  let pages = 0;
  let done = false;
  const amounts = {}; // histogram "currency:amount_cents" -> count of paid sessions

  while (pages < MAX_PAGES) {
    const params = new URLSearchParams({ limit: "100" });
    if (startingAfter) params.set("starting_after", startingAfter);
    const res = await fetch(`https://api.stripe.com/v1/checkout/sessions?${params}`, {
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    if (!res.ok) {
      return json({ error: "stripe_error", status: res.status }, 502);
    }
    const page = await res.json();
    pages++;
    const data = page.data || [];
    for (const s of data) {
      scanned++;
      if (s.payment_status !== "paid") continue;
      paid++;
      const key = String(s.currency || "?").toLowerCase() + ":" + (s.amount_total ?? "?");
      amounts[key] = (amounts[key] || 0) + 1;
      if (mode !== "apply") continue;

      const sessionIdHash = await hmacHex(env.HMAC_SALT, s.id);
      if (keep.has(key)) {
        // Real licence: ensure the row exists and carries the email hash.
        const email = normalizeEmail(s.customer_details && s.customer_details.email);
        if (email) {
          try { await getOrCreateLicenseCode(env, s.id, email); linked++; }
          catch (e) { console.error("[worker] backfill apply failed:", e); }
        }
      } else {
        // Not a licence purchase → undo any licence row the first backfill made.
        const row = await env.DB.prepare(
          "SELECT code FROM licenses WHERE session_id_hash = ?"
        ).bind(sessionIdHash).first();
        if (row) {
          const tokenHash = await hmacHex(env.HMAC_SALT, row.code);
          await env.DB.batch([
            env.DB.prepare("DELETE FROM licenses WHERE session_id_hash = ?").bind(sessionIdHash),
            env.DB.prepare("DELETE FROM tokens WHERE token_hash = ?").bind(tokenHash),
          ]);
          deleted++;
        }
      }
    }
    if (data.length > 0) startingAfter = data[data.length - 1].id;
    if (!page.has_more || data.length === 0) { done = true; break; }
  }

  return json({
    ok: true,
    mode,
    scanned,
    paid,
    linked,
    deleted,
    amounts,
    done,
    nextStartingAfter: done ? null : startingAfter,
  }, 200);
}

function handleAdminPage() {
  // Static shell: zero data, zero secrets. The inline JS asks for the admin
  // token (sessionStorage), calls /admin/api/overview, and renders tables.
  // SECURITY: every dynamic string is HTML-escaped before innerHTML —
  // telemetry fields are attacker-controlled (the endpoint is unauthenticated).
  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>WFC — Admin</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, sans-serif; background: #0f0f11; color: #e5e7eb; margin: 0; padding: 24px; }
  h1 { color: #a855f7; font-size: 1.2rem; margin: 0 0 4px; }
  h2 { color: #c084fc; font-size: .85rem; text-transform: uppercase; letter-spacing: .06em; margin: 26px 0 8px; }
  .sub { color: #6b7280; font-size: .75rem; margin-bottom: 18px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
  .tile { background: #1a1a2e; border: 1px solid #2d2d40; border-radius: 12px; padding: 12px 14px; }
  .tile .v { font-size: 1.4rem; font-weight: 700; color: #fff; }
  .tile .l { font-size: .68rem; color: #9ca3af; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: .78rem; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #1f1f30; }
  th { color: #6b7280; font-weight: 600; font-size: .68rem; text-transform: uppercase; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .bar { display: inline-block; height: 9px; background: #6d4aff; border-radius: 3px; vertical-align: middle; min-width: 2px; }
  .bar.red { background: #ef4444; }
  .warn { color: #fbbf24; } .bad { color: #f87171; } .ok { color: #34d399; }
  .card { background: #15152a; border: 1px solid #26263c; border-radius: 12px; padding: 12px 14px; overflow-x: auto; }
  #login { max-width: 380px; margin: 12vh auto; text-align: center; }
  input, button { font: inherit; border-radius: 8px; border: 1px solid #3b3b52; background: #0f0f11; color: #fff; padding: 8px 10px; }
  button { background: #6d4aff; border: 0; cursor: pointer; font-weight: 600; }
  button:hover { background: #7c5cff; }
  button.danger { background: #b91c1c; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  #err { color: #f87171; font-size: .8rem; min-height: 1.2em; margin-top: 8px; }
  .muted { color: #6b7280; }
</style>
</head>
<body>
<div id="login">
  <h1>WFC — Admin</h1>
  <p class="sub">Tableau de bord op&eacute;rateur</p>
  <div class="row" style="justify-content:center">
    <input id="tok" type="password" placeholder="ADMIN_TOKEN" style="width:220px">
    <button onclick="saveTok()">Entrer</button>
  </div>
  <div id="err"></div>
</div>
<div id="dash" style="display:none"></div>
<script>
"use strict";
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function num(x) { var n = Number(x); return isFinite(n) ? n : 0; }
function fmtDate(ms) { try { return new Date(num(ms)).toISOString().slice(0, 16).replace("T", " "); } catch (e) { return "?"; } }
function getTok() { return sessionStorage.getItem("wfc_admin_token") || ""; }
function saveTok() {
  var v = document.getElementById("tok").value.trim();
  if (!v) return;
  sessionStorage.setItem("wfc_admin_token", v);
  load();
}
function logout(msg) {
  sessionStorage.removeItem("wfc_admin_token");
  document.getElementById("dash").style.display = "none";
  document.getElementById("login").style.display = "block";
  document.getElementById("err").textContent = msg || "";
}
function tiles(items) {
  var h = '<div class="grid">';
  for (var i = 0; i < items.length; i++) {
    h += '<div class="tile"><div class="v ' + (items[i][2] || "") + '">' + esc(items[i][1]) + '</div><div class="l">' + esc(items[i][0]) + "</div></div>";
  }
  return h + "</div>";
}
function table(headers, rows) {
  var h = '<div class="card"><table><tr>';
  for (var i = 0; i < headers.length; i++) h += "<th" + (headers[i][1] ? ' class="num"' : "") + ">" + esc(headers[i][0]) + "</th>";
  h += "</tr>";
  if (!rows.length) h += '<tr><td colspan="' + headers.length + '" class="muted">aucune donn&eacute;e</td></tr>';
  for (var rI = 0; rI < rows.length; rI++) {
    h += "<tr>";
    for (var c = 0; c < rows[rI].length; c++) h += "<td" + (headers[c] && headers[c][1] ? ' class="num"' : "") + ">" + rows[rI][c] + "</td>";
    h += "</tr>";
  }
  return h + "</table></div>";
}
function bar(v, max, red) {
  var w = max > 0 ? Math.max(2, Math.round(num(v) / max * 90)) : 2;
  return '<span class="bar' + (red ? " red" : "") + '" style="width:' + w + 'px"></span> ' + num(v);
}
function load() {
  var tok = getTok();
  if (!tok) return;
  fetch("/admin/api/overview?days=14", { headers: { Authorization: "Bearer " + tok } })
    .then(function (res) {
      if (res.status === 403) { logout("Token refus\\u00e9"); throw new Error("403"); }
      if (!res.ok) { logout("Erreur " + res.status); throw new Error(String(res.status)); }
      return res.json();
    })
    .then(render)
    .catch(function () {});
}
function render(d) {
  document.getElementById("login").style.display = "none";
  var el = document.getElementById("dash");
  el.style.display = "block";

  var votesTotal = 0, fakeTotal = 0, i;
  for (i = 0; i < d.votes.perDay.length; i++) { votesTotal += num(d.votes.perDay[i].votes); fakeTotal += num(d.votes.perDay[i].fakeVotes); }
  var maxVotes = 0, maxSight = 0;
  for (i = 0; i < d.votes.perDay.length; i++) maxVotes = Math.max(maxVotes, num(d.votes.perDay[i].votes));
  for (i = 0; i < d.sightings.perDay.length; i++) maxSight = Math.max(maxSight, num(d.sightings.perDay[i].n));

  var h = "<h1>WFC — Admin</h1>" +
    '<p class="sub">G&eacute;n&eacute;r&eacute; ' + fmtDate(d.generatedAt) + " UTC &middot; fen&ecirc;tre " + num(d.days) + ' jours &middot; <a href="#" onclick="load();return false" style="color:#a855f7">rafra&icirc;chir</a></p>';

  h += tiles([
    ["Licences", num(d.licenses.total)],
    ["R\\u00e9voqu\\u00e9es", num(d.licenses.revoked), num(d.licenses.revoked) > 0 ? "warn" : ""],
    ["Voteurs 7j", num(d.votes.voters7d)],
    ["Voteurs 30j", num(d.votes.voters30d)],
    ["Votes (" + num(d.days) + "j)", votesTotal],
    ["Fakes d\\u00e9tect\\u00e9s", num(d.votes.fakesDetected)],
    ["Queue moy/max", (d.queueDepth.avg == null ? "—" : num(d.queueDepth.avg) + " / " + num(d.queueDepth.max)), num(d.queueDepth.max) > 100 ? "warn" : ""],
  ]);

  h += "<h2>Votes / jour</h2>";
  var vRows = [];
  for (i = 0; i < d.votes.perDay.length; i++) {
    var v = d.votes.perDay[i];
    vRows.push([esc(v.day), bar(v.votes, maxVotes), bar(v.fakeVotes, maxVotes, true)]);
  }
  h += table([["Jour"], ["Votes", 1], ["Dont fake", 1]], vRows);

  h += "<h2>Sightings / jour <span class='muted'>(reporters 7j : " + num(d.sightings.reporters7d) + ")</span></h2>";
  var sRows = [];
  for (i = 0; i < d.sightings.perDay.length; i++) sRows.push([esc(d.sightings.perDay[i].day), bar(d.sightings.perDay[i].n, maxSight)]);
  h += table([["Jour"], ["Signalements", 1]], sRows);

  h += "<h2 class='warn'>D&eacute;rive des s&eacute;lecteurs (early warning)</h2>";
  var dRows = [];
  for (i = 0; i < d.drift.length; i++) {
    var dr = d.drift[i];
    dRows.push([esc(dr.lookup), esc(dr.strategy), num(dr.n), num(dr.users), esc(fmtDate(dr.lastSeen))]);
  }
  h += table([["S\\u00e9lecteur"], ["Strat\\u00e9gie gagnante"], ["Occurrences", 1], ["Installs", 1], ["Vu le"]], dRows);

  h += "<h2>Pertes communautaires (par raison)</h2>";
  var cRows = [];
  for (i = 0; i < d.communityDrops.length; i++) {
    var cd = d.communityDrops[i];
    cRows.push([esc(cd.reason), num(cd.events), num(cd.items)]);
  }
  h += table([["Raison"], ["\\u00c9v\\u00e9nements", 1], ["Contributions", 1]], cRows);

  h += "<h2>Top erreurs t\\u00e9l\\u00e9m\\u00e9trie</h2>";
  var eRows = [];
  for (i = 0; i < d.topErrors.length; i++) {
    var te = d.topErrors[i];
    eRows.push([esc(te.category), esc(te.errorCode), num(te.n)]);
  }
  h += table([["Cat\\u00e9gorie"], ["Code"], ["n", 1]], eRows);

  h += "<h2>Versions actives</h2>";
  var verRows = [];
  for (i = 0; i < d.versions.length; i++) verRows.push([esc(d.versions[i].v), num(d.versions[i].users)]);
  h += table([["Version"], ["Installs", 1]], verRows);

  var pres = "";
  for (i = 0; i < d.health.currentHourPressure.length; i++) {
    var p = d.health.currentHourPressure[i];
    pres += esc(p.endpoint) + ": " + num(p.peak) + "  ";
  }
  h += "<h2>Sant&eacute; des tables</h2>";
  h += tiles([
    ["Nonces", num(d.health.nonces), num(d.health.nonces) > 5000 ? "warn" : ""],
    ["Rate-limit rows", num(d.health.rateLimitRows)],
    ["T\\u00e9l\\u00e9m\\u00e9trie rows", num(d.health.telemetryRows)],
    ["Pression heure courante", pres || "—"],
  ]);

  h += "<h2>Licences &amp; r&eacute;cup&eacute;ration par email <span class='muted'>(analyse / correction)</span></h2>" +
    '<div class="card"><div class="row">' +
    '<button onclick="backfillReport()">Analyser les paiements</button>' +
    '<button class="danger" onclick="backfillApply()">Corriger : ne garder que les licences</button>' +
    '<span id="bfmsg" class="muted"></span>' +
    "</div>" +
    '<pre id="bfamounts" class="muted" style="margin:8px 0 0;white-space:pre-wrap;font-size:.72rem"></pre>' +
    "<p class='muted' style='margin:8px 0 0'>Analyser = lecture seule (liste les montants pay&eacute;s). Corriger = garde uniquement les licences &agrave; 7,99&euro;, <b>supprime</b> les fausses lignes cr&eacute;&eacute;es pour tes autres paiements, et relie chaque licence &agrave; son email.</p>" +
    "</div>";

  h += "<h2 class='bad'>R&eacute;voquer une licence</h2>" +
    '<div class="card"><div class="row">' +
    '<input id="rvk" placeholder="WFC-XXXX-XXXX" style="width:170px">' +
    '<button class="danger" onclick="revoke()">R&eacute;voquer + couper le vote</button>' +
    '<span id="rvkmsg" class="muted"></span>' +
    "</div></div>";

  el.innerHTML = h;
}
function revoke() {
  var code = document.getElementById("rvk").value.trim().toUpperCase();
  var msg = document.getElementById("rvkmsg");
  if (!code) return;
  if (!confirm("R\\u00e9voquer " + code + " ? La licence et son token de vote seront coup\\u00e9s.")) return;
  fetch("/admin/api/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + getTok() },
    body: JSON.stringify({ code: code }),
  })
    .then(function (res) { return res.json().then(function (j) { return { s: res.status, j: j }; }); })
    .then(function (r) {
      if (r.s === 200) { msg.textContent = "OK — r\\u00e9voqu\\u00e9e" + (r.j.alreadyRevoked ? " (d\\u00e9j\\u00e0 r\\u00e9voqu\\u00e9e)" : ""); msg.className = "ok"; }
      else { msg.textContent = "Erreur: " + (r.j && r.j.error ? r.j.error : r.s); msg.className = "bad"; }
    })
    .catch(function () { msg.textContent = "Erreur r\\u00e9seau"; msg.className = "bad"; });
}
function bfRun(mode, confirmMsg) {
  var msg = document.getElementById("bfmsg");
  var pre = document.getElementById("bfamounts");
  if (confirmMsg && !confirm(confirmMsg)) return;
  msg.className = "muted";
  msg.textContent = (mode === "apply" ? "Correction" : "Analyse") + " en cours\\u2026";
  pre.textContent = "";
  var tot = { scanned: 0, paid: 0, linked: 0, deleted: 0, amounts: {} };
  function render() {
    var keys = Object.keys(tot.amounts).sort(function (x, y) { return tot.amounts[y] - tot.amounts[x]; });
    var lines = [];
    for (var i = 0; i < keys.length; i++) lines.push("  " + keys[i] + "  \\u00d7 " + tot.amounts[keys[i]]);
    pre.textContent = "Montants pay\\u00e9s (devise:centimes) \\u00d7 nb :\\n" + lines.join("\\n");
  }
  function step(after) {
    fetch("/admin/api/backfill-emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + getTok() },
      body: JSON.stringify({ mode: mode, startingAfter: after || null }),
    })
      .then(function (res) { return res.json().then(function (j) { return { s: res.status, j: j }; }); })
      .then(function (r) {
        if (r.s !== 200 || !r.j || !r.j.ok) {
          msg.textContent = "Erreur: " + (r.j && r.j.error ? r.j.error : r.s); msg.className = "bad"; return;
        }
        tot.scanned += num(r.j.scanned); tot.paid += num(r.j.paid);
        tot.linked += num(r.j.linked); tot.deleted += num(r.j.deleted);
        var a = r.j.amounts || {};
        for (var k in a) { if (Object.prototype.hasOwnProperty.call(a, k)) tot.amounts[k] = (tot.amounts[k] || 0) + num(a[k]); }
        render();
        if (r.j.done) {
          if (mode === "apply") msg.textContent = "Termin\\u00e9 : " + tot.linked + " licences valides reli\\u00e9es, " + tot.deleted + " fausses supprim\\u00e9es (sur " + tot.paid + " paiements).";
          else msg.textContent = "Analyse termin\\u00e9e : " + tot.scanned + " sessions, " + tot.paid + " pay\\u00e9es (voir montants ci-dessous).";
          msg.className = "ok";
        } else {
          msg.textContent = tot.scanned + " sessions\\u2026";
          step(r.j.nextStartingAfter);
        }
      })
      .catch(function () { msg.textContent = "Erreur r\\u00e9seau"; msg.className = "bad"; });
  }
  step(null);
}
function backfillReport() { bfRun("report", null); }
function backfillApply() {
  bfRun("apply", "Corriger les licences ? Tout paiement qui n'est PAS \\u00e0 7,99\\u20ac (tes autres produits) verra sa fausse licence supprim\\u00e9e. Action d\\u00e9finitive.");
}
if (getTok()) load();
</script>
</body>
</html>`;
  return new Response(html, { headers: HTML_HEADERS });
}
