# Changelog

Toutes les modifications notables de **Wav Fake Cleaner** sont consignees ici.

Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et la
numerotation suit [SemVer](https://semver.org/lang/fr/) :
`MAJOR.MINOR.PATCH` — un bump est obligatoire avant chaque upload sur le
Chrome Web Store.

---

## [2.0.3] — 2026-05-01

### Fixed
- **Suppression effective des fakes auto-classes** : les profils dont le
  pre-score atteint 80+ (sans visite DOM) etaient marques `status: "fake"` en
  base mais **jamais ajoutes a la file de suppression**. Comme
  `getFollowersPending` ne renvoie que `status: "pending"`, ces fakes
  restaient flagges indefiniment sans etre supprimes. Particulierement bloquant
  pour la version gratuite (1 cycle/jour) ou ces fakes etaient effectivement
  "trouves mais pas effaces".
  Desormais ils sont pousses dans `needsRemoveOnly` au moment du marquage et
  supprimes dans le meme cycle.
- **Boucle communautaire complete** : les verdicts "fake" determines
  automatiquement par le scoring (auto-skip pre-score, profil introuvable,
  detection visitee) alimentent maintenant le pool de sightings via
  `reportSightings()` en fin de cycle (batch unique pour respecter le rate
  limit). Avant, seuls les votes manuels via le bouton "Fake" du sidepanel
  contribuaient — les autres utilisateurs ne beneficiaient donc pas du signal
  cross-utilisateurs (`pre:cross_users +15/+20/+25` dans `scorer.ts`) sur les
  detections automatiques.
- **Page Stripe `/success` clarifiee** : suppression du paragraphe trompeur
  "Si ce message reste affiche : colle l'ID ci-dessus" qui restait visible
  meme apres une activation reussie alors qu'aucun ID n'etait affiche. La
  zone d'etat utilise desormais un attribut `data-state` (`loading` /
  `success` / `error` / `no-extension`) que le content script
  `licence-activator` met a jour, et le fallback "Extension non detectee" ne
  se declenche plus que si le state est reste `loading` apres 3s.

---

## [2.0.2] — 2026-05-01

### Added
- **Sauvegarde incrementale du fetch** : chaque page de followers recuperee
  est immediatement envoyee au service worker via le message `FOLLOWERS_PAGE`
  et persistee dans IndexedDB. Cliquer Stop pendant un fetch long ne perd
  plus jamais les pages deja recuperees.
- **Helper exporte `persistFollowerPage()`** dans `pipeline.ts` —
  factorisation de la logique d'upsert utilisee a la fois par
  `runFetchInternal` (reconciliation finale) et le handler
  `FOLLOWERS_PAGE` (sauvegarde incrementale).
- **Stats temps reel** : un `STATS_UPDATED` est broadcast apres chaque page
  persistee, ce qui anime le compteur "Total" du sidepanel pendant le fetch.

### Changed
- **Logo de l'extension** remplace par le nouveau (arobase + balai sur fond
  violet) en 16/48/128 pixels.

---

## [Unreleased] — Worker community DB hardening

Cette version ne touche QUE le Cloudflare Worker et la base D1. L'extension
Chrome n'est pas modifiee — pas de re-upload CWS necessaire.

### Added
- **HMAC server-side** (`HMAC_SALT` Cloudflare secret) applique sur tous les
  identifiants stockes (`token_hash`, `target_hash`, `reporter_hash`). Un dump
  de la base D1 ne permet plus de retrouver les usernames flagges, meme par
  attaque dictionnaire (les SHA-256 etaient triviallement cassables).
- **Rate limiting par token** : 200 votes/heure et 20 batches de signalements
  /heure par token communautaire (table `rate_limits` avec hour buckets).
  Reponse `429` + `retryAfter` si quota atteint.
- **Purge automatique** des `nonces` (>10 min) et des hour buckets
  (>25 heures) declenchee opportunistiquement (1% de chance par ecriture).
- **Table `sightings`** declaree dans `worker-schema.sql` (etait utilisee par
  le code mais absente du schema versionne).
- **Validation regex** `HEX64_RE` sur les `targetHash` recus du client pour
  rejeter les inputs malformes avant tout calcul HMAC.

### Changed
- **`worker-schema.sql`** restructure pour refleter le modele HMAC (commentaires
  `HMAC(SALT, ...)` au lieu de `SHA-256(...)`).
- **`/lookup`** et **`/check-sightings`** appliquent le HMAC sur les hash
  recus avant la requete D1, puis re-mappent les resultats vers les hash
  cote client pour preserver l'API publique.

### Security
- Sans le secret `HMAC_SALT`, les endpoints sensibles refusent de servir
  (`server_misconfigured` 500). Empeche un fail-open silencieux.
- Le `communityToken` (Stripe session ID) n'est plus jamais stocke meme en
  SHA-256 — uniquement en HMAC.

### Migration requise (1 fois)
```bash
# Genere et installe le secret HMAC
npx wrangler secret put HMAC_SALT
# (colle la valeur fournie dans l'echange Claude correspondant)

# Applique les nouvelles tables et indexes
npx wrangler d1 execute wfc-community --remote --file worker-schema.sql

# Wipe les donnees existantes (incompatibles avec les nouveaux HMAC)
npx wrangler d1 execute wfc-community --remote --command "DELETE FROM votes; DELETE FROM sightings; DELETE FROM tokens;"

# Deploie le worker
npx wrangler deploy
```

Apres la migration, les utilisateurs licencies auto-renouvellent leur token
au prochain ouverture du sidepanel (mecanisme `auto-refresh communityToken`
dans `App.tsx`).

---

## [2.0.1] — 2026-04-28

