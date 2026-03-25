"""
RateTracker — monitors action frequency and error rates.

Tracks actions per hour/day and 429/timeout errors.
Auto-stops when error thresholds are exceeded.
Inspired by V1 safety profiles.
"""

import asyncio
from collections import deque
from datetime import datetime, timezone
from typing import Literal

from backend.core.config import settings
from backend.core.logger import log
from backend.engine.pacer import isleep

# Error detection thresholds
CONSECUTIVE_ERROR_LIMIT = 8
ERROR_RATE_WINDOW = 20
ERROR_RATE_THRESHOLD = 0.6

SafetyProfile = Literal["prudent", "normal", "agressif"]

SAFETY_PROFILES: dict[str, dict] = {
    "prudent": {
        "limit_day": 160, "limit_hour": 25,
        "pause_min": 15, "pause_max": 30,
        "scan_batch": 80, "clean_batch": 160,
        "anti_bot_every": 15,
    },
    "normal": {
        "limit_day": 300, "limit_hour": 40,
        "pause_min": 8, "pause_max": 15,
        "scan_batch": 120, "clean_batch": 300,
        "anti_bot_every": 20,
    },
    "agressif": {
        "limit_day": 500, "limit_hour": 50,
        "pause_min": 5, "pause_max": 10,
        "scan_batch": 150, "clean_batch": 500,
        "anti_bot_every": 25,
    },
}


class RateTracker:
    def __init__(self, profile: SafetyProfile = "normal") -> None:
        self._profile = SAFETY_PROFILES[profile].copy()

        # Counters
        self._daily_date: str = ""
        self._daily_count: int = 0
        self._hourly_key: str = ""
        self._hourly_count: int = 0

        # Error tracking
        self._consecutive_errors: int = 0
        self._recent_results: deque[bool] = deque(maxlen=ERROR_RATE_WINDOW)

    @property
    def profile(self) -> dict:
        return self._profile

    def set_profile(self, name: SafetyProfile) -> None:
        self._profile = SAFETY_PROFILES[name].copy()
        log.info("rate", f"Safety profile: {name} "
                 f"({self._profile['limit_day']}/d, {self._profile['limit_hour']}/h)")

    def _rotate_counters(self) -> None:
        now = datetime.now(timezone.utc)
        today = now.strftime("%Y-%m-%d")
        hour = now.strftime("%Y-%m-%d-%H")

        if self._daily_date != today:
            self._daily_date = today
            self._daily_count = 0
        if self._hourly_key != hour:
            self._hourly_key = hour
            self._hourly_count = 0

    def record_action(self) -> None:
        self._rotate_counters()
        self._daily_count += 1
        self._hourly_count += 1

    def record_success(self) -> None:
        self._consecutive_errors = 0
        self._recent_results.append(True)

    def record_error(self, error_type: str = "other") -> None:
        self._consecutive_errors += 1
        self._recent_results.append(False)
        log.warning("rate", f"Error recorded: {error_type} "
                    f"(consecutive: {self._consecutive_errors})")

    def can_act(self) -> bool:
        """Check if we're within rate limits."""
        self._rotate_counters()
        if self._daily_count >= self._profile["limit_day"]:
            log.warning("rate", f"Daily limit reached "
                       f"({self._daily_count}/{self._profile['limit_day']})")
            return False
        if self._hourly_count >= self._profile["limit_hour"]:
            log.warning("rate", f"Hourly limit reached "
                       f"({self._hourly_count}/{self._profile['limit_hour']})")
            return False
        return True

    def should_stop(self) -> tuple[bool, str]:
        """Check if we should auto-stop due to error patterns."""
        if self._consecutive_errors >= CONSECUTIVE_ERROR_LIMIT:
            return True, (f"{self._consecutive_errors} consecutive errors "
                         f"— wait 15-30 min")

        if len(self._recent_results) >= ERROR_RATE_WINDOW:
            window = list(self._recent_results)
            error_rate = window.count(False) / len(window)
            if error_rate >= ERROR_RATE_THRESHOLD:
                return True, f"{error_rate:.0%} error rate — wait 15-30 min"

        return False, ""

    def seconds_until_next_hour(self) -> int:
        now = datetime.now(timezone.utc)
        return (60 - now.minute) * 60 - now.second

    async def wait_if_limited(self, stop_event: asyncio.Event) -> bool:
        """Wait until we're under rate limits. Returns False if stopped."""
        while not self.can_act():
            if stop_event.is_set():
                return False
            wait_s = self.seconds_until_next_hour()
            log.info("rate", f"Rate limited — waiting {wait_s // 60}min")
            await isleep(wait_s + 5, stop_event)
        return not stop_event.is_set()

    def stats(self) -> dict:
        self._rotate_counters()
        return {
            "actions_today": self._daily_count,
            "actions_this_hour": self._hourly_count,
            "limit_day": self._profile["limit_day"],
            "limit_hour": self._profile["limit_hour"],
            "consecutive_errors": self._consecutive_errors,
            "scan_batch": self._profile["scan_batch"],
            "clean_batch": self._profile["clean_batch"],
        }
