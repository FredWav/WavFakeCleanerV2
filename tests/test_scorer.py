"""Tests for the Python scorer module."""

import pytest
from backend.engine.scorer import score_username, pre_score_from_metadata


class TestScoreUsername:
    def test_bot_digits_pattern(self):
        score, details = score_username("bot8374629")
        assert score > 0

    def test_normal_username(self):
        score, details = score_username("jean_dupont")
        assert score == 0

    def test_all_digits(self):
        score, details = score_username("8374629102")
        assert score > 0

    def test_very_long_username(self):
        # 26+ chars triggers "very_long" pattern
        score, details = score_username("a" * 27)
        assert score > 0

    def test_no_vowels(self):
        score, details = score_username("bcdfghjklmnp")
        assert score > 0

    def test_high_digit_ratio(self):
        score, details = score_username("user12345678")
        assert score > 0

    def test_underscore_heavy(self):
        score, details = score_username("_a_b_c_d_e_")
        assert score > 0

    def test_capped_at_30(self):
        score, details = score_username("_bot_12345678901234567890_bcdfg_")
        assert score <= 30


class TestPreScoreFromMetadata:
    def test_obvious_fake(self):
        score, details = pre_score_from_metadata("bot8374629", 0, False, None, False)
        assert score is not None
        assert score >= 75

    def test_obvious_legit(self):
        score, details = pre_score_from_metadata("jean_dupont", 150, False, "Jean Dupont", True)
        assert score is not None
        assert score <= 15

    def test_inconclusive_returns_none(self):
        # Low followers, no pic, no name but normal username → score ~40, inconclusive
        score, details = pre_score_from_metadata("user_test", 5, False, None, False)
        assert score is None
