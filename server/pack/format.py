"""Offline pack format (vae-offline-pack v1).

ZIP container with a namespaced manifest. Active art style only.
Tiers: visual (script + art), audiobook (+ pre-generated line audio).
"""
from __future__ import annotations

FORMAT_ID = "vae-offline-pack"
FORMAT_VERSION = 1

# Paths inside the ZIP (stable namespace — do not rename without bumping version).
MANIFEST_NAME = "vae/manifest.json"
BOOK_NAME = "vae/book.json"
VOICES_NAME = "vae/voices.json"
MEDIA_INDEX_NAME = "vae/media/index.json"
MEDIA_PREFIX = "vae/media/files/"
AUDIO_MANIFEST_NAME = "vae/audio/manifest.json"
AUDIO_PREFIX = "vae/audio/lines/"

TIER_VISUAL = "visual"
TIER_AUDIOBOOK = "audiobook"
VALID_TIERS = frozenset({TIER_VISUAL, TIER_AUDIOBOOK})

# Future audio engines (non-streamed packs from maker app, etc.)
AUDIO_ENGINE_EDGE = "edge-tts"
AUDIO_ENGINE_EXTERNAL = "external-pack"
