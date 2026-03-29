"""
Billing module — Stripe Checkout + webhook handling.

Flow:
1. User clicks "Upgrade" → POST /api/billing/checkout → returns Stripe Checkout URL
2. User pays on Stripe → Stripe sends webhook → POST /api/billing/webhook
3. Webhook updates user plan to "pro"
4. On cancellation, webhook downgrades to "free"
"""

import stripe
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.config import settings
from backend.database.models import User
from backend.database.session import get_session
from backend.api.auth import get_current_user

router = APIRouter(prefix="/api/billing", tags=["billing"])


def _init_stripe():
    stripe.api_key = settings.stripe_secret_key


# ── Create Checkout Session ──────────────────────────────────────────────────

@router.post("/checkout")
async def create_checkout(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    _init_stripe()

    if not settings.stripe_secret_key:
        raise HTTPException(status_code=503, detail="Stripe not configured")

    if user.plan == "pro":
        raise HTTPException(status_code=400, detail="Already on Pro plan")

    # Create or reuse Stripe customer
    if not user.stripe_customer_id:
        customer = stripe.Customer.create(email=user.email)
        user.stripe_customer_id = customer.id
        await session.commit()

    checkout = stripe.checkout.Session.create(
        customer=user.stripe_customer_id,
        mode="subscription",
        line_items=[{"price": settings.stripe_price_id, "quantity": 1}],
        success_url=f"{settings.email_base_url}/billing/success?session_id={{CHECKOUT_SESSION_ID}}",
        cancel_url=f"{settings.email_base_url}/billing/cancel",
        metadata={"user_id": str(user.id)},
    )

    return {"url": checkout.url}


# ── Customer Portal (manage subscription) ───────────────────────────────────

@router.post("/portal")
async def create_portal(user: User = Depends(get_current_user)):
    _init_stripe()

    if not user.stripe_customer_id:
        raise HTTPException(status_code=400, detail="No active subscription")

    portal = stripe.billing_portal.Session.create(
        customer=user.stripe_customer_id,
        return_url=f"{settings.email_base_url}/settings",
    )
    return {"url": portal.url}


# ── Stripe Webhook ───────────────────────────────────────────────────────────

@router.post("/webhook")
async def stripe_webhook(
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    _init_stripe()
    payload = await request.body()
    sig = request.headers.get("stripe-signature", "")

    try:
        event = stripe.Webhook.construct_event(
            payload, sig, settings.stripe_webhook_secret,
        )
    except (ValueError, stripe.error.SignatureVerificationError):
        raise HTTPException(status_code=400, detail="Invalid webhook signature")

    event_type = event["type"]
    data = event["data"]["object"]

    if event_type == "checkout.session.completed":
        await _handle_checkout_completed(data, session)
    elif event_type in (
        "customer.subscription.updated",
        "customer.subscription.deleted",
    ):
        await _handle_subscription_change(data, session)
    elif event_type == "invoice.payment_failed":
        await _handle_payment_failed(data, session)

    return {"status": "ok"}


async def _handle_checkout_completed(data: dict, session: AsyncSession):
    customer_id = data.get("customer")
    subscription_id = data.get("subscription")

    result = await session.execute(
        select(User).where(User.stripe_customer_id == customer_id)
    )
    user = result.scalar_one_or_none()
    if not user:
        return

    user.plan = "pro"
    user.stripe_subscription_id = subscription_id
    user.subscription_status = "active"
    await session.commit()


async def _handle_subscription_change(data: dict, session: AsyncSession):
    customer_id = data.get("customer")
    status = data.get("status")

    result = await session.execute(
        select(User).where(User.stripe_customer_id == customer_id)
    )
    user = result.scalar_one_or_none()
    if not user:
        return

    user.subscription_status = status
    user.stripe_subscription_id = data.get("id")

    if status in ("canceled", "unpaid", "incomplete_expired"):
        user.plan = "free"
    elif status == "active":
        user.plan = "pro"

    await session.commit()


async def _handle_payment_failed(data: dict, session: AsyncSession):
    customer_id = data.get("customer")

    result = await session.execute(
        select(User).where(User.stripe_customer_id == customer_id)
    )
    user = result.scalar_one_or_none()
    if not user:
        return

    user.subscription_status = "past_due"
    await session.commit()
