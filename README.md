# Wav Fake Cleaner V2

> Async Threads follower cleaning engine — fully decoupled architecture.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  React SPA (Vite + Tailwind)                          │
│  ┌──────────┐ ┌────────────┐ ┌─────────────────────┐ │
│  │StatCards  │ │ControlPanel│ │   LogConsole (WS)   │ │
│  └──────────┘ └─────┬──────┘ └──────────┬──────────┘ │
│                     │ REST               │ WebSocket   │
└─────────────────────┼───────────────────┼────────────┘
                      ▼                   ▼
┌──────────────────────────────────────────────────────┐
│  FastAPI Backend                                      │
│  ┌────────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ /api/*     │  │ /ws/logs │  │  Background Tasks │  │
│  │ REST routes│  │ broadcast│  │  (asyncio.Task)   │  │
│  └─────┬──────┘  └────┬─────┘  └────────┬─────────┘  │
│        │              │                  │             │
│  ┌─────▼──────────────▼──────────────────▼──────────┐ │
│  │              Engine Layer                          │ │
│  │  ┌─────────┐ ┌───────┐ ┌───────┐ ┌───────────┐  │ │
│  │  │Fetcher  │ │Scorer │ │Cleaner│ │BrowserMgr │  │ │
│  │  │(scroll) │ │(pure) │ │(block)│ │(Playwright)│  │ │
│  │  └────┬────┘ └───────┘ └───┬───┘ └─────┬─────┘  │ │
│  │       │                    │            │         │ │
│  │  ┌────▼────────────────────▼────────────▼──────┐  │ │
│  │  │   HumanPacer (micro / macro delays)         │  │ │
│  │  └─────────────────────────────────────────────┘  │ │
│  └───────────────────────┬───────────────────────────┘ │
│                          │                              │
│  ┌───────────────────────▼───────────────────────────┐ │
│  │  SQLite (WAL) — followers + action_logs            │ │
│  └────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

## Directory Structure

```
wav-fake-cleaner-v2/
├── backend/
│   ├── core/            # Config (Pydantic), logger, singletons
│   ├── database/        # SQLAlchemy V2 models + async session
│   ├── engine/
│   │   ├── browser_manager.py   # Playwright pool + resource blocker
│   │   ├── fetcher.py           # Scroll-based follower scraping
│   │   ├── scorer.py            # Pure scoring algorithm (0-100)
│   │   ├── cleaner.py           # Remove / block execution
│   │   ├── pacer.py             # HumanPacer (organic delays)
│   │   └── selectors.yaml       # DOM selectors (hot-updatable)
│   ├── api/
│   │   ├── routes.py            # REST endpoints
│   │   └── websocket.py         # /ws/logs real-time broadcast
│   └── main.py                  # FastAPI app + lifespan
├── frontend/
│   └── src/
│       ├── components/          # StatCards, ControlPanel, LogConsole
│       ├── hooks/               # useWebSocket, useStats
│       └── lib/                 # Typed API client
├── alembic/                     # Database migrations
├── tests/                       # Unit tests (scorer, pacer)
└── pyproject.toml
```

## Quick Start

### 1. Backend

```bash
# Install Python deps
pip install -e ".[dev]"

# Install Playwright browsers
playwright install chromium

# Copy env file
cp .env.example .env
# Edit .env → set WAV_THREADS_USERNAME

# Start the API
uvicorn backend.main:app --reload --port 8000
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173**

### 3. Authentication

Before using Fetch/Scan/Clean, you need a valid Threads session:

1. Set `WAV_HEADLESS=false` in `.env`
2. Start the backend — a browser window opens
3. Manually log in to Threads
4. The session cookies are saved to `data/storage_state.json`
5. Switch back to `WAV_HEADLESS=true` for production runs

## Testing

```bash
pytest tests/ -v
```

## Scoring Algorithm (7 Steps)

Each profile starts at **0** and accumulates points. Above the threshold (**70** by default) → flagged as fake.

| Step | Signal | Points | Logic |
|------|--------|--------|-------|
| **1** | Follower count | 0=+15, 1-10=+10, 11-50=+5, 51-99=0, 100-499=-5, 500+=-10 | Low follower count = suspect |
| **2** | Posts (public) | 0=+35, 1-2=+20, 3-4=+10, 5+=-15. All recent (<72h): +20 extra | No content = very suspect |
| **2b** | Spam detection | 50%+ identical posts: cancel -15 bonus and +40. Spam keywords (WhatsApp/Telegram/phone): +25 | Catches spammers like @linaskge |
| **3** | Replies (public) | None=+25, replies+posts=-15, replies only=+10, reply spam=+10 | No interaction = suspect |
| **4** | Combos | 0 posts AND 0 replies=+20, 0 posts BUT replies=+10, 1-4 posts/0 replies/no bio=+10 | Reinforcing signals |
| **5** | Bio | Has bio=-10 (or -5 if zero activity), no bio=+15 | Personalization effort |
| **6** | Private accounts | Steps 2-4 skipped. Smart mode: <10 followers=+40, 10-30 varies by bio/pic. Strict mode: flat +10 | Two modes available |
| **7** | Full name | Has name=-5 | Minor personalization signal |

**Score clamped to [0, 100].** Each scored profile gets a `score_breakdown` JSON for full auditability.

### Real-world examples

- **Typical bot** (0 followers, 0 posts, 0 replies, no bio): 15+35+25+20+15 = **100/100**
- **Legit account** (200 followers, 10 posts, replies, bio, name): -5-15-15+0-10-5 = **0/100**
- **@linaskge spammer** (2 followers, 5+ identical posts, reply spam, WhatsApp): 10-15+80+10+0+15+0 = **100/100**

## Internationalization (i18n)

The frontend is fully bilingual **French (default) / English**. A toggle button in the header switches the UI language instantly. All labels, statuses, and console messages are translated. The preference is persisted in `localStorage`.

## Key Design Decisions

| Decision | Rationale |
|---|---|
| SQLite WAL over JSON | Concurrent reads/writes, indexed queries, crash recovery |
| selectors.yaml | Update DOM selectors without touching Python code |
| asyncio.Semaphore | Hard cap on browser contexts to prevent rate limits |
| HumanPacer | Organic delays prevent bot detection (micro + macro) |
| Pure scorer (7 steps) | Zero network deps — 100% unit-testable, full breakdown audit |
| Spam detection (step 2b) | Catches duplicate-post bots and keyword spammers |
| Smart vs strict private modes | Intelligent scoring for private accounts, or flat penalty |
| WebSocket logs | Real-time UX without polling overhead |
| storage_state persistence | No CDP port dependency, headless-compatible |
| Resource interception | Block images/fonts/media for 3-5× speed gain |
| Bilingual FR/EN | French default with instant toggle, zero-reload |
