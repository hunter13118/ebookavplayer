"""Tests for Gemini error classification and retry policy."""
from __future__ import annotations

import pytest

from server.analyze.gemini_errors import (
    call_with_rate_limit_retry,
    is_quota_exhausted,
    is_rate_limit_error,
)


def test_rate_limit_detection():
    assert is_rate_limit_error(Exception("429 RESOURCE_EXHAUSTED"))
    assert is_rate_limit_error(Exception("rate limit exceeded"))
    assert not is_rate_limit_error(Exception("invalid API key"))


def test_quota_detection():
    assert is_quota_exhausted(Exception("You exceeded your current quota"))
    assert is_quota_exhausted(Exception("RESOURCE_EXHAUSTED billing"))
    assert not is_quota_exhausted(Exception("rate limit try again"))


def test_retry_succeeds_after_transient(monkeypatch):
    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] < 2:
            raise RuntimeError("429 rate limit")
        return "ok"

    monkeypatch.setenv("GEMINI_RETRY_COUNT", "2")
    monkeypatch.setenv("GEMINI_RETRY_BACKOFF_SEC", "0")
    assert call_with_rate_limit_retry(flaky) == "ok"
    assert calls["n"] == 2


def test_retry_raises_non_rate_limit():
    with pytest.raises(ValueError, match="bad key"):
        call_with_rate_limit_retry(lambda: (_ for _ in ()).throw(ValueError("bad key")))
