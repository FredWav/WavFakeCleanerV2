"""
HumanPacer — organic, randomized delays to mimic human browsing.

Uses weighted probability distribution:
- 70% short pauses (quick successive actions)
- 20% medium pauses (reading/thinking)
- 10% long pauses (distracted, phone down)
- Session fatigue: after a burst of actions, takes a big break
"""

import asyncio
import random

from backend.core.logger import log


class HumanPacer:
    def __init__(self, base_min: float = 4, base_max: float = 8) -> None:
        self.base_min = base_min
        self.base_max = base_max
        self._action_count = 0
        self._session_length = random.randint(12, 25)

    @property
    def action_count(self) -> int:
        return self._action_count

    def next_pause(self) -> float:
        """Return next pause duration for clean/heavy actions."""
        self._action_count += 1

        # Session fatigue: after a burst, big break (90-300s)
        if self._action_count >= self._session_length:
            self._action_count = 0
            self._session_length = random.randint(10, 25)
            delay = random.uniform(90, 300)
            log.info("pacer", f"Session break: {delay:.0f}s")
            return delay

        roll = random.random()
        if roll < 0.70:
            # Short pause: quick action
            return random.uniform(self.base_min * 0.5, self.base_max * 0.7)
        elif roll < 0.90:
            # Medium pause: reading a profile
            return random.uniform(self.base_max * 0.8, self.base_max * 1.8)
        else:
            # Long pause: human distraction
            return random.uniform(self.base_max * 2, self.base_max * 4)

    def next_scan_pause(self) -> float:
        """8-15s base pauses for scanning, with human variation."""
        self._action_count += 1

        if self._action_count >= self._session_length:
            self._action_count = 0
            self._session_length = random.randint(8, 18)
            delay = random.uniform(120, 240)
            log.info("pacer", f"Scan session break: {delay:.0f}s")
            return delay

        roll = random.random()
        if roll < 0.65:
            # Normal pace: 8-12s
            return random.uniform(8, 12)
        elif roll < 0.88:
            # Slower: reading the profile (12-18s)
            return random.uniform(12, 18)
        else:
            # Human distraction (20-35s)
            return random.uniform(20, 35)


async def isleep(seconds: float, stop_event: asyncio.Event, step: float = 0.2) -> None:
    """Interruptible async sleep — returns early if stop_event is set."""
    elapsed = 0.0
    while elapsed < seconds:
        if stop_event.is_set():
            return
        chunk = min(step, seconds - elapsed)
        await asyncio.sleep(chunk)
        elapsed += chunk
