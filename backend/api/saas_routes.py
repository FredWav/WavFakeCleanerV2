"""
SaaS API routes — auth, user management, quota info.

These routes serve the browser extension (and landing page).
All prefixed with /api/.
"""

import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database.models import User, UsageRecord, Follower, ActionLog
from backend.database.session import get_session
from backend.api.auth import (
    create_token,
    generate_verification_token,
    get_current_user,
    hash_password,
    verify_password,
)
from backend.api.emails import (
    send_password_reset_email,
    send_verification_email,
    send_welcome_email,
)
from backend.api.quota import get_quota_info

router = APIRouter(prefix="/api", tags=["saas"])


# ── Rate Limiter (in-memory, per IP) ────────────────────────────────────────

_rate_store: dict[str, list[float]] = defaultdict(list)
RATE_LIMIT_WINDOW = 300   # 5 minutes
RATE_LIMIT_MAX = 10       # max attempts per window


def _check_rate_limit(request: Request):
    ip = request.client.host if request.client else "unknown"
    now = time.time()
    # Prune old entries
    _rate_store[ip] = [t for t in _rate_store[ip] if now - t < RATE_LIMIT_WINDOW]
    if len(_rate_store[ip]) >= RATE_LIMIT_MAX:
        raise HTTPException(
            status_code=429,
            detail="Too many requests. Please try again later.",
        )
    _rate_store[ip].append(now)


# ── Schemas ──────────────────────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    email: EmailStr
    password: str
    promo_consent: bool = False


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str
    password: str


class AuthResponse(BaseModel):
    token: str
    email: str
    plan: str


class MeResponse(BaseModel):
    id: int
    email: str
    plan: str
    email_verified: bool
    promo_consent: bool
    removals_today: int
    removals_limit: int
    removals_left: int
    scans_today: int


# ── Register ─────────────────────────────────────────────────────────────────

@router.post("/register", response_model=AuthResponse)
async def register(request: Request, body: RegisterRequest, session: AsyncSession = Depends(get_session)):
    _check_rate_limit(request)
    if len(body.password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")

    existing = await session.execute(select(User).where(User.email == body.email))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Email already registered")

    verification_token = generate_verification_token()

    user = User(
        email=body.email,
        password_hash=hash_password(body.password),
        promo_consent=body.promo_consent,
        email_verification_token=verification_token,
    )
    session.add(user)
    await session.commit()
    await session.refresh(user)

    # Send verification email (fire & forget)
    try:
        await send_verification_email(body.email, verification_token)
    except Exception:
        pass

    token = create_token(user.id, user.email, user.plan)
    return AuthResponse(token=token, email=user.email, plan=user.plan)


# ── Login ────────────────────────────────────────────────────────────────────

@router.post("/login", response_model=AuthResponse)
async def login(request: Request, body: LoginRequest, session: AsyncSession = Depends(get_session)):
    _check_rate_limit(request)
    result = await session.execute(select(User).where(User.email == body.email))
    user = result.scalar_one_or_none()

    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account deactivated")

    token = create_token(user.id, user.email, user.plan)
    return AuthResponse(token=token, email=user.email, plan=user.plan)


# ── Email Verification ──────────────────────────────────────────────────────

@router.get("/verify")
async def verify_email(token: str, session: AsyncSession = Depends(get_session)):
    result = await session.execute(
        select(User).where(User.email_verification_token == token)
    )
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(status_code=400, detail="Invalid verification token")

    user.email_verified = True
    user.email_verification_token = None
    await session.commit()

    # Send welcome email
    try:
        await send_welcome_email(user.email)
    except Exception:
        pass

    return {"status": "ok", "message": "Email verified"}


# ── Forgot Password ─────────────────────────────────────────────────────────

@router.post("/forgot-password")
async def forgot_password(request: Request, body: ForgotPasswordRequest, session: AsyncSession = Depends(get_session)):
    _check_rate_limit(request)
    result = await session.execute(select(User).where(User.email == body.email))
    user = result.scalar_one_or_none()

    # Always return success (don't leak email existence)
    if not user:
        return {"status": "ok"}

    token = generate_verification_token()
    user.password_reset_token = token
    user.password_reset_expires = datetime.now(timezone.utc) + timedelta(hours=1)
    await session.commit()

    try:
        await send_password_reset_email(user.email, token)
    except Exception:
        pass

    return {"status": "ok"}


# ── Reset Password ──────────────────────────────────────────────────────────

@router.post("/reset-password")
async def reset_password(body: ResetPasswordRequest, session: AsyncSession = Depends(get_session)):
    if len(body.password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")

    result = await session.execute(
        select(User).where(User.password_reset_token == body.token)
    )
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(status_code=400, detail="Invalid reset token")

    if user.password_reset_expires and user.password_reset_expires < datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="Reset token expired")

    user.password_hash = hash_password(body.password)
    user.password_reset_token = None
    user.password_reset_expires = None
    await session.commit()

    return {"status": "ok"}


# ── Me (current user info + quota) ──────────────────────────────────────────

@router.get("/me", response_model=MeResponse)
async def get_me(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    quota = await get_quota_info(user, session)
    return MeResponse(
        id=user.id,
        email=user.email,
        plan=user.plan,
        email_verified=user.email_verified,
        promo_consent=user.promo_consent,
        removals_today=quota["removals_today"],
        removals_limit=quota["removals_limit"],
        removals_left=quota["removals_left"],
        scans_today=quota["scans_today"],
    )


# ── Usage Report (from extension) ───────────────────────────────────────────

class UsageReportRequest(BaseModel):
    action: str  # "removal" | "scan"
    date: str


@router.post("/usage")
async def report_usage(
    body: UsageReportRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    from backend.api.quota import record_removal, record_scan

    if body.action == "removal":
        await record_removal(user.id, session)
    elif body.action == "scan":
        await record_scan(user.id, session)

    return {"status": "ok"}


# ── Update Promo Consent (RGPD) ─────────────────────────────────────────────

class PromoConsentRequest(BaseModel):
    consent: bool


@router.patch("/promo-consent")
async def update_promo_consent(
    body: PromoConsentRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    user.promo_consent = body.consent
    await session.commit()
    return {"status": "ok", "promo_consent": user.promo_consent}


# ── Delete Account (RGPD) ───────────────────────────────────────────────────

class DeleteAccountRequest(BaseModel):
    password: str


@router.delete("/delete-account")
async def delete_account(
    body: DeleteAccountRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    if not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid password")

    # Cancel Stripe subscription if active
    if user.stripe_subscription_id:
        try:
            import stripe
            from backend.core.config import settings as cfg
            stripe.api_key = cfg.stripe_secret_key
            if cfg.stripe_secret_key:
                stripe.Subscription.cancel(user.stripe_subscription_id)
        except Exception:
            pass

    # Delete all user data
    await session.execute(delete(UsageRecord).where(UsageRecord.user_id == user.id))
    await session.execute(delete(Follower).where(Follower.user_id == user.id))
    await session.execute(delete(ActionLog).where(ActionLog.user_id == user.id))
    await session.execute(delete(User).where(User.id == user.id))
    await session.commit()

    return {"status": "ok", "message": "Account and all data deleted"}


# ── Export Data (RGPD) ──────────────────────────────────────────────────────

@router.get("/export-data")
async def export_data(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    quota = await get_quota_info(user, session)

    return {
        "user": {
            "id": user.id,
            "email": user.email,
            "plan": user.plan,
            "email_verified": user.email_verified,
            "promo_consent": user.promo_consent,
            "created_at": user.created_at.isoformat() if user.created_at else None,
        },
        "usage": quota,
    }
