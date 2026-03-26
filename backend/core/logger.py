import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

# Connected WebSocket clients
_ws_clients: set = set()
_log_queue: asyncio.Queue | None = None


def get_log_queue() -> asyncio.Queue:
    global _log_queue
    if _log_queue is None:
        _log_queue = asyncio.Queue(maxsize=500)
    return _log_queue


def register_ws(ws: Any) -> None:
    _ws_clients.add(ws)


def unregister_ws(ws: Any) -> None:
    _ws_clients.discard(ws)


def get_ws_clients() -> set:
    return _ws_clients


# Structured log entry
def _make_entry(level: str, category: str, message: str, **extra: Any) -> dict:
    return {
        "ts": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "category": category,
        "message": message,
        **extra,
    }


class WavLogger:
    """Logger that writes to both stdlib logging and WebSocket broadcast queue."""

    def __init__(self, name: str = "wav"):
        self._logger = logging.getLogger(name)
        if not self._logger.handlers:
            handler = logging.StreamHandler()
            handler.setFormatter(
                logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", datefmt="%H:%M:%S")
            )
            self._logger.addHandler(handler)
            self._logger.setLevel(logging.DEBUG)

    def _emit(self, level: str, category: str, message: str, **extra: Any) -> dict:
        entry = _make_entry(level, category, message, **extra)
        getattr(self._logger, level.lower(), self._logger.info)(f"[{category}] {message}")
        try:
            queue = get_log_queue()
            queue.put_nowait(entry)
        except asyncio.QueueFull:
            pass  # drop oldest-style: caller can handle
        return entry

    def info(self, category: str, message: str, **extra: Any) -> dict:
        return self._emit("INFO", category, message, **extra)

    def warning(self, category: str, message: str, **extra: Any) -> dict:
        return self._emit("WARNING", category, message, **extra)

    def error(self, category: str, message: str, **extra: Any) -> dict:
        return self._emit("ERROR", category, message, **extra)

    def debug(self, category: str, message: str, **extra: Any) -> dict:
        return self._emit("DEBUG", category, message, **extra)


log = WavLogger()
