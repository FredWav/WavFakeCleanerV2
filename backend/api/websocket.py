"""
WebSocket endpoint for real-time log broadcasting.
"""

import asyncio
import json

from fastapi import WebSocket, WebSocketDisconnect

from backend.core.logger import get_log_queue, register_ws, unregister_ws


async def ws_logs(websocket: WebSocket) -> None:
    """WebSocket endpoint that streams log entries in real-time."""
    await websocket.accept()
    register_ws(websocket)

    queue = get_log_queue()

    try:
        while True:
            try:
                entry = await asyncio.wait_for(queue.get(), timeout=30.0)
                await websocket.send_text(json.dumps(entry))
            except asyncio.TimeoutError:
                # Send keepalive ping
                await websocket.send_text(json.dumps({"type": "ping"}))
            except Exception:
                break
    except WebSocketDisconnect:
        pass
    finally:
        unregister_ws(websocket)
