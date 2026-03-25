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


settings = Settings()
DATA_DIR.mkdir(exist_ok=True)
