"""Classify Gemini API errors and shared retry helpers."""
from __future__ import annotations

import os
import time
from typing import Callable, TypeVar

T = TypeVar("T")

_RATE_MARKERS = (
    "429",
    "resource_exhausted",
    "rate limit",
    "rate_limit",
    "quota",
    "too many requests",
    "exhausted",
)

_QUOTA_MARKERS = (
    "resource_exhausted",
    "quota",
    "billing",
    "exceeded your current quota",
    "insufficient",
)


def _err_text(exc: BaseException) -> str:
    parts = [str(exc)]
    for attr in ("message", "status", "code", "reason"):
        v = getattr(exc, attr, None)
        if v is not None:
            parts.append(str(v))
    details = getattr(exc, "details", None)
    if details is not None:
        parts.append(str(details))
    return " ".join(parts).lower()


def is_rate_limit_error(exc: BaseException) -> bool:
    """True for 429 / quota / rate-limit style failures (transient or exhausted)."""
    t = _err_text(exc)
    return any(m in t for m in _RATE_MARKERS)


def is_quota_exhausted(exc: BaseException) -> bool:
    """True when billing/quota is depleted (not just a burst 429)."""
    t = _err_text(exc)
    return any(m in t for m in _QUOTA_MARKERS)


def retry_count() -> int:
    return max(0, int(os.environ.get("GEMINI_RETRY_COUNT", "2")))


def retry_backoff_sec() -> float:
    return max(0.5, float(os.environ.get("GEMINI_RETRY_BACKOFF_SEC", "3")))


def call_with_rate_limit_retry(
    fn: Callable[[], T],
    *,
    on_retry: Callable[[int, float, BaseException], None] | None = None,
) -> T:
    """Retry `fn` on rate-limit errors with linear backoff."""
    last: BaseException | None = None
    retries = retry_count()
    backoff = retry_backoff_sec()
    for attempt in range(retries + 1):
        try:
            return fn()
        except Exception as e:
            last = e
            if not is_rate_limit_error(e) or attempt >= retries:
                raise
            wait = backoff * (attempt + 1)
            if on_retry:
                on_retry(attempt + 1, wait, e)
            time.sleep(wait)
    assert last is not None
    raise last
