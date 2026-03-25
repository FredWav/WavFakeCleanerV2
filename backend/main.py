"""
FastAPI app — main entry point for Wav Fake Cleaner V2.
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from pathlib import Path

from backend.api.routes import router
from backend.api.websocket import ws_logs
from backend.core.config import settings
from backend.core.logger import log
from backend.database.session import init_db
from backend.engine.browser_manager import browser_manager


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown lifecycle."""
    # Startup
    log.info("app", "Wav Fake Cleaner V2 starting...")
    await init_db()
    log.info("app", "Database initialized")

    await browser_manager.start()
    log.info("app", f"Ready — http://localhost:{settings.api_port}")

    yield

    # Shutdown
    log.info("app", "Shutting down...")
    await browser_manager.stop()


app = FastAPI(
    title="Wav Fake Cleaner V2",
    version="2.0.0",
    lifespan=lifespan,
)

# API routes
app.include_router(router)

# WebSocket
app.add_api_websocket_route("/ws/logs", ws_logs)

# Serve frontend static files (production)
frontend_dist = Path(__file__).parent.parent / "frontend" / "dist"
if frontend_dist.exists():
    app.mount("/", StaticFiles(directory=str(frontend_dist), html=True))
