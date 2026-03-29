"""Tests for quota module logic."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from datetime import datetime, timezone

from backend.api.quota import _today


class TestQuotaHelpers:
    def test_today_format(self):
        today = _today()
        # Should be YYYY-MM-DD format
        assert len(today) == 10
        assert today.count("-") == 2
        # Parse it to verify format
        datetime.strptime(today, "%Y-%m-%d")
