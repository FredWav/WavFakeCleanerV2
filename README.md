# WavFakeCleaner V2

Nettoyeur intelligent de faux followers Threads — extension navigateur + backend SaaS.

## Architecture

```
wavfakecleanerv2/
├── extension/          # Extension navigateur (Chrome, Firefox, Safari)
│   ├── background/     # Service worker, scorer, pacer, quota
│   ├── content/        # Content script (injection threads.net)
│   ├── popup/          # Popup UI (dashboard, login, settings)
│   └── build.js        # Multi-browser build system
├── backend/            # FastAPI backend
│   ├── api/            # Routes REST + SaaS (auth, billing, quota, emails)
│   ├── core/           # Config, logger
│   ├── database/       # SQLAlchemy models + session
│   └── engine/         # Scorer, pipeline, pacer, browser manager
├── frontend/           # React dashboard (legacy, standalone mode)
├── landing/            # Landing page statique
├── tests/              # Tests unitaires
└── docker-compose.yml  # Deploiement Docker
```

## Fonctionnalites

- **Algorithme de scoring en 9 etapes** : username patterns, followers, posts, replies, bio, photo de profil, liens, compte prive, ratio
- **Pre-scoring instantane** : trie les profils evidents sans visiter leur page
- **Anti-blocage** : delais humains 8-15s, navigation aleatoire, micro-batches de 12, detection de blocage, cooldown 2h
- **Mode Autopilot** : fetch → scan → clean en boucle automatique
- **SaaS** : inscription, plan gratuit (50 suppressions/jour), Pro (3,99 EUR/mois illimite)
- **RGPD** : consentement promo, suppression de compte, export de donnees, traitement 100% local
- **Multi-navigateur** : Chrome, Firefox, Safari, Edge, Opera, Brave, Comet

## Installation rapide

### Methode 1 : Extension navigateur (recommande)

1. Cloner le repo et builder l'extension :
```bash
git clone https://github.com/FredWav/WavFakeCleanerV2.git
cd WavFakeCleanerV2/extension
node build.js
```

2. Charger l'extension dans votre navigateur :
   - **Chrome** : `chrome://extensions` → Mode developpeur → Charger non empaquetee → `extension/dist/chromium`
   - **Firefox** : `about:debugging` → Charger un module temporaire → `extension/dist/firefox/manifest.json`
   - **Safari** : `xcrun safari-web-extension-converter extension/dist/safari`

### Methode 2 : Mode standalone (avec Playwright)

```bash
# Windows
setup.bat
start.bat

# macOS / Linux
chmod +x setup.sh start.sh
./setup.sh
./start.sh
```

### Methode 3 : Docker

```bash
cp .env.example .env
# Editer .env avec vos cles
docker compose up -d
```

## Configuration

Copier `.env.example` en `.env` et remplir les valeurs :

| Variable | Description | Requis |
|----------|-------------|--------|
| `WAV_THREADS_USERNAME` | Votre username Threads | Mode standalone |
| `WAV_JWT_SECRET` | Secret JWT (generer avec `python -c "import secrets; print(secrets.token_hex(32))"`) | SaaS |
| `WAV_STRIPE_SECRET_KEY` | Cle secrete Stripe | Billing |
| `WAV_STRIPE_WEBHOOK_SECRET` | Secret webhook Stripe | Billing |
| `WAV_STRIPE_PRICE_ID` | Price ID du plan Pro | Billing |
| `WAV_EMAIL_API_KEY` | Cle API Resend ou Mailgun | Emails |

## API Endpoints

### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/register` | Inscription |
| POST | `/api/login` | Connexion |
| GET | `/api/verify?token=...` | Verification email |
| POST | `/api/forgot-password` | Mot de passe oublie |
| POST | `/api/reset-password` | Reset mot de passe |
| GET | `/api/me` | Info utilisateur + quota |

### RGPD
| Method | Endpoint | Description |
|--------|----------|-------------|
| PATCH | `/api/promo-consent` | Modifier consentement promo |
| DELETE | `/api/delete-account` | Supprimer compte + donnees |
| GET | `/api/export-data` | Exporter ses donnees |

### Billing
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/billing/checkout` | Creer session Stripe |
| POST | `/api/billing/portal` | Portail client Stripe |
| POST | `/api/billing/webhook` | Webhook Stripe |

### Pipeline (mode standalone)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| POST | `/api/scan/start` | Lancer le scan |
| POST | `/api/scan/stop` | Arreter le scan |
| GET | `/api/followers` | Liste des followers |
| GET | `/api/stats` | Statistiques |

## Tests

```bash
# Python
pip install pytest
pytest tests/

# JavaScript (scorer)
node tests/test_scorer.js
```

## Build de l'extension

```bash
cd extension

# Tous les navigateurs
node build.js

# Un seul navigateur
node build.js chromium
node build.js firefox
node build.js safari

# Avec archives ZIP
node build.js --zip
```

## Stack technique

- **Backend** : FastAPI, SQLAlchemy (async), SQLite WAL, Alembic
- **Auth** : JWT (PyJWT) + bcrypt
- **Billing** : Stripe Checkout + Webhooks
- **Emails** : Resend / Mailgun
- **Extension** : Manifest V3, ES Modules, chrome.storage
- **Frontend** : React + Vite + Tailwind CSS
- **Landing** : HTML/CSS statique
- **Deploy** : Docker + docker-compose

## Licence

Proprietary — by Fred Wav.
