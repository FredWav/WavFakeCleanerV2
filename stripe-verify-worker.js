/**
 * Cloudflare Worker — vérifie qu'un Stripe Checkout Session a bien été payé.
 *
 * DÉPLOIEMENT (2 minutes) :
 * 1. Va sur https://workers.cloudflare.com → "Create application" → "Worker"
 * 2. Colle ce code dans l'éditeur, clique "Deploy"
 * 3. Dans Settings → Variables → ajoute : STRIPE_SECRET_KEY = sk_live_XXXX
 * 4. Note l'URL du worker (ex: https://wfc-verify.tonnom.workers.dev)
 * 5. Dans src/shared/constants.ts → remplace LICENCE_VERIFY_URL par cette URL + "/verify"
 *
 * STRIPE :
 * - Dans ton Payment Link → "Après le paiement" → "Redirige vers une URL"
 * - URL de succès : https://wfc-verify.tonnom.workers.dev/success?session_id={CHECKOUT_SESSION_ID}
 *   (Stripe remplace automatiquement {CHECKOUT_SESSION_ID})
 * - La page de succès affiche le session ID que l'utilisateur copie dans l'extension.
 */

export default {
  async fetch(request, env) {
    const headers = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    };

    const url = new URL(request.url);

    // ── /verify?session_id=cs_xxx — appelé par l'extension ──
    if (url.pathname === "/verify") {
      const sessionId = url.searchParams.get("session_id");

      if (!sessionId || !sessionId.startsWith("cs_")) {
        return new Response(JSON.stringify({ valid: false }), { headers });
      }

      try {
        const r = await fetch(
          `https://api.stripe.com/v1/checkout/sessions/${sessionId}`,
          { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
        );
        const session = await r.json();
        const valid = session.payment_status === "paid";
        return new Response(JSON.stringify({ valid }), { headers });
      } catch {
        return new Response(JSON.stringify({ valid: false }), { headers });
      }
    }

    // ── /success?session_id=cs_xxx — page de succès Stripe ──
    if (url.pathname === "/success") {
      const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Wav Fake Cleaner — Paiement confirmé</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f0f11; color: #e5e7eb;
           display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #1a1a2e; border: 1px solid #2d2d40; border-radius: 16px;
            padding: 32px; max-width: 440px; width: 90%; text-align: center; }
    h1 { color: #a855f7; margin: 0 0 16px; font-size: 1.4rem; }
    #wfc-status { font-size: .95rem; line-height: 1.6; min-height: 60px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Paiement confirmé ✓</h1>
    <div id="wfc-status" style="color:#a855f7">Activation en cours…</div>
  </div>
</body>
</html>`;
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    return new Response("Not found", { status: 404 });
  },
};
