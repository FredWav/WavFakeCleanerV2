"""
REST API routes for the Wav Fake Cleaner V2.
"""

import asyncio
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func

from backend.core.config import settings
from backend.database.models import Follower, ActionLog, ScanSession
from backend.database.session import async_session
from backend.engine.pipeline import pipeline

router = APIRouter(prefix="/api")


# ── Request/Response models ───────────────────────────────────────────────────

class StartResponse(BaseModel):
    status: str
    message: str


class StatsResponse(BaseModel):
    total_followers: int
    pending: int
    scanned: int
    fakes: int
    removed: int
    to_review: int
    is_running: bool
    rate: dict


class SettingsUpdate(BaseModel):
    threads_username: str | None = None
    score_threshold: int | None = None
    safety_profile: Literal["prudent", "normal", "agressif"] | None = None
    headless: bool | None = None


# ── Stats ─────────────────────────────────────────────────────────────────────

@router.get("/stats", response_model=StatsResponse)
async def get_stats():
    return await pipeline.get_stats()


# ── Followers ─────────────────────────────────────────────────────────────────

@router.get("/followers")
async def list_followers(
    status: str | None = Query(None, description="Filter: pending, scanned, fake, removed"),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    async with async_session() as session:
        query = select(Follower)

        if status == "pending":
            query = query.where(Follower.scanned == False, Follower.removed == False)
        elif status == "scanned":
            query = query.where(Follower.scanned == True)
        elif status == "fake":
            query = query.where(Follower.is_fake == True, Follower.removed == False)
        elif status == "removed":
            query = query.where(Follower.removed == True)
        elif status == "review":
            query = query.where(Follower.to_review == True, Follower.removed == False)

        query = query.order_by(Follower.score.desc().nullslast())
        query = query.offset(offset).limit(limit)

        result = await session.execute(query)
        followers = result.scalars().all()

        return [
            {
                "username": f.username,
                "profile_url": f"https://www.threads.net/@{f.username}",
                "score": f.score,
                "is_fake": f.is_fake,
                "to_review": f.to_review,
                "approved": f.approved,
                "scanned": f.scanned,
                "removed": f.removed,
                "is_private": f.is_private,
                "follower_count": f.follower_count,
                "post_count": f.post_count,
                "score_breakdown": f.score_breakdown,
                "scanned_at": f.scanned_at.isoformat() if f.scanned_at else None,
                "removed_at": f.removed_at.isoformat() if f.removed_at else None,
            }
            for f in followers
        ]


# ── Actions ───────────────────────────────────────────────────────────────────

@router.post("/fetch", response_model=StartResponse)
async def start_fetch():
    if pipeline.is_running:
        raise HTTPException(400, "A task is already running")

    asyncio.create_task(pipeline.fetch())
    return StartResponse(status="started", message="Fetch started")


@router.post("/scan", response_model=StartResponse)
async def start_scan(batch_size: int | None = Query(None)):
    if pipeline.is_running:
        raise HTTPException(400, "A task is already running")

    asyncio.create_task(pipeline.scan(batch_size=batch_size))
    return StartResponse(status="started", message="Scan started")


@router.post("/clean", response_model=StartResponse)
async def start_clean(batch_size: int | None = Query(None)):
    if pipeline.is_running:
        raise HTTPException(400, "A task is already running")

    asyncio.create_task(pipeline.clean(batch_size=batch_size))
    return StartResponse(status="started", message="Clean started")


@router.post("/autopilot", response_model=StartResponse)
async def start_autopilot():
    if pipeline.is_running:
        raise HTTPException(400, "A task is already running")

    asyncio.create_task(pipeline.autopilot())
    return StartResponse(status="started", message="Autopilot started")


@router.post("/stop", response_model=StartResponse)
async def stop_pipeline():
    if not pipeline.is_running:
        return StartResponse(status="ok", message="Nothing running")

    pipeline.stop()
    return StartResponse(status="stopped", message="Stop requested")


# ── Settings ──────────────────────────────────────────────────────────────────

@router.get("/settings")
async def get_settings():
    return {
        "threads_username": settings.threads_username,
        "score_threshold": settings.score_threshold,
        "headless": settings.headless,
        "safety_profile": "normal",
        "rate": pipeline.rate_tracker.stats(),
    }


@router.post("/followers/{username}/approve", response_model=StartResponse)
async def approve_follower(username: str):
    async with async_session() as session:
        result = await session.execute(
            select(Follower).where(Follower.username == username))
        follower = result.scalar_one_or_none()
        if not follower:
            raise HTTPException(404, "Follower not found")
        follower.approved = True
        follower.to_review = False
        follower.is_fake = False
        await session.commit()
    return StartResponse(status="ok", message=f"@{username} approved")


@router.post("/followers/{username}/reject", response_model=StartResponse)
async def reject_follower(username: str):
    async with async_session() as session:
        result = await session.execute(
            select(Follower).where(Follower.username == username))
        follower = result.scalar_one_or_none()
        if not follower:
            raise HTTPException(404, "Follower not found")
        follower.approved = False
        follower.to_review = False
        follower.is_fake = True
        await session.commit()
    return StartResponse(status="ok", message=f"@{username} rejected")


@router.patch("/settings")
async def update_settings(body: SettingsUpdate):
    if body.threads_username is not None:
        settings.threads_username = body.threads_username
    if body.score_threshold is not None:
        settings.score_threshold = body.score_threshold
    if body.headless is not None:
        settings.headless = body.headless
    if body.safety_profile is not None:
        pipeline.rate_tracker.set_profile(body.safety_profile)
    return {"status": "updated"}


# ── Action logs ───────────────────────────────────────────────────────────────

@router.get("/logs")
async def get_action_logs(
    limit: int = Query(50, ge=1, le=500),
    action_type: str | None = Query(None),
):
    async with async_session() as session:
        query = select(ActionLog).order_by(ActionLog.created_at.desc())
        if action_type:
            query = query.where(ActionLog.action_type == action_type)
        query = query.limit(limit)

        result = await session.execute(query)
        logs = result.scalars().all()

        return [
            {
                "action_type": l.action_type,
                "target": l.target,
                "status": l.status,
                "error_detail": l.error_detail,
                "duration_ms": l.duration_ms,
                "created_at": l.created_at.isoformat(),
            }
            for l in logs
        ]


# ── Sessions ──────────────────────────────────────────────────────────────────

@router.get("/sessions")
async def get_sessions(limit: int = Query(10)):
    async with async_session() as session:
        result = await session.execute(
            select(ScanSession)
            .order_by(ScanSession.started_at.desc())
            .limit(limit))
        sessions = result.scalars().all()

        return [
            {
                "id": s.id,
                "status": s.status,
                "total_followers": s.total_followers,
                "scanned_count": s.scanned_count,
                "fake_count": s.fake_count,
                "removed_count": s.removed_count,
                "started_at": s.started_at.isoformat(),
                "finished_at": s.finished_at.isoformat() if s.finished_at else None,
            }
            for s in sessions
        ]
