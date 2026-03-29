from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT_DIR = Path(__file__).resolve().parent.parent.parent
DATA_DIR = ROOT_DIR / "data"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(ROOT_DIR / ".env"),
        env_prefix="WAV_",
        extra="ignore",
    )

    threads_username: str = "your_username_here"
    headless: bool = True
    max_browser_contexts: int = 3
    score_threshold: int = 70
    actions_before_macro: int = 25
    api_port: int = 8000

    # Rate limit defaults (auto-adjusted by RateTracker)
    max_actions_per_hour: int = 120
    max_actions_per_day: int = 800

    # Pacer delays (seconds)
    micro_delay_min: float = 1.5
    micro_delay_max: float = 4.0
    macro_delay_min: float = 30.0
    macro_delay_max: float = 90.0

    # Database
    db_path: str = str(DATA_DIR / "wav.db")

    # Storage state
    storage_state_path: str = str(DATA_DIR / "storage_state.json")

    # ── SaaS Settings ──────────────────────────────────────
    # JWT
    jwt_secret: str = "CHANGE-ME-in-production-use-openssl-rand-hex-32"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60 * 24 * 7  # 7 days

    # Stripe
    stripe_secret_key: str = ""
    stripe_webhook_secret: str = ""
    stripe_price_id: str = ""  # Pro plan price ID from Stripe dashboard

    # Email (Resend or Mailgun)
    email_provider: str = "resend"  # resend | mailgun
    email_api_key: str = ""
    email_from: str = "WavFakeCleaner <noreply@wavfakecleaner.com>"
    email_base_url: str = "https://wavfakecleaner.com"

    # Quotas
    free_removals_per_day: int = 50
    pro_removals_per_day: int = 999999  # unlimited


settings = Settings()
DATA_DIR.mkdir(exist_ok=True)
