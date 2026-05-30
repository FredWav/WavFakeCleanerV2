# Changelog

Toutes les modifications notables de **Wav Fake Cleaner** sont consignees ici.

Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et la
numerotation suit [SemVer](https://semver.org/lang/fr/) :
`MAJOR.MINOR.PATCH` — un bump est obligatoire avant chaque upload sur le
Chrome Web Store.

---

## [2.3.0] — 2026-05-30

Release centrée sur la fiabilité de la récupération, l'honnêteté de l'UI et la
robustesse anti-blocage. Audit complet du code, puis correctifs ciblés.

### Added
- **Compte à rebours des pauses anti-blocage** — pendant un hard-429 (1–1,5 h),
  un break de session continu (2–3 h), un cooldown de page d'erreur ou une mise
  en veille « compte propre », le panneau affiche un bandeau avec décompte
  (MM:SS) + motif, au lieu d'une barre de progression figée qui donnait
  l'impression d'un plantage. (`pausedUntil`/`pauseReason` dans l'état → `Stats`.)
- **Journal des suppressions** — l'onglet « Supprimés » affiche la date de
  suppression, garde le lien vers le profil (re-suivi manuel) et permet l'export
  CSV. Note d'honnêteté : Threads ne permet pas de re-forcer un abonnement.
- **Tests unitaires du scorer** (Vitest) — `scoreUsername`,
  `preScoreFromMetadata`, `scoreProfile` verrouillés (dont les cas privés
  limites) pour éviter toute régression silencieuse lors d'un futur réglage.
- **Télémétrie de drift sur le fetch** — quand le conteneur de scroll ou le
  bouton « Followers » est trouvé via un sélecteur de secours, un événement
  `drift` est émis (le scroll étant désormais le seul chemin de récupération).
- **Limite de récupération communiquée** — message proactif « défilement
  automatique, ~5000 max par passe » près du bouton Récupérer et dans
  l'onboarding ; message réactif quand une passe est tronquée (plafond/timeout).

### Changed
- **Score de santé** — neutre (« — ») tant qu'aucun scan n'a eu lieu (fini le
  « 0/100 » rouge à l'installation), calculé sur la population analysée
  (propre/analysés) au lieu de /total, avec la couverture affichée à part.
- **Paywall adouci** — le flou par ligne de l'onglet « Faux » (non licenciés)
  est remplacé par un unique bandeau dégradé avec CTA clair.
- **Cycle gratuit** — décompté seulement si le cycle a réellement travaillé : un
  hard-429 immédiat (0 profil traité) ne brûle plus le seul cycle du jour.
- **Mode continu** — compte propre → veille 30–60 min au lieu de boucler sur des
  cycles vides qui rouvraient un onglet à chaque tour.
- **Erreurs d'action localisées** dans le panneau de contrôle (plus de
  `String(e)` brut).
- **Stats de session** — `fakeCount` (faux détectés) distinct de `removedCount`.

### Fixed
- **TypeError latente sur Stop** — cliquer Stop pendant la suppression d'un faux
  ne déréférence plus un `removeResult` null (ce qui faussait au passage les
  compteurs de blocage/erreur).

### Notes
- La récupération passe exclusivement par le défilement automatique (pas d'API
  Threads exploitable) : limite assumée ~5000/passe, désormais affichée dans l'UI.
- La table d'abonnés est plafonnée à 200 lignes (indicateur ajouté) — pas de
  virtualisation nécessaire.

### Reporté (en attente d'arbitrage)
- **Durcissement du scoring des comptes privés** (réduction des faux positifs à
  la source) : le modèle « auto + journal/undo » a été retenu pour cette release ;
  le changement de scoring reste à valider séparément.
- **Découpage de `runCleanCycleInternal`** : différé pour ne pas déstabiliser le
  cœur de suppression juste avant la release.

---

## [2.2.2] — 2026-05-10

### Fixed
- **Early-stop du fetch reformule** (annule et remplace 2.2.1) : la version
  precedente exigeait 85% de couverture de la liste totale avant de
  s'arreter, ce qui forcait un re-fetch quasi-complet a chaque cycle.
  Mauvais compromis : l'utilisateur ne veut pas re-paginer ses 10000
  followers chaque fois qu'il en a 500 nouveaux.

  La nouvelle heuristique stoppe quand on observe **3 pages consecutives
  sans aucun nouveau follower** (vs. anciennes pages connues a 80%+). Plus
  robuste car :
  - Tolere un follower nouveau intercale dans une page sinon "tail"
    (Threads ne garantit pas un ordre strictement chronologique).
  - Capture l'integralite du delta meme avec plusieurs centaines de
    nouveaux abonnes (le tail "0 nouveau" arrive forcement apres tous les
    nouveaux).
  - Ne re-fetch jamais inutilement la liste complete.
  - Reste correct sur un fetch initial (DB vide) puisque la branche est
    gardee par `if (hasKnown && ...)`.

### Removed
- Garde-fou de couverture (`coverage >= 0.85`) introduit en 2.2.1, devenu
  inutile avec la nouvelle heuristique.

---

## [2.2.1] — 2026-05-07

### Fixed
- **Recuperation des followers s'arretait trop tot apres un fetch partiel**
  — l'early-stop dans `handleFetchFollowers` se declenchait des que 3 pages
  consecutives presentaient ≥80% de followers deja en DB, en supposant
  qu'un fetch precedent avait collecte la liste complete. Apres un fetch
  partiel (clic Stop, 429 long, crash mid-fetch), la DB ne contenait que
  les followers les plus recents et le re-fetch s'arretait a la page 3 en
  ratant 80-90% des anciens.

  Le garde-fou ajoute exige desormais une couverture ≥85% du nombre total
  de followers annonce par Threads (champ `follower_count` du profil) avant
  d'autoriser l'early-stop. Si le total est inconnu (0), l'early-stop est
  desactive et la pagination va jusqu'au bout naturel (`max_id === null`).

### Added
- **`resolveUserProfile()`** dans `api-interceptor.ts` — fonction qui
  remplace `resolveUserId()` (toujours expose pour compat) en renvoyant
  `{ userId, followerCount }`. Utilise le meme endpoint
  `/api/v1/users/web_profile_info/`, parse `follower_count` du payload.

### Changed
- `handleFetchFollowers` log desormais le pourcentage de couverture quand
  l'early-stop est saute, pour debogage.

---

## [2.2.0] — 2026-05-07

### Added
- **Codes de licence courts `WFC-XXXX-XXXX`** — fini les `cs_live_xxx` de
  70 caracteres tires d'un ID Stripe interne. Apres paiement, le worker
  emet un code court (12 caracteres utiles, alphabet sans 0/O/1/I/L pour
  eviter la confusion). Le code apparait en gros sur la page de succes
  Stripe avec un bouton "Cliquer pour copier" ; le client le tape dans
  l'extension et c'est fini.
  - **Format** : `WFC-XXXX-XXXX` ou X = `[A-Z2-9]`. Entropie 31^8 ≈ 8.5×10^11.
  - **Genere cote Worker** via `getOrCreateLicenseCode()` : idempotent par
    session Stripe (re-utilise le meme code si la meme session est verifiee
    deux fois), avec retry sur collision.
  - **Stocke en D1** dans la nouvelle table `licenses` avec
    `session_id_hash` UNIQUE pour empecher les doubles emissions.
  - **Re-verifiable a vie** via `GET /verify?code=WFC-XXXX-XXXX`.
- **Migration automatique des anciens clients** — les licences activees
  avec `cs_live_xxx` (avant 2.2) recoivent leur code court a la prochaine
  re-verification. La cle stockee dans `chrome.storage` est upgradee
  automatiquement vers `WFC-XXXX-XXXX`. Aucune action requise du client.
- **Page de succes Stripe redessinee** — affiche le code en grand caractere
  monospace, avec bouton copier + bloc d'instructions pas-a-pas pour
  l'activation manuelle. Fallback gracieux si la generation echoue (continue
  d'afficher l'ID Stripe pour debogage).

### Changed
- `LICENCE_VERIFY_URL` accepte desormais `?code=WFC-...` en plus du
  `?session_id=cs_...` historique. Les deux formats coexistent : pas de
  breaking change pour les anciens deploiements.
- `ACTIVATE_LICENSE` dans le service worker detecte le format de l'input
  (Stripe / WFC code / Ed25519 owner token) et route automatiquement.
  Placeholder du champ d'activation passe a `WFC-XXXX-XXXX` (FR/EN/ES).
- `licence-activator.ts` lit `data-license-code` du DOM en priorite (depuis
  la nouvelle page de succes) et fallback sur `?session_id=` pour la
  retro-compatibilite.

### Schema D1 (v3)
- Nouvelle table `licenses(code PK, session_id_hash UNIQUE, created_at, revoked)`.
- Index sur `session_id_hash` pour la lookup d'idempotence.
- Deploy : `npx wrangler d1 execute wfc-community --remote --file worker-schema.sql`

### Migration recommandee
1. Deploye le worker mis a jour (`npx wrangler deploy` apres le SQL ci-dessus).
2. Publie l'extension 2.2.0 sur le Chrome Web Store.
3. Les anciens clients activeront automatiquement leur code court a la
   prochaine ouverture du panel licence (re-verif silencieuse via le hook
   d'auto-refresh communityToken existant).

---

## [2.1.1] — 2026-05-07

### Fixed
- **Followers fantomes ("owner sub-pages")** — le DOM scrape fallback
  ingerait `/@user/media` comme username `usermedia` (le slash etait
  strippe avant le garde-fou). Corrige dans `main.ts` ; un nettoyage
  one-shot tourne au boot du SW (`purgeOwnerSubPageFakes`) pour purger
  les entrees historiques matchant `<owner><tab>` (media/replies/tagged
  /reposts/saved/followers/following/liked).

### Added
- **Persistance licence cross-device** — chaque `saveLicense` mirror
  desormais vers `chrome.storage.sync` (~100 KB, synchronise via Google
  account). `getLicense` restaure automatiquement depuis sync si
  `chrome.storage.local` est vide. Une desinstallation + reinstallation
  du navigateur ne perd plus la licence tant que l'utilisateur reste
  connecte au meme compte Chrome.
- **Backup / restore licence par fichier** — nouveau bouton
  "Telecharger ma licence" dans le panel Licence : telecharge un
  `wfc-license-YYYY-MM-DD.json` portable. Bouton "Restaurer depuis un
  fichier" (visible meme licence inactive) le re-importe et relance la
  verification (Stripe ou Ed25519). Le `recoveryToken` est preserve a
  l'activation pour que le round-trip fonctionne pour les licences
  owner (`wfc_lic_*`) qui obfusquaient avant le token original.

### Changed
- **`LicenseInfo.recoveryToken`** — nouveau champ optionnel sur le type
  partage. Stocke le token d'activation original (cs_live_… ou wfc_lic_…)
  pour que l'export inclue ce qu'il faut pour re-activer ailleurs.

---

## [2.1.0] — 2026-05-06

Release de fondation : refactor structurel + durcissements + resilience MV3.
Aucun changement fonctionnel cote UI ; le scoring, le fetch et le clean
cycle se comportent identiquement a 2.0.4.

### Changed
- **Refactor pipeline** — `src/background/pipeline.ts` (1234 lignes, 539 lignes
  pour `runCleanCycleInternal`) decompose en sous-modules dedies :
  - `pipeline/i18n.ts` : table MSG + helpers `m()` / `loadLang()` /
    `fetchErrorToUserMessage()` (140 lignes extraites)
  - `pipeline/state.ts` : `log()`, `broadcast()`, `broadcastStats()`,
    `updateState()` (avec providers injectes pour rester decouple du runtime)
  - `pipeline/tab-manager.ts` : cycle de vie de l'onglet arriere-plan
    (`getOrCreateBackgroundTab`, `closeBackgroundTab`, `waitForTabLoad`,
    `findThreadsTab`, `tearDownBackgroundTab`)
  - `pipeline/messenger.ts` : `ensureContentScript`, `sendToContentScript`,
    discriminateurs typés `isChannelLostError` / `isTabGoneError`
  - `pipeline/follower-updater.ts` : helpers `markFake` / `markToReview` /
    `markOk` / `markRemoved` / `markNotFound` / `markScanError` qui dedupent
    les 5 blocs `updateFollower(...)` quasi-identiques (prevenait la derive
    quand un nouveau champ etait ajoute a un seul des 3 chemins de scoring)
  - `pipeline/timings.ts` : magic numbers du pacing (TAB.\*, PROFILE_VISIT.\*,
    COOLDOWN.\*, PACER.\*) regroupes en un seul fichier
  - `pipeline.ts` reduit a **922 lignes (-25 %)**
- **Centralisation seuils scoring** — `src/shared/scoring-config.ts` regroupe
  tous les seuils tuneables (DECISION, USERNAME, FC_BANDS, SIGHTINGS, RATIO,
  PRE_SCORE, WEIGHTS, POSTS, COMBOS, PRIVATE_ACCOUNT). `scorer.ts` les importe
  au lieu de hardcoder. Le calcul est strictement equivalent — les noms
  remplacent les literaux. Rend possible un override A/B sans rebuild.
- **Commentaire RATE_LIMIT clarifie** — `rate-tracker.ts` indiquait "50/h max"
  alors que `RATE_LIMIT_HOUR = 9999`. Doc alignee : la cadence est imposee
  par `HumanPacer`, le compteur horaire sert a la telemetrie/UI uniquement.
- **Sidepanel `useEffect`** — `App.tsx` decoupe en trois effets distincts
  (settings/onboarding, licence load, communityToken auto-refresh) avec
  cleanup `cancelled` flag pour eviter les setState apres unmount. L'effet
  d'auto-refresh re-reagit maintenant correctement quand la cle de licence
  change (avant : ne s'executait qu'une fois, ratait les nouvelles licences).

### Added
- **Resilience MV3** — l'ID de l'onglet arriere-plan est mirrore dans
  `chrome.storage.session` apres chaque mutation. Au boot du service worker
  (qui se termine apres ~30 s d'inactivite en MV3), `restoreSessionState()`
  reseed le cache memoire si la tab existe encore — sinon nettoie l'etat
  obsolete. Plus de doublons d'onglet apres recyclage du SW.
- **Hook upgrade IndexedDB** — `DB_VERSION` passe a 2 avec un `upgrade(db,
  oldVersion)` qui chaine les migrations (v0→v1 reproduit l'init existant,
  v1→v2 no-op). Pose le pattern pour les futurs ajouts de champs/index sans
  casser les utilisateurs existants.
- **`chrome.runtime.onSuspend` handler** — marque le pipeline comme avorte
  (`lastError: "service_worker_suspended"`) si le SW s'eteint en plein
  cycle. Le sidepanel affiche l'etat correct au prochain ouverture au lieu
  d'un "running" fantome.
- **Bridge MAIN-world durci** — `main-world-bridge.ts` lit un secret
  per-instance (UUID v4) via `dataset.wfcSecret` au chargement du script.
  Toute requete sans le secret matchant est ignoree ; les responses
  l'incluent pour que `api-interceptor.ts` puisse rejeter les messages
  forges. Bloque l'eavesdropping/spoofing par scripts tiers sur la page
  Threads (defense-in-depth — la page voit deja les donnees, mais le
  bridge n'est plus un canal trivialement exploitable).
- **Allowlist endpoints bridge** — le bridge refuse desormais toute URL
  ne matchant pas `^https://(?:www\.)?threads\.(?:net|com)/api/`. Ferme
  un risque SSRF theorique si un script malveillant prenait le contrele
  du content script isolated.
- **Queue communauté persistee** — votes et sightings qui echouent
  (offline, 5xx, SW restart) sont mis en queue `chrome.storage.local`
  (cap 500 entrees, max 5 attempts par item). Une alarme Chrome de
  15 min replay la queue : 4xx droppes (auth invalide, rate-limited),
  2xx removes, 5xx/network re-tentes. Avant : `.catch(() => {})`
  silencieusement perdait les votes en cas d'indispo Worker.
- **Drift telemetry** — `src/shared/selector-strategies.ts` introduit un
  pattern de chaine de fallbacks ordonnee + callback `onDrift`.
  `main.ts` route les drift events vers le service worker comme log
  category `"drift"` ; `App.tsx` affiche un toast "Threads a change son
  interface — l'extension s'adapte" la premiere fois par session.
  Foundation prete pour migrer les selecteurs critiques (modal,
  followers count, menu) au pattern strategies dans une release suivante.
- **`is429()` multi-locale** — etend la detection 429 de FR/EN aux
  ES/PT/DE/IT/NL (page-not-working et too-many-requests dans 7 langues).
  Reduit le risque qu'un utilisateur non-anglophone voie ses cycles
  echouer silencieusement faute de detection du rate-limit.

### Performance
- **Scraper DOM scoping** — `extractProfileFromDom()` dans
  `threads-scraper.ts` utilise un nouveau helper `getProfileScope()` (=
  `<main>` ou fallback `<body>`) au lieu de querySelectorAll
  document-wide pour follower count, profile pic, full name, link-in-bio.
  Reduit le nombre de noeuds scannes de ~hundreds (feed inclus) a
  ~dizaines, et evite les faux-positifs (mentions "X followers" dans des
  posts du feed qui poisonnaient la detection).
- **`navigateToTab` early-exit** — verifie le texte avant de forcer un
  reflow via `getBoundingClientRect()`. Sur un feed populated, gain
  ~ms-mesurables (avant : reflow par candidat, ~hundreds de candidats).

### Security
- **Worker rate-limit atomique** — `checkAndBumpRateLimit` dans
  `stripe-verify-worker.js` remplace le SELECT-puis-INSERT race-condition
  par un `INSERT ... ON CONFLICT DO UPDATE ... RETURNING count` atomique.
  Avant : N requetes concurrentes pouvaient toutes voir count<limit et
  bumper au-dessus. Maintenant : la requete qui pousse count > limit est
  la premiere rejetee.
- **Erreurs worker opaquifiees** — le top-level catch et `/verify`
  retournaient `String(e)` au client (potentiellement stack traces ou
  details infra Stripe/Cloudflare). Remplace par `{error: "internal_error"}`
  ou `{error: "verify_failed"}` ; vraie erreur loggee cote worker
  uniquement (visible operateur, jamais client).

### Internal
- Build vite produit toujours les 6 bundles MV3 attendus (service-worker.js,
  content.js, main-world-bridge.js, licence-activator.js, sidepanel-\*.js,
  popup-\*.js).
- Aucun fichier `.test.ts` ajoute dans cette release — le backlog 2.2 prevoit
  Vitest sur `scorer.ts`, `pacer.ts`, `pipeline/follower-updater.ts`,
  `pipeline/messenger.ts`, et la queue communaute.

### Verification manuelle recommandee avant release
1. Build clean : `npm run build` — 0 warning TS.
2. Fetch complet sur compte de test (~100 followers) : pages incrementales
   sauvegardees, pas de duplication.
3. Clean cycle 50 followers en mode free : pas de regression du scoring,
   suppression OK.
4. Mode continu 30+ min : SW se recycle au moins 1× ; reprise sans
   creation d'onglet duplique.
5. Couper le wifi 30s pendant un cycle clean : votes mis en queue, replay
   automatique a la reconnexion (visible dans logs SW).
6. Verifier dans DevTools console de la page Threads que le bridge accepte
   bien des URLs `/api/v1/...` mais refuse une URL forgee (ex.
   `attacker.com`) — devrait retourner `error: "url_not_allowed"`.

---

## [2.0.4] — 2026-05-01

### Fixed
- **Detection des comptes prives plus fiable** — deux problemes combines :
  1. `selectors.ts` ne couvrait que 3 regex EN/FR partielles. Ajout des
     phrases banner pour ES, PT, DE, IT, NL, JP et ZH (variantes courantes
     incluses, ex. "this is a private account" qui n'etait pas matche).
  2. `pipeline.ts` utilisait `??` pour fusionner `profileData.isPrivate` et
     `follower.isPrivate`. `false` n'etant pas nullish, un DOM scan rate
     ecrasait le booleen correct venu de l'API followers. Remplace par `||`
     (priorite a "prive" si l'une des deux sources le voit).
- **Detection DOM precise** — `extractProfileFromDom` cherche maintenant
  d'abord dans les headings (`h1`/`h2`/`h3`/`[role=heading]`) et les
  attributs `aria-label`/`title`, puis fallback sur `bodyText`. Reduit les
  faux positifs venant de bios contenant le mot "private" et augmente le
  taux de detection sur les variantes de markup Threads.

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
