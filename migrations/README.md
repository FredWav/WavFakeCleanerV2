# Migrations D1 — runbook

La base `wfc-community` suit un versioning manuel : `worker-schema.sql` est le
schéma complet idempotent (installations fraîches), `migrations/000N-*.sql`
contient les deltas (à appliquer **une seule fois chacun**, dans l'ordre —
les `ALTER TABLE` ne sont pas idempotents).

## Déploiement v4 (release 3.0.0)

Ordre zéro-downtime — la migration d'abord, le Worker ensuite, l'extension en
dernier (un vieux Worker ignore la colonne `value`, une vieille extension ne
l'envoie pas ; l'inverse casserait l'INSERT télémétrie) :

```powershell
# 1. Test local
npx wrangler d1 execute wfc-community --local --file worker-schema.sql
npx wrangler d1 execute wfc-community --local --file migrations/0004-observability.sql  # sur une base v3 locale
npx wrangler dev   # smoke test: /telemetry avec et sans value, /token-check

# 2. Migration production
npx wrangler d1 execute wfc-community --remote --file migrations/0004-observability.sql

# 3. Déploiement Worker
npx wrangler deploy

# 4. Secrets (une fois) — dashboard admin (phase 3)
npx wrangler secret put ADMIN_TOKEN      # longue chaîne aléatoire (ex: 64 hex)
# Optionnel, durcissement CORS (à activer seulement avec les vrais IDs) :
# npx wrangler secret put EXTENSION_IDS  # "id_cws_prod,id_dev_unpacked"

# 5. Vérifier
# - GET  https://<worker>/admin           → page de login (sans données)
# - GET  https://<worker>/admin/api/overview (Bearer ADMIN_TOKEN) → JSON
# - POST https://<worker>/token-check     → { valid: ... }
```

## Déploiement v5 (recover-by-email)

Même ordre zéro-downtime — migration, puis Worker, puis extension. Un vieux
Worker ignore `email_hash` (la colonne reste NULL) ; une vieille extension
n'appelle juste pas `/recover`. Backfill **après** le déploiement du Worker.

```powershell
# 1. Test local
npx wrangler d1 execute wfc-community --local --file migrations/0005-licenses-email-hash.sql
npx wrangler dev   # smoke test: POST /recover { email }, /verify, /success

# 2. Migration production
npx wrangler d1 execute wfc-community --remote --file migrations/0005-licenses-email-hash.sql

# 3. Déploiement Worker
npx wrangler deploy

# 4. Backfill rétroactif des licences existantes (une fois) — DEUX options :

#   Option A (recommandée, aucun secret à connaître) : le dashboard admin.
#   Ouvre https://<worker>/admin, entre ton ADMIN_TOKEN, clique
#   « Lancer le backfill Stripe ». Le Worker utilise ses propres secrets
#   (HMAC_SALT + STRIPE_SECRET_KEY) — idempotent, réexécutable.
#   (Si tu n'as pas d'ADMIN_TOKEN : npx wrangler secret put ADMIN_TOKEN)

#   Option B (script local) : nécessite la valeur de HMAC_SALT (illisible
#   depuis Cloudflare). À n'utiliser que si tu l'as sauvegardée.
$env:STRIPE_SECRET_KEY = "sk_live_..."   # même clé que le secret Worker
$env:HMAC_SALT = "..."                   # MÊME valeur que le secret Worker
node scripts/backfill-license-emails.mjs

# 5. Vérifier
# - POST https://<worker>/recover { "email": "<email_acheteur>" } → { found: true, code }
# - email inconnu → { found: false } ; spam → 429
```

## Historique

| Version | Fichier | Contenu |
|---|---|---|
| v1–v3 | `worker-schema.sql` (historique) | tokens, votes, sightings, nonces, rate_limits, telemetry, licenses |
| v4 | `0004-observability.sql` | `telemetry.value INTEGER` + index `idx_telemetry_category` |
| v5 | `0005-licenses-email-hash.sql` | `licenses.email_hash TEXT` + index `idx_licenses_email` (recover-by-email) |
