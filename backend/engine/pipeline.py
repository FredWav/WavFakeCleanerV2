"""
Pipeline — orchestrates the full Fetch → Score → Clean automation.

Runs as an asyncio background task. Supports:
- One-shot mode (fetch/scan/clean individually)
- Autopilot mode (continuous loop until done)
"""

import asyncio
import json
import random
import time
from datetime import datetime, timezone

from sqlalchemy import select, update, func

from backend.core.config import settings
from backend.core.logger import log
from backend.database.models import Follower, ActionLog, ScanSession
from backend.database.session import async_session
from backend.engine.browser_manager import browser_manager
from backend.engine.cleaner import click_three_dots, click_remove_follower, click_confirm
from backend.engine.fetcher import (
    fetch_via_api, fetch_via_scroll, navigate_to_profile, RateLimitError,
)
from backend.engine.pacer import HumanPacer, isleep
from backend.engine.rate_tracker import RateTracker
from backend.engine.scorer import extract_profile, score_profile, ProfileData

# Autopilot constants
AUTOPILOT_SCAN_BATCH = (120, 150)
AUTOPILOT_CLEAN_BATCH = (18, 30)
AUTOPILOT_PAUSE_BETWEEN = (300, 900)      # 5-15 min between phases
AUTOPILOT_PAUSE_SCAN = (900, 1500)        # 15-25 min
AUTOPILOT_PAUSE_CLEAN = (1500, 2100)      # 25-35 min
AUTOPILOT_COOLDOWN_ON_ERR = (600, 1200)   # 10-20 min
AUTOPILOT_FETCH_INTERVAL_H = 5


