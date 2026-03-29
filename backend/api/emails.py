"""
Email module — transactional emails via Resend or Mailgun.

Handles:
- Email verification
- Password reset
- Welcome email
"""

import httpx

from backend.core.config import settings
from backend.core.logger import log


async def send_email(to: str, subject: str, html: str):
    """Send an email via the configured provider."""
    if not settings.email_api_key:
        log.warn("email", f"No email API key configured, skipping email to {to}")
        return

    if settings.email_provider == "resend":
        await _send_resend(to, subject, html)
    elif settings.email_provider == "mailgun":
        await _send_mailgun(to, subject, html)


async def _send_resend(to: str, subject: str, html: str):
    async with httpx.AsyncClient() as client:
        res = await client.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {settings.email_api_key}"},
            json={
                "from": settings.email_from,
                "to": [to],
                "subject": subject,
                "html": html,
            },
        )
        if res.status_code >= 400:
            log.error("email", f"Resend error {res.status_code}: {res.text}")


async def _send_mailgun(to: str, subject: str, html: str):
    # Extract domain from email_from
    domain = settings.email_from.split("@")[-1].rstrip(">")
    async with httpx.AsyncClient() as client:
        res = await client.post(
            f"https://api.mailgun.net/v3/{domain}/messages",
            auth=("api", settings.email_api_key),
            data={
                "from": settings.email_from,
                "to": [to],
                "subject": subject,
                "html": html,
            },
        )
        if res.status_code >= 400:
            log.error("email", f"Mailgun error {res.status_code}: {res.text}")


# ── Email Templates ──────────────────────────────────────────────────────────

async def send_verification_email(to: str, token: str):
    url = f"{settings.email_base_url}/verify?token={token}"
    html = f"""
    <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #8b5cf6;">WavFakeCleaner</h2>
        <p>Bienvenue ! Veuillez confirmer votre adresse email en cliquant sur le bouton ci-dessous.</p>
        <a href="{url}" style="display: inline-block; padding: 12px 24px; background: #8b5cf6; color: white; text-decoration: none; border-radius: 8px; font-weight: bold;">
            Confirmer mon email
        </a>
        <p style="color: #888; font-size: 12px; margin-top: 20px;">
            Si vous n'avez pas cree de compte, ignorez cet email.
        </p>
    </div>
    """
    await send_email(to, "Confirmez votre email — WavFakeCleaner", html)


async def send_password_reset_email(to: str, token: str):
    url = f"{settings.email_base_url}/reset-password?token={token}"
    html = f"""
    <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #8b5cf6;">WavFakeCleaner</h2>
        <p>Vous avez demande une reinitialisation de mot de passe. Cliquez sur le bouton ci-dessous.</p>
        <a href="{url}" style="display: inline-block; padding: 12px 24px; background: #8b5cf6; color: white; text-decoration: none; border-radius: 8px; font-weight: bold;">
            Reinitialiser mon mot de passe
        </a>
        <p style="color: #888; font-size: 12px; margin-top: 20px;">
            Ce lien expire dans 1 heure. Si vous n'avez pas fait cette demande, ignorez cet email.
        </p>
    </div>
    """
    await send_email(to, "Reinitialisation de mot de passe — WavFakeCleaner", html)


async def send_welcome_email(to: str):
    html = f"""
    <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #8b5cf6;">Bienvenue sur WavFakeCleaner !</h2>
        <p>Votre compte est maintenant actif. Vous pouvez commencer a nettoyer vos faux followers Threads.</p>
        <p><strong>Plan gratuit :</strong> 50 suppressions par jour</p>
        <p><strong>Plan Pro :</strong> Suppressions illimitees pour 3,99 EUR/mois</p>
        <a href="{settings.email_base_url}" style="display: inline-block; padding: 12px 24px; background: #8b5cf6; color: white; text-decoration: none; border-radius: 8px; font-weight: bold;">
            Commencer
        </a>
    </div>
    """
    await send_email(to, "Bienvenue sur WavFakeCleaner !", html)