### Added
- **Cle proprietaire Ed25519** — systeme de licence asymetrique signe hors-ligne
  pour les comptes owner / beta. La cle publique seule est embarquee, la cle
  privee reste dans un gestionnaire de mots de passe. Genere des tokens
  multi-utilisateurs avec expiration optionnelle via `scripts/sign-licence.cjs`.
- **Headers API enrichis** sur les requetes Threads (`X-CSRFToken`, `X-FB-LSD`,
  `X-IG-WWW-Claim`, `X-ASBD-ID`, `Accept-Language`) lus dynamiquement depuis
  le contexte page via le main-world-bridge. Suppression du header bot-suspect
  `X-Requested-With`.
- **Backoff exponentiel sur 429** — `fetchWithBackoff()` retente jusqu'a 4 fois
  avec attente 30s -> 1min -> 2min -> 4min (cap 30 min), respecte
  `retry_after_seconds` si Stripe le renvoie.
- **`humanClick(el)`** — wrapper qui dispatche la sequence complete
  pointer/mouse (`pointerover` -> `mousemove` -> `mousedown` -> `mouseup` ->
  `click`) avec timing realiste et coordonnees jittees. Applique a tous les
  clics DOM (menu trois-points, suppression, confirmation, navigation tabs).
- **Email de contact** `contact@fredwav.com` ajoute dans :
  `PRIVACY.md`, page `/success` du worker, modale Licence du sidepanel,
  `README.md`. Cle i18n `support_help` ajoutee en FR/EN/ES.
- **Animation toast** — keyframe `fade-in` ajoute dans `globals.css` (la classe
  Tailwind n'existait plus en v4).
- **Onboarding modal** au premier lancement (3 etapes : username -> Recuperer
  -> Nettoyer).
- **CHANGELOG.md** (ce fichier).

### Changed
- **Lien "by Fred Wav"** dans le header pointe vers
  `https://fredwav.com/contact` (au lieu du profil Threads).
- **Mode continu debride** pour les utilisateurs licencies — suppression du
  cap arbitraire de 60 suppressions par session. Seules les protections
  naturelles restent (pause inter-cycle 5-15 min, break obligatoire 2-3h
  apres 4h de session avec auto-reprise).
- **Page `/success` du worker** — ajout du `<div id="wfc-status">` que le
  content script `licence-activator.ts` cherchait ; fallback automatique
  apres 3s si l'extension n'est pas detectee.
- **Suppression du Dev Mode** dans Settings (remplace par le systeme de cle
  proprietaire signee).
- **Toggle "Prive = a verifier"** passe en cle i18n (`setting_private_review`)
  au lieu d'un ternaire inline.
- **Bouton fermeture des modales** : `x` ASCII -> `×` (U+00D7) pour la
  coherence visuelle.
- **Messages morts retires** de `ContentMessage` et `ContentCommand`
  (`FOLLOWERS_DATA`, `PROFILE_DATA`, `ACTION_RESULT`, `FETCH_PROFILE_API`)
  ainsi que la fonction `fetchProfileApi` orpheline.
- **`manifest.json` source** synchronise puis supprime (le seul reference
  est genere par Vite dans `dist/`).

### Fixed
- Auto-activation Stripe ne donnait pas de retour visuel sur la page de
  succes — l'element DOM cible par le content script n'existait pas dans le
  HTML servi par le worker.
- `runContinuous()` sortait definitivement de la boucle apres 60
  suppressions, donnant l'impression que le mode continu s'arretait apres
  un cycle.

### Security
- **Verification de licence** par signature Ed25519 (Web Crypto API) au lieu
  d'une simple comparaison de hash SHA-256. La cle publique embarquee est
  inutilisable pour forger des tokens.
- **`.gitignore`** etendu pour bloquer les secrets de cle proprietaire
  (`.wfc-owner-key`, `*.owner-key`, `wfc-licence-tokens.txt`,
  `.env.licence`).

---

## [2.0.0] — 2026-04 (release initiale Chrome Web Store)

Premiere version publique de l'extension. Reecrite from scratch comme
extension Chrome pure (commit `e885fc2`, retire l'ancien backend Python).

### Features principales
- Detection 14 signaux des faux comptes Threads (posts, bio, ratio
  abonnes/abonnements, motifs de pseudo, spam, etc.)
- Score 0-100 par follower, seuil de detection ajustable
- Mode "Recuperer" + "Nettoyer" via API officielle Threads et fallback DOM
- Mode continu pour les utilisateurs licencies
- Vote communautaire (Cloudflare Worker + D1, hash SHA-256 anonymise)
- Activation automatique Stripe via content script sur la page de succes
- Sidepanel UI (FR / EN / ES)
- Score de sante du compte avec animation
- Filtres (Tous / En attente / OK / A verifier / Faux / Supprimes)
- Backoff progressif sur erreurs (2-4 min puis 1-1.5h)
- Pause obligatoire 2-3h apres 4h de session continue
- Anti rate-limiting integre (HumanPacer trimodal)

---

## Conventions

A chaque modification :
1. **Ajouter une entree** sous `## [Unreleased]` (ou la version de travail)
   avec la categorie appropriee (`Added`, `Changed`, `Fixed`, `Removed`,
   `Security`, `Deprecated`).
2. **Bumper la version** dans `package.json` ET `vite.config.ts` avant
   chaque build CWS (le store refuse les re-uploads de la meme version).
3. **Type de bump** :
   - **patch** (`2.0.X`) : bug fix, correction i18n, micro-tweak UI.
   - **minor** (`2.X.0`) : nouvelle feature, ajout d'option, gros refactor.
   - **major** (`X.0.0`) : breaking change visible pour l'utilisateur.
