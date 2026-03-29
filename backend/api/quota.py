"""
Quota module — daily usage tracking and enforcement.

Free: 50 removals/day
Pro:  unlimited
"""

from datetime import datetime, timezone

from fastapi import Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.config import settings
from backend.database.models import User, UsageRecord
from backend.database.session import get_session
from backend.api.auth import get_current_user


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


async def get_usage(user_id: int, session: AsyncSession) -> UsageRecord:
    """Get or create today's usage record."""
    today = _today()
    result = await session.execute(
        select(UsageRecord).where(
            UsageRecord.user_id == user_id,
            UsageRecord.date == today,
        )
    )
    record = result.scalar_one_or_none()

    if not record:
        record = UsageRecord(user_id=user_id, date=today)
        session.add(record)
        await session.flush()

    return record


async def check_removal_quota(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> User:
    """Dependency that checks if user can perform a removal."""
    if user.plan == "pro":
        return user

    usage = await get_usage(user.id, session)
    limit = settings.free_removals_per_day

    if usage.removals >= limit:
        raise HTTPException(
            status_code=429,
            detail=f"Daily removal limit reached ({limit}). Upgrade to Pro for unlimited.",
        )
    return user


async def record_removal(user_id: int, session: AsyncSession):
    """Increment today's removal count."""
    usage = await get_usage(user_id, session)
    usage.removals += 1
    await session.commit()


async def record_scan(user_id: int, session: AsyncSession):
    """Increment today's scan count."""
    usage = await get_usage(user_id, session)
    usage.scans += 1
    await session.commit()


async def get_quota_info(user: User, session: AsyncSession) -> dict:
    """Return quota status for the user."""
    usage = await get_usage(user.id, session)
    limit = settings.free_removals_per_day if user.plan == "free" else settings.pro_removals_per_day

    return {
        "plan": user.plan,
        "removals_today": usage.removals,
        "removals_limit": limit,
        "removals_left": max(0, limit - usage.removals),
        "scans_today": usage.scans,
    }
