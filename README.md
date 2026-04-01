# Wav Fake Cleaner V2

Extension Chrome/Edge pour detecter et supprimer les faux followers de ton compte Threads.

## Fonctionnalites

- Recuperation automatique de ta liste de followers via l'API Threads
- Analyse intelligente en 14 signaux (0 posts, 0 reponses, spam, doublons, etc.)
- Suppression automatique des faux followers detectes
- Mode autopilote : fait tout en arriere-plan
- Interface temps reel dans le panneau lateral du navigateur
- Profils de vitesse : Gratuit / Prudent / Normal / Agressif
- Bilingue francais/anglais

## Installation

### Depuis le Chrome Web Store

*(bientot disponible)*

### Installation manuelle (developpement)

```bash
npm install
npm run build
```

1. Ouvre `chrome://extensions/`
2. Active le "Mode developpeur"
3. Clique "Charger l'extension non empaquetee"
4. Selectionne le dossier `dist/`

## Utilisation

1. Ouvre Threads dans ton navigateur
2. Clique sur l'icone de l'extension pour ouvrir le panneau lateral
3. Entre ton nom d'utilisateur dans les parametres
4. Clique "Recuperer" pour charger tes followers
5. Clique "Analyser" pour detecter les fakes
6. Clique "Supprimer" pour nettoyer

Ou utilise le mode **Autopilote** qui fait tout automatiquement.

## Licence

- **Gratuit** : 200 analyses/jour, 50 suppressions/jour
- **Licence (7,99 EUR)** : limites etendues + profils de vitesse avances

## Structure

```
src/
├── background/    # Service worker, pipeline, scoring, stockage
├── content/       # Content scripts (scraping DOM, API bridge)
├── sidepanel/     # Interface React (panneau lateral)
├── popup/         # Popup de l'extension
├── offscreen/     # Document offscreen (keepalive)
└── shared/        # Types, constantes, messages partages
```

## Build

```bash
npm install        # installer les dependances
npm run build      # build production → dist/
npm run dev        # build en mode watch (developpement)
```

## Auteur

[Fred Wav](https://www.threads.net/@fredwavoff)
