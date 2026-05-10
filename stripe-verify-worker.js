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

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (origin.startsWith("chrome-extension://")) return true;
  const allowed = [
    "https://www.threads.net", "https://threads.net",
    "https://www.threads.com", "https://threads.com",
  ];
  return allowed.some((a) => origin === a || origin.startsWith(a + "/"));
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  if (!origin || !isAllowedOrigin(origin)) return {};
  return { "Access-Control-Allow-Origin": origin };
}

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

// Idempotent: returns the existing code if this Stripe session was already
// turned into a licence. Otherwise generates a fresh code (with collision
// retry) and registers its HMAC as a community-vote token.
async function getOrCreateLicenseCode(env, sessionId) {
  const sessionIdHash = await hmacHex(env.HMAC_SALT, sessionId);

  const existing = await env.DB.prepare(
    "SELECT code FROM licenses WHERE session_id_hash = ? AND revoked = 0"
  ).bind(sessionIdHash).first();
  if (existing) return existing.code;

  // Generate and insert. The PK constraint on `code` makes collisions
  // visible as INSERT failures; retry up to 5 times (collisions are
  // astronomically rare given the entropy, but be defensive).
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateLicenseCode();
    try {
      await env.DB.prepare(
        "INSERT INTO licenses (code, session_id_hash, created_at) VALUES (?, ?, ?)"
      ).bind(code, sessionIdHash, Date.now()).run();
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
  vote: 200,        // votes per hour per token
  sightings: 20,    // sighting batches per hour per token
  telemetry: 50,    // telemetry events per hour per anon hash
};

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

// ── Lazy housekeeping (1% chance per write) ──

async function maybeCleanup(env) {
  if (Math.random() >= 0.01) return;
  try {
    const cutoffNonces = Date.now() - 600_000;          // 10 min
    const cutoffBuckets = Math.floor(Date.now() / 3_600_000) - 25; // keep 25 hour-buckets
    const cutoffTelemetry = Date.now() - 90 * 24 * 3_600_000; // keep 90 days
    await env.DB.batch([
      env.DB.prepare("DELETE FROM nonces WHERE used_at < ?").bind(cutoffNonces),
      env.DB.prepare("DELETE FROM rate_limits WHERE hour_bucket < ?").bind(cutoffBuckets),
      env.DB.prepare("DELETE FROM telemetry WHERE created_at < ?").bind(cutoffTelemetry),
    ]);
  } catch {
    // non-critical; another request will clean later
  }
}

// ── Main handler ──

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    try {
      if (url.pathname === "/verify") return handleVerify(request, env, url);
      if (url.pathname === "/success") return handleSuccess(request, env, url);
      if (url.pathname === "/vote" && request.method === "POST") return handleVote(request, env);
      if (url.pathname === "/lookup" && request.method === "POST") return handleLookup(request, env);
      if (url.pathname === "/community-stats") return handleCommunityStats(request, env);
      if (url.pathname === "/report-sightings" && request.method === "POST") return handleReportSightings(request, env);
      if (url.pathname === "/check-sightings" && request.method === "POST") return handleCheckSightings(request, env);
      if (url.pathname === "/telemetry" && request.method === "POST") return handleTelemetry(request, env);
      return json({ error: "not_found" }, 404, request);
    } catch (e) {
      // Log the real error to worker logs (visible only to the operator);
      // never leak stack traces or internal IDs to the client.
      console.error("[worker] internal_error:", e);
      return json({ error: "internal_error" }, 500, request);
    }
  },
};

// ── /verify ──

async function handleVerify(request, env, url) {
  if (!env.HMAC_SALT) {
    return json({ valid: false, error: "server_misconfigured" }, 500, request);
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
      issuedCode = await getOrCreateLicenseCode(env, sessionId);
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
        licenseCode = await getOrCreateLicenseCode(env, safeSessionId);
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
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
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

  // Batch insert sightings (HMAC each target hash)
  const now = Date.now();
  let inserted = 0;
  for (const clientHash of clientTargetHashes) {
    if (!HEX64_RE.test(String(clientHash))) continue;
    const targetHash = await hmacHex(env.HMAC_SALT, clientHash);
    await env.DB.prepare(
      "INSERT OR IGNORE INTO sightings (target_hash, reporter_hash, created_at) VALUES (?, ?, ?)"
    ).bind(targetHash, tokenHash, now).run();
    inserted++;
  }

  await maybeCleanup(env);
  return json({ ok: true, reported: inserted }, 200, request);
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

  const { anonId, v, lang, ts, category, errorCode, reason, stage } = body || {};

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

  const anonHash = await hmacHex(env.HMAC_SALT, anonId);

  // Per-anonId rate limit
  const rl = await checkAndBumpRateLimit(env, anonHash, "telemetry");
  if (!rl.allowed) {
    return json({ error: "rate_limited", retryAfter: rl.retryAfter }, 429, request);
  }

  await env.DB.prepare(`
    INSERT INTO telemetry (anon_hash, v, lang, category, error_code, reason, stage, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    anonHash,
    safe(v, 20) || "unknown",
    safe(lang, 8) || "unknown",
    safe(category, 32),
    safe(errorCode, 80),
    safe(reason, 80),
    safe(stage, 32),
    ts
  ).run();

  await maybeCleanup(env);
  return json({ ok: true }, 200, request);
}
