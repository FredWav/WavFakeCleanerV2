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

## Historique

| Version | Fichier | Contenu |
|---|---|---|
| v1–v3 | `worker-schema.sql` (historique) | tokens, votes, sightings, nonces, rate_limits, telemetry, licenses |
| v4 | `0004-observability.sql` | `telemetry.value INTEGER` + index `idx_telemetry_category` |
