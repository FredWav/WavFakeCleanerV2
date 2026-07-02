# Mission : revue d'architecture globale + plan de restructuration UX/UI — Wav Fake Cleaner V3

## Ton rôle
Tu es à la fois architecte logiciel senior et designer produit exigeant. Tu audites une extension de navigateur existante et tu produis un plan de restructuration. **Tu ne modifies aucun code dans cette mission** : le livrable est un audit + un plan par lots, que je validerai avant toute implémentation.

## Le produit
**Wav Fake Cleaner** (WFC), extension Chrome MV3 qui détecte et supprime les faux followers sur Threads.
- Cible : créateurs de contenu **non techniques**. La personne qui l'utilise ne sait pas ce qu'est un "pipeline", un "seuil de scoring" ou un "rate limit". Elle veut : *« montre-moi mes faux followers, supprime-les, sans risque pour mon compte »*.
- Positionnement voulu : **premium, épuré, simple**. L'utilisateur paie 7,99 € ; l'interface doit inspirer autant confiance qu'un produit Apple ou Linear, pas qu'un outil de growth-hacking.

## Architecture actuelle (résumé factuel — vérifie tout dans le code)
- **Stack** : React 19 + TypeScript + Tailwind v4 (tokens dans `src/sidepanel/styles/globals.css`), Vite + esbuild, Vitest.
- **Surfaces UI** :
  - Sidepanel principal (`src/sidepanel/App.tsx`, 3 onglets cleanup/results/community) avec : StatCards (6 métriques), ControlPanel (513 l — boutons Fetch/Analyze/Clean/Continu, bannières, countdown), FollowerTable (678 l — tableau + checkboxes + lookup communautaire), LicencePanel (398 l), CommunityCard, SettingsPanel, LogConsole (console de logs temps réel), Onboarding (68 l).
  - Popup minimal (`src/popup/popup.tsx`) : ouvrir le panel / ouvrir Threads.
- **Moteur** : service worker (`src/background/`, ~5,1k lignes) orchestrant Fetch → Score (8 signaux, seuil 70) → Clean, avec humanisation des délais, backoff 429, pauses de session obligatoires. Content scripts (`src/content/`, ~2,5k lignes) : scraping DOM + bridge main-world vers l'API Threads.
- **Backend** : Worker Cloudflare (vérif licence Stripe Ed25519, votes communautaires anonymisés SHA-256, stats, télémétrie opt-in). Stockage local : IndexedDB + chrome.storage.
- **Design actuel** : fond encre #0c0a12, accent ambre #F5A524, secondaire violet #7c3aed, police Satoshi.

## Ta mission en trois volets

### Volet 1 — Audit sans complaisance
Parcours le code réel et évalue :
1. **Le parcours utilisateur de bout en bout** : premier lancement → onboarding → fetch → analyse → revue des résultats → suppression → mode continu. Où un débutant se perd-il ? Combien de décisions techniques lui impose-t-on (seuils, boutons multiples, onglets) qui devraient être des choix par défaut intelligents ?
2. **La hiérarchie de l'information** : 6 stat-cards, un tableau dense, une console de logs, des bannières — qu'est-ce qui mérite vraiment l'attention de l'utilisateur, qu'est-ce qui est du bruit d'ingénieur exposé en façade ?
3. **L'architecture des surfaces** : la répartition popup / sidepanel / onglets est-elle la bonne ? Le sidepanel 3-onglets est-il le meilleur véhicule pour ce produit, ou une autre structure (écran unique guidé, wizard, page dédiée) servirait-elle mieux la simplicité ?
4. **L'architecture des composants** : FollowerTable (678 l) et ControlPanel (513 l) concentrent trop de responsabilités — état de sélection, logique pipeline, affichage. Identifie les découpages, les duplications (ex. pré-score métadonnées vs scorer complet), le code de diagnostic temporaire à purger (`api-interceptor.ts`).
5. **La direction visuelle** : le trio encre/ambre/violet + Satoshi est **rediscutable**. Évalue-le honnêtement à l'aune de "premium et épuré" : garde, ajuste ou remplace, mais justifie. Un seul accent fort vaut peut-être mieux que deux.
6. **La cohérence des messages et du vocabulaire** (i18n FR/EN/ES) : le produit parle-t-il utilisateur ("faux followers trouvés") ou machine ("pipeline state", "429 backoff") ?

### Volet 2 — Vision cible
Propose UNE direction claire (pas un catalogue d'options) :
- Le parcours idéal en 3 gestes maximum pour l'utilisateur lambda : *connecter → analyser → nettoyer*, avec les réglages avancés relégués derrière un "mode expert" ou des valeurs par défaut sûres.
- La structure d'écrans cible (wireframes en ASCII ou description précise écran par écran), l'état vide, l'état en cours, l'état résultats, les états d'erreur (429, licence expirée, compte privé).
- La direction visuelle cible : palette, typographie, densité, animations — avec la justification "premium/épuré" pour chaque choix.
- Ce qui disparaît de l'interface (et où ça va : supprimé, replié, ou automatisé).

### Volet 3 — Plan de restructuration par lots
Découpe la migration en **lots indépendants, valables et testables un par un**, ordonnés du plus structurant au plus cosmétique. Pour chaque lot : objectif, fichiers touchés, risques de régression, critère de validation manuel (que dois-je voir dans l'extension pour dire "ok"). Aucune régression fonctionnelle tolérée sur : le pipeline de scan, la protection anti-429/humanisation, la licence Stripe/Ed25519, les votes communautaires.

## Contraintes non négociables
- **Le moteur reste** : pipeline, scorer, humanisation, rate-limiting, Worker Cloudflare et le modèle de licence ne changent pas fonctionnellement. La restructuration porte sur l'UX, l'UI et l'organisation du code qui les sert.
- **Simplicité radicale** : chaque élément d'interface conservé doit justifier sa présence pour un utilisateur non technique. En cas de doute, il dégage ou passe en mode expert.
- **Pas de dépendance UI lourde** : rester sur React + Tailwind + composants maison.
- **i18n conservée** (FR/EN/ES), le français est la langue de référence.
- Réponds et documente **en français**.

## Format de sortie attendu
1. Synthèse exécutive (10 lignes max) : les 3 problèmes majeurs et la direction proposée.
2. Audit détaillé (volet 1), chaque constat appuyé par un chemin de fichier précis.
3. Vision cible (volet 2) avec wireframes.
4. Plan par lots (volet 3).
5. Questions ouvertes qui nécessitent mon arbitrage, s'il en reste.

Ne commence l'implémentation d'aucun lot : attends ma validation explicite du plan.
