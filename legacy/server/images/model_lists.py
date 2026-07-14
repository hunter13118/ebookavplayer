"""Gemini model fallback chains (env overrides comma-separated)."""
from __future__ import annotations

import os


def _list(env_key: str, default: str) -> list[str]:
    raw = os.environ.get(env_key, default)
    return [m.strip() for m in raw.split(",") if m.strip()]


# Text mega-pass — tried in order until one succeeds.
GEMINI_TEXT_MODELS = _list(
    "GEMINI_TEXT_MODELS",
    "gemini-2.5-flash,gemini-2.0-flash,gemini-1.5-flash",
)

# Image generation — tried in order until one succeeds.
GEMINI_IMAGE_MODELS = _list(
    "GEMINI_IMAGE_MODELS",
    "gemini-2.5-flash-image,gemini-3.1-flash-image,gemini-3-pro-image",
)
