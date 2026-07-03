# Audit d'architecture globale + plan de restructuration UX/UI — Wav Fake Cleaner V3

> **Méthode.** Cet audit a été produit par lecture du code réel (12 agents : 6 dimensions × 1 auditeur + 1 vérificateur adversarial qui a rouvert chaque fichier cité). Chaque constat conservé ici est ancré sur un chemin de fichier et une ligne vérifiés. Les dimensions « surfaces » et « vocabulaire » ont vu leur auditeur rendre un gabarit vide ; leurs constats proviennent de l'agent de vérification, qui a lu les fichiers de son côté — ils sont donc réels mais formulés comme « ce qu'un audit correct aurait relevé ». La vision cible et le plan par lots (volets 3 et 4) sont une synthèse, à valider.

---

## 1. Synthèse exécutive

Le moteur est solide et la V3 a déjà fait un vrai travail de sécurité (analyse qui ne supprime jamais, confirmation, fenêtre d'annulation, humanisation anti-429). Mais l'enveloppe produit trahit le positionnement « premium, épuré, simple pour n'importe qui » sur trois plans :

1. **Le chemin entre les étapes n'est pas tracé.** L'app montre des boutons, elle ne guide pas. Point le plus grave : après l'analyse, **rien** ne conduit l'utilisateur vers ses résultats — il reste sur l'onglet « Nettoyage » et doit deviner qu'il faut aller sur l'onglet « Résultats » **puis** cliquer le filtre « Faux » pour enfin voir ce qu'il va supprimer ([App.tsx:261](src/sidepanel/App.tsx:261), [FollowerTable.tsx:246](src/sidepanel/components/FollowerTable.tsx:246)).
2. **L'interface expose la tuyauterie d'ingénieur.** Six stat-cards de poids égal mélangent des KPI et des états internes (« En attente », « Analysés »), la carte Communauté affiche « Envoyés / En file / Perdus / Réessayer », le tableau montre un « Score : 73 » brut, le vocabulaire hésite entre argot growth-hacking (« Tout débrider », « Moins cher qu'un burger ») et jargon froid (« Seuil de détection »).
3. **Le design premium existe en intention, pas à l'écran.** Le token d'échelle typo (`--text-display/title/body/label`) et le token violet `--color-community` sont **définis mais jamais utilisés** ; l'écran est un arc-en-ciel de 6 teintes vives sur des surfaces gris-bleu (`gray-900`) qui masquent le fond encre revendiqué ; du **code de diagnostic temporaire part en production** dans le content-script.

**Direction proposée :** remplacer la navigation à 3 onglets par **un écran unique guidé** qui déroule le parcours en **3 gestes** (connecter → analyser → nettoyer) et affiche toujours la prochaine action ; **garder** l'encre + l'ambre + Satoshi mais passer à **un seul accent fort** (supprimer le violet), neutraliser l'arc-en-ciel et brancher enfin l'échelle typo ; **assainir le vocabulaire** ; purger la dette (diagnostic, god-components). Le moteur ne bouge pas.

---

## 2. Audit détaillé

Gravité : 🔴 critique · 🟠 majeur · 🟡 mineur.

### Volet 1 — Parcours utilisateur

- 🔴 **Cul-de-sac après l'analyse.** L'onglet par défaut est « cleanup » ([App.tsx:47](src/sidepanel/App.tsx:47)) et le seul `setTab` est le clic manuel d'onglet ([App.tsx:261](src/sidepanel/App.tsx:261)) — aucune bascule automatique vers les résultats en fin d'analyse. Le tableau démarre sur le filtre « Tous » ([FollowerTable.tsx:246](src/sidepanel/components/FollowerTable.tsx:246)) alors que les cases à cocher n'apparaissent **que** sous le filtre « Faux » ([FollowerTable.tsx:293](src/sidepanel/components/FollowerTable.tsx:293) et :413). L'utilisateur doit enchaîner deux sauts non indiqués.
- 🟠 **L'onboarding ouvre un écran technique.** L'étape 1 envoie vers le SettingsPanel ([Onboarding.tsx:20](src/sidepanel/components/Onboarding.tsx:20)), qui expose au même niveau que le pseudo un champ « Seuil de détection » à 70 en `<input type=number>` librement modifiable ([SettingsPanel.tsx:77](src/sidepanel/components/SettingsPanel.tsx:77)). Décision de scoring imposée à un non-technicien dès le 1er écran.
- 🟠 **Le @username, préalable obligatoire, n'est jamais imposé.** « Analyser » est `disabled` seulement sur `loading`/`isRunning` ([ControlPanel.tsx:268](src/sidepanel/components/ControlPanel.tsx:268)), jamais sur l'absence de pseudo ; l'onboarding se ferme sans vérifier la saisie ([Onboarding.tsx:14](src/sidepanel/components/Onboarding.tsx:14)) ; le pipeline part alors sur `ownerUsername = ""` ([service-worker.ts:495](src/background/service-worker.ts:495)).
- 🟠 **Doublons de suppression via le « Mode avancé ».** Le repli « Mode avancé (boutons séparés) » ([ControlPanel.tsx:321](src/sidepanel/components/ControlPanel.tsx:321)) rouvre un bouton « Nettoyer les fakes » qui scanne **et** supprime d'un coup — et déclenche même le mode continu pour un licencié ([ControlPanel.tsx:165](src/sidepanel/components/ControlPanel.tsx:165)). Deux chemins de suppression aux logiques opposées coexistent.
- 🟠 **Mode continu caché et non expliqué avant le clic.** Il n'existe que dans le repli avancé ([ControlPanel.tsx:342](src/sidepanel/components/ControlPanel.tsx:342)) et sa nature (« supprime automatiquement en arrière-plan, en continu ») n'est décrite que dans la modale post-clic (`confirm_continuous_body`, i18n:251).
- 🟡 **L'état vide pointe vers un bouton hors flux.** « Lance d'abord *Récupérer les abonnés* ci-dessus » ([i18n.ts:76](src/sidepanel/lib/i18n.ts:76)) désigne un bouton qui n'existe qu'en mode avancé et dans un **autre** onglet.
- 🟡 **Fenêtre d'annulation figée à 8 s en dur** ([ControlPanel.tsx:177](src/sidepanel/components/ControlPanel.tsx:177)), sans option « Revoir la liste ».
- **Angles morts relevés à la vérification :** aucune validation du @ saisi ([SettingsPanel.tsx:63](src/sidepanel/components/SettingsPanel.tsx:63)) ; point de saisie du pseudo quasi invisible une fois l'onboarding fermé ; moment paywall « 5 visibles · N cachés » non traité ([FollowerTable.tsx:474](src/sidepanel/components/FollowerTable.tsx:474)) ; sortie du mode continu jamais matérialisée ; pas de boucle de clôture vers le journal « Supprimés ».

### Volet 2 — Hiérarchie de l'information

- 🟠 **6 stat-cards de poids égal** ([StatCards.tsx:136](src/sidepanel/components/StatCards.tsx:136)) noient les 2 seuls chiffres actionnables (Faux, Supprimés) sous des états de tuyauterie (« En attente », « Analysés » — i18n:11-12). *Aggravation relevée en vérif :* l'ordre place même le contexte **avant** « Faux ».
- 🟠 **Redondance rouge en tête de page.** Le sous-texte « Estimation ~X faux » ([StatCards.tsx:128](src/sidepanel/components/StatCards.tsx:128)) et la bannière prescan ([App.tsx:277](src/sidepanel/App.tsx:277)) répètent la même mauvaise nouvelle. *Nuance vérifiée :* la jauge reste grise avant scan (elle n'ajoute pas un 3ᵉ rouge), mais le même nombre de faux est répété jusqu'à **4 fois** (estimation, prescan, carte « Faux », badge d'onglet [App.tsx:266](src/sidepanel/App.tsx:266)).
- 🟠 **CommunityCard = tableau de bord d'observabilité.** Compteurs « Envoyés / En attente / Perdus » + raison technique + bouton « Réessayer » ([CommunityCard.tsx:124](src/sidepanel/components/CommunityCard.tsx:124)) ; le fichier l'admet (« the user-facing half of the v3 observability work », :8-13). Plomberie du Worker exposée en façade.
- 🟠 **Le dashboard ne dit jamais « et maintenant ? ».** StatCards est rendu hors onglets et sans aucun CTA ([App.tsx:248](src/sidepanel/App.tsx:248)) ; l'action primaire vit dans ControlPanel, donc disparaît dès qu'on quitte l'onglet Nettoyage.
- 🟡 **Score brut + statut « OK » en dur** ([FollowerTable.tsx:208](src/sidepanel/components/FollowerTable.tsx:208), :221) : deux colonnes pour la même info, dont une en langage machine.
- 🟡 **Le détail d'une ligne empile 3 sections** de poids égal (infos / analyse / vote communautaire) sans hiérarchie ([FollowerTable.tsx:588](src/sidepanel/components/FollowerTable.tsx:588)).
- **Cause racine transverse (vérif) :** tout est en `text-[11px]` → aucune hiérarchie par la taille ; le rouge est sémantiquement surchargé (alarme, score élevé, bouton destructeur, vote « Fake », erreur).

### Volet 3 — Architecture des surfaces

*(auditeur défaillant ; constats issus de la vérification, fichiers en main)*

- **Description du manifest en anglais** pour une cible francophone : « Detect and remove fake followers… » ([vite.config.ts:96](vite.config.ts:96), dist/manifest.json:5). Visible sur le Web Store et `chrome://extensions`.
- **Popup bilingue codé en dur, hors i18n** : « Ouvrir le panneau / Open Panel » ([popup.tsx:47](src/popup/popup.tsx:47)).
- **Incohérence d'identité de marque** : « by Fred Wav » pointe vers `threads.net/@fredwavoff` ([popup.tsx:31](src/popup/popup.tsx:31)) mais `fredwav.com/contact` ([App.tsx:189](src/sidepanel/App.tsx:189)).
- **Popup vs side panel redondants** : `openPanelOnActionClick:true` ([service-worker.ts:99](src/background/service-worker.ts:99)) court-circuite le `default_popup` du manifest → le popup devient une surface morte.
- **Sélecteur de langue peu découvrable** : un seul bouton cycle fr→en→es ([App.tsx:166](src/sidepanel/App.tsx:166)).
- **`<html lang="fr">` figé** (popup.html:2, sidepanel.html:2) alors que le contenu affiche de l'anglais.

### Volet 4 — Architecture des composants & dette technique

- 🔴 **Code de diagnostic TEMPORAIRE en production.** `loggedFollowerShape` + `probeUserInfo` (« PROBE diagnostique (TEMP) ») lancent une **requête supplémentaire** vers `/api/v1/users/{id}/info/` à chaque premier fetch ([api-interceptor.ts:276](src/content/api-interceptor.ts:276), déclenché :330), sans garde `import.meta.env.DEV`. Surface anti-bot augmentée pour zéro bénéfice — grave pour un produit qui vend la sécurité du compte.
- 🟠 **~16 `console.log("[WFC]…")` bruts** non conditionnés dans le content-script ([api-interceptor.ts:193](src/content/api-interceptor.ts:193) et 16 autres), en double du canal propre `dbg()`.
- 🟠 **FollowerTable = god-component** (678 l) : SHA-256 + cache, client réseau communautaire, moteur de 25+ regex `breakdownToReadable`, export CSV, gestion d'onglets, 11 `useState` ([FollowerTable.tsx:40](src/sidepanel/components/FollowerTable.tsx:40), :108, :191, :244).
- 🟠 **ControlPanel** (513 l) mêle orchestration pipeline, machine à états de suppression différée avec timers/refs, calcul d'ETA et modale de confirmation en IIFE inline de 61 lignes ([ControlPanel.tsx:174](src/sidepanel/components/ControlPanel.tsx:174), :450).
- 🟠 **Duplication métier fragile** : le scorer émet des jetons texte (`link_bio -15`…) que l'UI re-décode par regex ([scorer.ts:481](src/background/scorer.ts:481) ↔ [FollowerTable.tsx:139](src/sidepanel/components/FollowerTable.tsx:139)). Renommer un jeton casse l'affichage **sans erreur de compilation**.
- 🟡 `useLog(300)` trompeur : 300 est la taille du buffer, pas un intervalle ([App.tsx:50](src/sidepanel/App.tsx:50) ↔ [useLog.ts:8](src/sidepanel/hooks/useLog.ts:8)).
- 🟡 Sélection des faux dispersée sur 3 composants sans abstraction ([FollowerTable.tsx:292](src/sidepanel/components/FollowerTable.tsx:292) → App → ControlPanel).
- **Vérif :** 28 occurrences `purple-` en dur (dette visuelle) ; « Fake »/« No Fake » non i18n ([FollowerTable.tsx:638](src/sidepanel/components/FollowerTable.tsx:638)) ; dispatch dynamique non typé `api[action]` ([ControlPanel.tsx:133](src/sidepanel/components/ControlPanel.tsx:133)) ; `GET_STATS` matérialise tout le store toutes les 3 s en run actif.

### Volet 5 — Direction visuelle *(tout rediscutable)*

- 🟠 **Deux accents forts en concurrence, le violet gagne.** L'ambre (token) n'est présent que sur ~7 zones, tandis que le violet Tailwind **en dur** porte l'essentiel des CTA de conversion (paywall, liens @, upsell, toggles, prix Pro). Hiérarchie d'action inversée. `grep purple|violet` ≈ 27 usages réels contre ~7 ambre.
- 🟠 **Token `--color-community` (violet) défini mais jamais utilisé** ([globals.css:32](src/sidepanel/styles/globals.css:32)) — et la carte Communauté est en fait **bleue** ([CommunityCard.tsx:118](src/sidepanel/components/CommunityCard.tsx:118)). Source de vérité fantôme.
- 🟠 **Échelle typo nommée jamais consommée.** `--text-display/title/body/label` ([globals.css:38](src/sidepanel/styles/globals.css:38)) : 0 usage. Tout est en tailles ad hoc, `text-[11px]` **85 fois**. C'est le point le plus coûteux pour un feel Apple/Linear — la hiérarchie typographique n'existe pas à l'écran.
- 🟠 **StatCards = arc-en-ciel de 6 teintes vives** (bleu/jaune/cyan/rouge/orange/vert — [StatCards.tsx:6](src/sidepanel/components/StatCards.tsx:6)), premier écran vu.
- 🟡 **Aucun système de radius** (79 occurrences mélangeant `rounded` nu/md/lg/xl/2xl/full).
- 🟡 **Commentaire Satoshi-Variable obsolète** (le fichier n'existe pas ; seulement 400/500/700, pas de 600 semibold — [globals.css:47](src/sidepanel/styles/globals.css:47)).
- 🟡 **Le fond encre est masqué** par des surfaces `gray-900/800` ([Modal.tsx:35](src/sidepanel/components/Modal.tsx:35), etc.) — l'encre ne transparaît quasi jamais.
- 🟡 **Léger rebond (overshoot 1.15)** sur modale et toast ([globals.css:97](src/sidepanel/styles/globals.css:97)) — plus ludique que sobre.
- **Manques (vérif) :** contraste AA jamais chiffré (nombreux `gray-500/600` sur encre à risque) ; aucun token de spacing ; aucune couleur sémantique tokenisée (`--color-success/danger/warning`) ; focus clavier violet ou absent ; cibles tactiles < 40 px.

### Volet 6 — Vocabulaire & ton (i18n FR/EN/ES)

*(auditeur défaillant ; constats issus de la vérification)*

- **Anglais brut affiché en FR** : « Fake » / « No Fake » ([i18n.ts:104](src/sidepanel/lib/i18n.ts:104)), « Score » laissé tel quel en FR et ES ([i18n.ts:31](src/sidepanel/lib/i18n.ts:31)).
- **« Follower » vs « abonnés »** incohérents dans la même langue ([i18n.ts:30](src/sidepanel/lib/i18n.ts:30) vs :111).
- **Deux vocabulaires parallèles** pour la même action : « Analyser »/« Supprimer » (flux) vs « Nettoyer les fakes » / onglet « Nettoyage » (avancé).
- **Jargon métier sans explication** : « En attente / Analysés / À vérifier », `bd_ghost` = « Compte fantôme » (calque), « Santé du compte » = jauge 0-100 sans légende.
- **Rapport de diagnostic copié en anglais codé en dur** ([LogConsole.tsx:26](src/sidepanel/components/LogConsole.tsx:26)) et niveaux `INFO/WARNING/ERROR` exposés à l'utilisateur.
- **Registre incohérent** : argot growth-hacking (« Tout débrider », « Débloquer le vote », « Moins cher qu'un burger ») cohabite avec du jargon froid (« Seuil de détection »). Aucune charte de ton.

---

## 3. Vision cible

**Principe directeur : un écran, un parcours, une prochaine action toujours visible.** On supprime la navigation à onglets de premier niveau ; l'écran principal *est* la machine à états du parcours et affiche l'étape courante. Communauté, journal et réglages avancés passent en second plan.

### Le parcours en 3 gestes

1. **Connecter** — saisir son `@` une seule fois, **inline** dans l'écran principal (plus dans une modale Paramètres). Tant que le `@` est vide, l'action reste bloquée avec une micro-copie explicite.
2. **Analyser** — un seul bouton. L'analyse ne supprime jamais (promesse maintenue). À la fin, l'écran **bascule tout seul** sur les résultats.
3. **Nettoyer** — la liste des faux est déjà cochée par défaut ; un CTA « Supprimer les N » ; fenêtre d'annulation généreuse ; écran de clôture qui confirme ce qui a été retiré.

### Wireframes (side panel étroit)

**État 0 — pas de compte connecté**
```
┌───────────────────────────┐
│ ✦ Wav Fake Cleaner     ⚙  │
├───────────────────────────┤
│  Nettoie tes faux         │
│  abonnés en 2 minutes.    │
│                           │
│  Ton compte Threads       │
│  ┌─────────────────────┐  │
│  │ @ ton_pseudo        │  │
│  └─────────────────────┘  │
│  ┌─────────────────────┐  │
│  │  Analyser mon compte│  │ ← ambre ; grisé tant que @ vide
│  └─────────────────────┘  │
│  🔒 On ne supprime rien   │
│     sans ton accord.      │
└───────────────────────────┘
```

**État 1 — analyse en cours**
```
┌───────────────────────────┐
│  Analyse de @ton_pseudo   │
│                           │
│  ███████░░░░░  1 240/3 500 │
│  Environ 2 min restantes  │
│                           │
│  On repère les faux,      │
│  on ne touche à rien.     │
│           [ Arrêter ]     │ ← secondaire, discret
└───────────────────────────┘
```

**État 2 — résultats / revue (cœur du produit)**
```
┌───────────────────────────┐
│         142               │ ← chiffre héros (display)
│     faux abonnés          │
│   sur 3 500 abonnés       │
│  ┌─────────────────────┐  │
│  │  Supprimer les 142  │  │ ← CTA ambre
│  └─────────────────────┘  │
│  Décoche ceux à garder.   │
│  ── La liste ───────────  │
│  ☑ @user1      Suspect ⌄ │
│  ☑ @user2      Suspect ⌄ │
│  ☑ @user3      Douteux ⌄ │
│  …                        │
│  ▸ 12 comptes à vérifier  │ ← repli
│  ▸ Aider la communauté    │ ← repli discret
└───────────────────────────┘
```

**État 3 — fenêtre d'annulation**
```
┌───────────────────────────┐
│ ⏳ Suppression dans 12 s   │
│ 142 faux retirés en       │
│ douceur (≈ 30–60 min).    │
│ [ Annuler ]   [ Revoir ]  │
└───────────────────────────┘
```

**État 4 — terminé**
```
┌───────────────────────────┐
│          ✓                │
│   142 faux supprimés      │
│  Ton audience est plus    │
│  saine.                   │
│  [ Voir ce qui a été      │
│    retiré ]               │
│  [ Relancer une analyse ] │
└───────────────────────────┘
```

**États d'erreur** (mêmes principes, langage utilisateur)
```
⏸ On lève le pied — Threads nous demande de ralentir.
   Reprise automatique dans 4 min. Ton compte reste protégé.   (429)

Ton accès Pro a expiré. [ Réactiver ]                          (licence)

On ne trouve pas @ton_pseudo. Vérifie l'orthographe.          (compte introuvable/privé)
```

### Direction visuelle cible

- **Palette : un seul accent fort.** Fond encre `#0c0a12` **réellement porté par des surfaces dérivées** (`surface-1` = encre, `surface-2` = encre éclaircie, bordures encre translucide) ; **ambre `#F5A524`** = seule couleur d'action ; **rouge réservé au danger réel** (nombre de faux, bouton Supprimer) ; vert discret pour le succès. **Suppression du violet, du cyan, du jaune, de l'orange et du bleu décoratifs.** *Justif : un seul accent = lecture immédiate de « où agir », signature premium.*
- **Typographie : brancher l'échelle.** `display` pour les chiffres héros et titres, `title`/`body`/`label` ensuite ; bannir `text-[11px]` ad hoc ; Satoshi 400/500/700 (+600 optionnel pour les titres). *Justif : la hiérarchie par contraste de taille fait 80 % du feel Apple/Linear.*
- **Densité & rythme :** tokens de spacing, plus d'air, rythme vertical généreux. *Justif : le premium se lit dans l'espace, pas dans la densité.*
- **Formes :** échelle de radius tokenisée (sm inputs/badges, md boutons/cartes, lg modales).
- **Mouvement :** garder les fondus discrets gated `prefers-reduced-motion`, retirer l'overshoot des entrées système.
- **Accessibilité :** contrastes vérifiés ≥ 4.5:1, anneau de focus ambre visible, cibles ≥ 40 px.

### Ce qui disparaît (et où ça va)

| Élément actuel | Destination |
|---|---|
| Onglets Nettoyage / Résultats / Communauté | **Supprimés** → écran unique guidé (résultats dans le flux) |
| 6 StatCards arc-en-ciel | **Fondus** → chiffre héros + contexte discret ; « En attente »/« Analysés » → barre de progression |
| Estimation + une des bannières rouges | **Un seul messager** du chiffre choc |
| CommunityCard (Envoyés/En file/Perdus/Réessayer) | **Repliée** → « Tu as contribué X signalements » ; plomberie → Paramètres/auto-silencieux |
| Journal d'activité + niveaux de log | **Paramètres > support** (bouton « Copier le diagnostic ») |
| Mode avancé (boutons séparés) | **Supprimé** (le flux guidé couvre tout) |
| Colonne « Score : 73 » | **Verdict qualitatif** (Suspect / Douteux / OK) ; chiffre exact dans le détail replié |
| Champ « Seuil de détection » | **Défaut fixe** ; réglable seulement en « mode expert » (Paramètres) |
| Popup bilingue codé en dur | **Supprimé** (le clic ouvre déjà le panneau) ou réduit à l'i18n |
| Mode continu caché | **Option de 1er niveau** clairement décrite avant activation + état « actif » avec arrêt visible |

---

## 4. Plan de restructuration par lots

Lots **indépendants, testables un par un**, du plus structurant au plus cosmétique. **Aucune régression tolérée** sur : pipeline de scan, anti-429/humanisation, licence Stripe/Ed25519, votes communautaires.

### Lot 0 — Hygiène & sécurité (rapide, sans risque UI)
- **Objectif :** purger la dette qui touche la prod avant toute refonte.
- **Fichiers :** [api-interceptor.ts](src/content/api-interceptor.ts) (retirer `probeUserInfo`, `loggedFollowerShape`, le bloc DIAG, les `console.log` bruts en gardant `dbg()`), [i18n.ts](src/sidepanel/lib/i18n.ts) + [LogConsole.tsx](src/sidepanel/components/LogConsole.tsx) (passer « Fake »/« No Fake » et le rapport de diagnostic par `t()`).
- **Risque :** faible ; vérifier que la boucle de parsing des abonnés ne dépendait pas du probe.
- **Validation :** un scan complet fonctionne à l'identique ; la console de la page Threads ne déverse plus de logs ; aucune requête `/users/{id}/info/` superflue au 1er fetch.

### Lot 1 — Tracer le chemin (résout le cul-de-sac 🔴)
- **Objectif :** l'app pose toujours la prochaine action ; le préalable `@` est bloquant et visible.
- **Fichiers :** [App.tsx](src/sidepanel/App.tsx) (bascule auto vers résultats + filtre « Faux » en fin d'analyse ; saisie `@` inline), [ControlPanel.tsx](src/sidepanel/components/ControlPanel.tsx) (désactiver « Analyser » sans pseudo + micro-copie), [FollowerTable.tsx](src/sidepanel/components/FollowerTable.tsx) (état vide → CTA réel), [SettingsPanel.tsx](src/sidepanel/components/SettingsPanel.tsx) (validation du `@`).
- **Risque :** moyen (couplage état onglet/filtre) ; ne pas casser le flux existant sur un compte déjà scanné.
- **Validation :** un débutant sans pseudo est bloqué avec un message clair ; après analyse, il voit **directement** ses faux prêts à supprimer, sans cliquer d'onglet ni de filtre.

### Lot 2 — Écran unique guidé (restructure les surfaces)
- **Objectif :** remplacer les 3 onglets par la machine à états du parcours ; clarifier popup et mode continu.
- **Fichiers :** [App.tsx](src/sidepanel/App.tsx) (retirer la tablist, orchestrer les états 0→4), [ControlPanel.tsx](src/sidepanel/components/ControlPanel.tsx) (supprimer le « Mode avancé », sortir le mode continu en option décrite), [popup.tsx](src/popup/popup.tsx) (supprimer ou i18n), manifest via [vite.config.ts](vite.config.ts) (description FR, lang cohérente).
- **Risque :** élevé (c'est le gros morceau structurel) ; faire ce lot **après** le Lot 1 pour partir d'un flux déjà cohérent.
- **Validation :** plus aucun onglet ; l'écran affiche l'étape courante à chaque état ; le mode continu est compréhensible avant activation et arrêtable visiblement.

### Lot 3 — Hiérarchie de l'information
- **Objectif :** un chiffre héros, zéro redondance, zéro jargon en façade.
- **Fichiers :** [StatCards.tsx](src/sidepanel/components/StatCards.tsx) (2 rangs : héros vs contexte ; retirer estimation redondante), [App.tsx](src/sidepanel/App.tsx) (une seule bannière du chiffre choc), [CommunityCard.tsx](src/sidepanel/components/CommunityCard.tsx) (réduire à la contribution), [FollowerTable.tsx](src/sidepanel/components/FollowerTable.tsx) (verdict qualitatif au lieu du score brut ; hiérarchiser le détail de ligne).
- **Risque :** faible/moyen ; purement présentation, le moteur ne change pas.
- **Validation :** l'œil tombe d'abord sur le nombre de faux ; plus de « Envoyés/En file/Perdus » ni de « Score : 73 » exposés.

### Lot 4 — Design system (un seul accent)
- **Objectif :** rendre le premium réel à l'écran.
- **Fichiers :** [globals.css](src/sidepanel/styles/globals.css) (tokens surface dérivés de l'encre, radius, spacing, couleurs sémantiques `success/danger/warning`, corriger le commentaire Satoshi), puis remplacement des `purple-*`, `gray-900/800` et des 6 teintes StatCards, branchement de l'échelle typo dans tous les composants, focus ambre.
- **Risque :** moyen (large surface de fichiers, mais mécanique) ; procéder token par token.
- **Validation :** un seul accent ambre visible ; plus de violet/arc-en-ciel ; les tailles de texte suivent l'échelle nommée ; contrastes AA vérifiés.

### Lot 5 — Vocabulaire & ton
- **Objectif :** une charte de vocabulaire unique, grand public, cohérente sur FR/EN/ES.
- **Fichiers :** [i18n.ts](src/sidepanel/lib/i18n.ts) (unifier « abonnés », traduire Score/Fake, choisir un registre — tutoiement chaleureux sans argot ni jargon, remplacer « Seuil de détection », « Tout débrider »…), et les libellés en dur restants.
- **Risque :** faible ; attention à ne pas oublier une des 3 locales.
- **Validation :** aucun mot anglais ni terme technique visible dans les 3 langues ; ton homogène.

### Lot 6 — Refactor des god-components (dette pure)
- **Objectif :** rendre le code maintenable et testable, sans changement visible.
- **Fichiers :** extraire de [FollowerTable.tsx](src/sidepanel/components/FollowerTable.tsx) → `lib/community.ts`, `lib/breakdown.ts`, `lib/export.ts`, `lib/profileTab.ts` + sous-composants `<FollowerRow>`, `<FollowerDetail>`, `<CommunityVote>` ; extraire de [ControlPanel.tsx](src/sidepanel/components/ControlPanel.tsx) → hooks `useDeferredDelete`, `useRunEta` + `<DeleteConfirmModal>` ; centraliser les codes de breakdown en constante `@shared` partagée scorer↔UI.
- **Risque :** moyen ; couvrir `breakdown` par un test pour verrouiller le contrat producteur/consommateur.
- **Validation :** comportement identique ; les tests passent ; les deux fichiers repassent sous ~250 lignes.

### Lot 7 — Finitions (cosmétique, optionnel)
- **Objectif :** dernières touches premium.
- **Fichiers :** [globals.css](src/sidepanel/styles/globals.css) (retirer l'overshoot), audit iconographie, tailles de cibles tactiles, ordre de tabulation clavier.
- **Validation :** entrées système sans rebond ; icônes homogènes ; navigation clavier propre.

---

## 5. Questions ouvertes (arbitrage nécessaire)

1. **Onglets :** on supprime bien la navigation à onglets au profit de l'écran unique guidé (Lot 2) ? Ou tu tiens à garder « Communauté » accessible en permanence ?
2. **Violet :** suppression **totale** du violet au profit de l'ambre seul, confirmée ? (impacte tous les CTA de conversion : paywall, licence, upsell)
3. **Mode continu :** on le remonte en option de 1er niveau clairement décrite, ou tu préfères le garder discret (réservé aux power-users) ?
4. **Communauté :** on la réduit à une ligne de valorisation (« tu as contribué X signalements ») et on relègue la plomberie, ou la contribution doit-elle rester plus visible ?
5. **Popup :** on le supprime carrément (le clic ouvre déjà le panneau) ou on le garde en le passant à l'i18n ?
6. **Périmètre du 1er chantier :** je recommande de commencer par **Lot 0 + Lot 1** (dette + cul-de-sac) qui livrent une vraie amélioration en peu de risque, avant d'attaquer le Lot 2. OK pour cet ordre ?