class Pipeline:
    def __init__(self) -> None:
        self.stop_event = asyncio.Event()
        self.rate_tracker = RateTracker()
        self._session_id: int | None = None
        self._running = False

    @property
    def is_running(self) -> bool:
        return self._running

    def stop(self) -> None:
        self.stop_event.set()

    # ── Fetch phase ───────────────────────────────────────────────────────

    async def fetch(self) -> dict:
        """Fetch followers list and save to DB."""
        self._running = True
        self.stop_event.clear()
        username = settings.threads_username

        log.info("pipeline", f"Fetching followers for @{username}")
        stats = {"collected": 0, "new": 0, "refollows": 0}

        try:
            ctx, page = await browser_manager.new_page(block_resources=False)
            try:
                # Navigate to profile first
                if not await navigate_to_profile(page, username):
                    log.error("pipeline", "Could not navigate to profile")
                    return stats

                # Try API first
                collected = await fetch_via_api(
                    page, username, self.stop_event,
                    on_page=lambda p, t: log.info(
                        "fetch", f"API page {p}: {t} total"),
                )

                if collected is None:
                    # Fallback to scroll
                    log.info("pipeline", "API unavailable, falling back to scroll")
                    pseudos = await fetch_via_scroll(
                        page, username, self.stop_event,
                        on_progress=lambda n: log.info(
                            "fetch", f"{n} profiles loaded..."),
                    )
                    if pseudos:
                        collected = {p: {} for p in pseudos}

                if collected:
                    stats = await self._save_followers(collected, username)
                    log.info("pipeline",
                             f"Fetch done: {stats['collected']} collected, "
                             f"{stats['new']} new, {stats['refollows']} refollows")

            finally:
                await ctx.close()
                browser_manager.release_context()
        except Exception as e:
            log.error("pipeline", f"Fetch error: {e}")
        finally:
            self._running = False

        return stats

    async def _save_followers(self, collected: dict, username: str) -> dict:
        """Save collected followers to DB. Detect re-follows."""
        new_count = 0
        refollow_count = 0

        async with async_session() as session:
            for pseudo, meta in collected.items():
                if pseudo == username:
                    continue

                result = await session.execute(
                    select(Follower).where(Follower.username == pseudo))
                existing = result.scalar_one_or_none()

                if existing is None:
                    follower = Follower(
                        username=pseudo,
                        full_name=meta.get("full_name", ""),
                        is_private=meta.get("is_private", False),
                        follower_count=meta.get("follower_count"),
                    )
                    session.add(follower)
                    new_count += 1
                elif existing.removed:
                    # Re-follow detected
                    log.warning("pipeline",
                                f"Re-follow: @{pseudo} (was removed)")
                    existing.removed = False
                    existing.scanned = False
                    existing.score = None
                    existing.is_fake = None
                    existing.scan_error = None
                    refollow_count += 1
                else:
                    # Update metadata
                    if meta.get("follower_count") is not None:
                        existing.follower_count = meta["follower_count"]
                    if meta.get("is_private") is not None:
                        existing.is_private = meta["is_private"]
                    if meta.get("full_name"):
                        existing.full_name = meta["full_name"]

            await session.commit()

        return {
            "collected": len(collected),
            "new": new_count,
            "refollows": refollow_count,
        }

    # ── Scan phase ────────────────────────────────────────────────────────

    async def scan(self, batch_size: int | None = None) -> dict:
        """Scan pending followers and score them."""
        self._running = True
        self.stop_event.clear()

        if batch_size is None:
            batch_size = self.rate_tracker.profile["scan_batch"]

        stats = {"scanned": 0, "fakes": 0, "errors": 0, "rate_limited": False}

        # Get pending followers
        async with async_session() as session:
            result = await session.execute(
                select(Follower)
                .where(Follower.scanned == False, Follower.removed == False)
                .limit(batch_size)
            )
            pending = list(result.scalars().all())

        if not pending:
            log.info("pipeline", "No profiles to scan")
            self._running = False
            return stats

        # Shuffle for unpredictable navigation patterns
        random.shuffle(pending)
        total = len(pending)
        log.info("pipeline", f"Scanning {total} profiles")

        pacer = HumanPacer(base_min=2, base_max=6)

        try:
            ctx, page = await browser_manager.new_page()
            try:
                for i, follower in enumerate(pending):
                    if self.stop_event.is_set():
                        break

                    should_stop, reason = self.rate_tracker.should_stop()
                    if should_stop:
                        log.warning("pipeline", f"Auto-stop: {reason}")
                        self.stop_event.set()
                        break

                    t0 = time.time()

                    try:
                        data = await asyncio.wait_for(
                            extract_profile(page, follower.username),
                            timeout=20.0,
                        )
                    except asyncio.TimeoutError:
                        data = ProfileData(
                            username=follower.username,
                            not_found=True, error="timeout")

                    dt_ms = int((time.time() - t0) * 1000)

                    # 429 → immediate stop
                    if data.error == "429_RATE_LIMIT":
                        log.error("pipeline",
                                  f"@{follower.username}: HTTP 429 — stopping")
                        stats["rate_limited"] = True
                        await self._log_action(
                            "scan", follower.username, "error_429",
                            duration_ms=dt_ms)
                        self.stop_event.set()
                        break

                    # Score
                    score, details = score_profile(
                        data, threshold=settings.score_threshold)

                    # Save to DB
                    async with async_session() as session:
                        result = await session.execute(
                            select(Follower)
                            .where(Follower.username == follower.username))
                        f = result.scalar_one_or_none()
                        if f:
                            if score == -1:
                                f.scan_error = data.error or "not_found"
                                self.rate_tracker.record_error("scan_fail")
                                stats["errors"] += 1
                                status = "error"
                            else:
                                f.scanned = True
                                f.score = score
                                f.score_breakdown = json.dumps(details)
                                f.is_fake = score >= settings.score_threshold
                                f.is_private = data.is_private
                                f.follower_count = data.follower_count
                                f.post_count = data.post_count
                                f.bio = "" if not data.has_bio else "has_bio"
                                f.full_name = data.full_name or None
                                f.has_profile_pic = data.has_real_pic
                                f.scanned_at = datetime.now(timezone.utc)
                                self.rate_tracker.record_success()
                                status = "ok"

                                if f.is_fake:
                                    stats["fakes"] += 1

                            stats["scanned"] += 1
                            await session.commit()

                    await self._log_action(
                        "scan", follower.username, status,
                        duration_ms=dt_ms)

                    # Log progress
                    if score >= 0:
                        level = "FAKE" if score >= settings.score_threshold else "OK"
                        log.info("pipeline",
                                 f"[{i+1}/{total}] @{follower.username} → "
                                 f"{level} {score}/100")
                    else:
                        log.warning("pipeline",
                                    f"[{i+1}/{total}] @{follower.username} → "
                                    f"not found")

                    # Pace
                    if not self.stop_event.is_set() and i < total - 1:
                        pause = pacer.next_scan_pause()
                        await isleep(pause, self.stop_event)

            finally:
                await ctx.close()
                browser_manager.release_context()
        except Exception as e:
            log.error("pipeline", f"Scan error: {e}")
        finally:
            self._running = False

        log.info("pipeline",
                 f"Scan done: {stats['scanned']} scanned, "
                 f"{stats['fakes']} fakes, {stats['errors']} errors")
        return stats

    # ── Clean phase ───────────────────────────────────────────────────────

    async def clean(self, batch_size: int | None = None) -> dict:
        """Remove fake followers."""
        self._running = True
        self.stop_event.clear()

        if batch_size is None:
            batch_size = self.rate_tracker.profile["clean_batch"]

        stats = {"removed": 0, "blocked": 0, "errors": 0, "rate_limited": False}

        # Get fakes
        async with async_session() as session:
            result = await session.execute(
                select(Follower)
                .where(
                    Follower.is_fake == True,
                    Follower.removed == False,
                    Follower.scanned == True,
                )
                .order_by(Follower.score.desc())
                .limit(batch_size)
            )
            fakes = list(result.scalars().all())

        if not fakes:
            log.info("pipeline", "No fakes to clean")
            self._running = False
            return stats

        random.shuffle(fakes)
        total = len(fakes)
        log.info("pipeline", f"Cleaning {total} fakes")

        pacer = HumanPacer(
            base_min=self.rate_tracker.profile["pause_min"],
            base_max=self.rate_tracker.profile["pause_max"],
        )

        try:
            ctx, page = await browser_manager.new_page(block_resources=False)
            try:
                for i, follower in enumerate(fakes):
                    if self.stop_event.is_set():
                        break

                    should_stop, reason = self.rate_tracker.should_stop()
                    if should_stop:
                        log.warning("pipeline", f"Auto-stop: {reason}")
                        self.stop_event.set()
                        break

                    if not await self.rate_tracker.wait_if_limited(
                            self.stop_event):
                        break

                    t0 = time.time()

                    # Step 1: Navigate
                    try:
                        if not await navigate_to_profile(
                                page, follower.username):
                            log.warning("pipeline",
                                        f"@{follower.username}: nav failed")
                            self.rate_tracker.record_error("nav")
                            stats["errors"] += 1
                            continue
                    except RateLimitError:
                        log.error("pipeline",
                                  f"@{follower.username}: 429 — stopping")
                        stats["rate_limited"] = True
                        self.stop_event.set()
                        break

                    await isleep(random.uniform(1.0, 2.0), self.stop_event)
                    if self.stop_event.is_set():
                        break

                    # Step 2: Three dots
                    if not await click_three_dots(page):
                        log.warning("pipeline",
                                    f"@{follower.username}: ⋯ not found")
                        self.rate_tracker.record_error("dots")
                        stats["errors"] += 1
                        # 3 consecutive = probably rate limited
                        if self.rate_tracker._consecutive_errors >= 3:
                            stats["rate_limited"] = True
                            self.stop_event.set()
                        continue

                    await isleep(0.7, self.stop_event)
                    if self.stop_event.is_set():
                        break

                    # Step 3: Remove / Block
                    action = await click_remove_follower(page)
                    if not action:
                        log.warning("pipeline",
                                    f"@{follower.username}: remove option "
                                    f"not found")
                        self.rate_tracker.record_error("menu")
                        stats["errors"] += 1
                        try:
                            await page.keyboard.press("Escape")
                        except Exception:
                            pass
                        continue

                    await isleep(0.7, self.stop_event)
                    if self.stop_event.is_set():
                        break

                    # Step 4: Confirm
                    await click_confirm(page)
                    await isleep(0.5, self.stop_event)

                    dt_ms = int((time.time() - t0) * 1000)

                    # Save
                    async with async_session() as session:
                        result = await session.execute(
                            select(Follower)
                            .where(Follower.username == follower.username))
                        f = result.scalar_one_or_none()
                        if f:
                            f.removed = True
                            f.removed_at = datetime.now(timezone.utc)
                            await session.commit()

                    self.rate_tracker.record_action()
                    self.rate_tracker.record_success()

                    if action == "blocked":
                        stats["blocked"] += 1
                    else:
                        stats["removed"] += 1

                    await self._log_action(
                        "remove", follower.username, action,
                        duration_ms=dt_ms)

                    rate_stats = self.rate_tracker.stats()
                    log.info("pipeline",
                             f"[{i+1}/{total}] @{follower.username} → "
                             f"{action} ({follower.score}/100) "
                             f"[{rate_stats['actions_today']}/"
                             f"{rate_stats['limit_day']}/d]")

                    # Pace
                    if not self.stop_event.is_set() and i < total - 1:
                        pause = pacer.next_pause()
                        if pause > 60:
                            log.info("pipeline",
                                     f"Session break: {int(pause)}s...")
                        await isleep(pause, self.stop_event)

            finally:
                await ctx.close()
                browser_manager.release_context()
        except Exception as e:
            log.error("pipeline", f"Clean error: {e}")
        finally:
            self._running = False

        log.info("pipeline",
                 f"Clean done: {stats['removed']} removed, "
                 f"{stats['blocked']} blocked, {stats['errors']} errors")
        return stats

    # ── Autopilot ─────────────────────────────────────────────────────────

    async def autopilot(self) -> dict:
        """Continuous loop: Fetch → Scan → Clean until done."""
        self._running = True
        self.stop_event.clear()
        last_fetch_time = 0
        cycle = 0
        error_streak = 0

        log.info("pipeline", "Autopilot started")

        # Create session record
        async with async_session() as session:
            scan_session = ScanSession(status="running")
            session.add(scan_session)
            await session.commit()
            self._session_id = scan_session.id

        try:
            while not self.stop_event.is_set():
                cycle += 1
                now = time.time()

                # Phase 1: Fetch
                hours_since = (now - last_fetch_time) / 3600
                if hours_since >= AUTOPILOT_FETCH_INTERVAL_H or last_fetch_time == 0:
                    log.info("pipeline", f"── Cycle {cycle}: Fetch ──")
                    fetch_stats = await self.fetch()
                    last_fetch_time = time.time()
                    self._running = True  # fetch sets it to False
                    self.stop_event.clear()

                    if self.stop_event.is_set():
                        break

                    pause = random.uniform(*AUTOPILOT_PAUSE_BETWEEN)
                    log.info("pipeline",
                             f"Pause {int(pause/60)}min before scan...")
                    await isleep(pause, self.stop_event)

                # Phase 2: Scan
                pending_count = await self._count_pending()
                if pending_count > 0:
                    batch = random.randint(*AUTOPILOT_SCAN_BATCH)
                    log.info("pipeline",
                             f"── Cycle {cycle}: Scan ({batch} of "
                             f"{pending_count}) ──")
                    scan_stats = await self.scan(batch_size=batch)
                    self._running = True
                    self.stop_event.clear()

                    if scan_stats.get("rate_limited"):
                        cooldown = random.uniform(*AUTOPILOT_COOLDOWN_ON_ERR)
                        error_streak += 1
                        if error_streak >= 3:
                            log.error("pipeline",
                                      "Too many errors — stopping autopilot")
                            break
                        log.warning("pipeline",
                                    f"Rate limited — cooldown "
                                    f"{int(cooldown/60)}min")
                        await isleep(cooldown, self.stop_event)
                        continue
                    else:
                        error_streak = 0

                    if self.stop_event.is_set():
                        break

                    pause = random.uniform(*AUTOPILOT_PAUSE_SCAN)
                    log.info("pipeline",
                             f"Pause {int(pause/60)}min before clean...")
                    await isleep(pause, self.stop_event)

                # Phase 3: Clean
                fake_count = await self._count_fakes()
                if fake_count > 0:
                    batch = random.randint(*AUTOPILOT_CLEAN_BATCH)
                    log.info("pipeline",
                             f"── Cycle {cycle}: Clean ({batch} of "
                             f"{fake_count}) ──")
                    clean_stats = await self.clean(batch_size=batch)
                    self._running = True
                    self.stop_event.clear()

                    if clean_stats.get("rate_limited"):
                        cooldown = random.uniform(*AUTOPILOT_COOLDOWN_ON_ERR)
                        error_streak += 1
                        if error_streak >= 3:
                            log.error("pipeline",
                                      "Too many errors — stopping autopilot")
                            break
                        log.warning("pipeline",
                                    f"Rate limited — cooldown "
                                    f"{int(cooldown/60)}min")
                        await isleep(cooldown, self.stop_event)
                        continue
                    else:
                        error_streak = 0

                    if self.stop_event.is_set():
                        break

                    pause = random.uniform(*AUTOPILOT_PAUSE_CLEAN)
                    log.info("pipeline",
                             f"Pause {int(pause/60)}min...")
                    await isleep(pause, self.stop_event)

                # Check if done
                p = await self._count_pending()
                f = await self._count_fakes()
                if p == 0 and f == 0:
                    log.info("pipeline", "All done — no more pending or fakes")
                    break

                # Short pause before next cycle
                await isleep(random.uniform(60, 180), self.stop_event)

        finally:
            # Update session record
            await self._finish_session()
            self._running = False

        log.info("pipeline", "Autopilot stopped")
        return {"cycles": cycle}

    # ── Helpers ───────────────────────────────────────────────────────────

    async def _count_pending(self) -> int:
        async with async_session() as session:
            result = await session.execute(
                select(func.count(Follower.id))
                .where(Follower.scanned == False, Follower.removed == False))
            return result.scalar() or 0

    async def _count_fakes(self) -> int:
        async with async_session() as session:
            result = await session.execute(
                select(func.count(Follower.id))
                .where(
                    Follower.is_fake == True,
                    Follower.removed == False,
                    Follower.scanned == True))
            return result.scalar() or 0

    async def _log_action(self, action_type: str, target: str,
                          status: str, error_detail: str | None = None,
                          duration_ms: int | None = None) -> None:
        async with async_session() as session:
            session.add(ActionLog(
                action_type=action_type,
                target=target,
                status=status,
                error_detail=error_detail,
                duration_ms=duration_ms,
            ))
            await session.commit()

    async def _finish_session(self) -> None:
        if not self._session_id:
            return
        async with async_session() as session:
            result = await session.execute(
                select(ScanSession)
                .where(ScanSession.id == self._session_id))
            s = result.scalar_one_or_none()
            if s:
                s.status = "completed"
                s.finished_at = datetime.now(timezone.utc)
                # Count stats
                r = await session.execute(
                    select(func.count(Follower.id)))
                s.total_followers = r.scalar() or 0
                r = await session.execute(
                    select(func.count(Follower.id))
                    .where(Follower.scanned == True))
                s.scanned_count = r.scalar() or 0
                r = await session.execute(
                    select(func.count(Follower.id))
                    .where(Follower.is_fake == True))
                s.fake_count = r.scalar() or 0
                r = await session.execute(
                    select(func.count(Follower.id))
                    .where(Follower.removed == True))
                s.removed_count = r.scalar() or 0
                await session.commit()

    async def get_stats(self) -> dict:
        """Get current pipeline stats."""
        async with async_session() as session:
            total = (await session.execute(
                select(func.count(Follower.id)))).scalar() or 0
            pending = await self._count_pending()
            fakes = await self._count_fakes()
            removed = (await session.execute(
                select(func.count(Follower.id))
                .where(Follower.removed == True))).scalar() or 0
            scanned = (await session.execute(
                select(func.count(Follower.id))
                .where(Follower.scanned == True))).scalar() or 0

        return {
            "total_followers": total,
            "pending": pending,
            "scanned": scanned,
            "fakes": fakes,
            "removed": removed,
            "is_running": self._running,
            "rate": self.rate_tracker.stats(),
        }


# Singleton
pipeline = Pipeline()
