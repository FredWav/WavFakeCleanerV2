"""Tests for auth module — JWT + password hashing."""

import pytest
from backend.api.auth import (
    create_token,
    decode_token,
    generate_verification_token,
    hash_password,
    verify_password,
)


class TestPasswordHashing:
    def test_hash_and_verify(self):
        password = "secureP@ss123"
        hashed = hash_password(password)
        assert hashed != password
        assert verify_password(password, hashed)

    def test_wrong_password_fails(self):
        hashed = hash_password("correct_password")
        assert not verify_password("wrong_password", hashed)

    def test_different_hashes_for_same_password(self):
        h1 = hash_password("same_password")
        h2 = hash_password("same_password")
        assert h1 != h2  # bcrypt uses random salt


class TestJWT:
    def test_create_and_decode(self):
        token = create_token(42, "test@example.com", "free")
        payload = decode_token(token)
        assert payload["sub"] == "42"
        assert payload["email"] == "test@example.com"
        assert payload["plan"] == "free"

    def test_invalid_token_raises(self):
        from fastapi import HTTPException
        with pytest.raises(HTTPException) as exc_info:
            decode_token("invalid.token.here")
        assert exc_info.value.status_code == 401


class TestVerificationToken:
    def test_generates_unique_tokens(self):
        t1 = generate_verification_token()
        t2 = generate_verification_token()
        assert t1 != t2
        assert len(t1) > 20
