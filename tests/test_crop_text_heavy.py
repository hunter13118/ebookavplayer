"""Regression test — _crop_is_text_heavy (scripts/local-image-server/detect_and_crop_faces.py).

Bug found live (2026-07-10): light-novel EPUBs often have a "character
introduction" plate (name banner + a description paragraph over a small
decorative portrait). The anime-face cascade can land on that small
portrait, and crop_upper_body's expansion sweeps in most of the surrounding
banner/text. That text-and-banner image then gets used as an IP-Adapter
reference — and IP-Adapter faithfully reproduces its busy, repetitive
layout, which is what a severe "character sheet" tiled-grid generation
artifact actually was in practice. Confirmed by pulling the real reference
crops behind several broken generations: they were title cards, not faces.

Requires the `tesseract` system binary + pytesseract (see
docs/LOCAL_IMAGE_GEN.md's Setup section) — skipped if unavailable, matching
_crop_is_text_heavy's own fail-open behavior.
"""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts" / "local-image-server"))
from detect_and_crop_faces import _crop_is_text_heavy  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"

pytesseract = pytest.importorskip("pytesseract")
try:
    pytesseract.get_tesseract_version()
except Exception:
    pytest.skip("tesseract binary not installed", allow_module_level=True)


def _load(name: str):
    img = cv2.imread(str(FIXTURES / name))
    assert img is not None, f"fixture {name} failed to load"
    return img


def test_title_card_crop_is_rejected():
    # A real captured "reference" that turned out to be a character-intro
    # title card (name banner + description paragraph), not a face.
    assert _crop_is_text_heavy(_load("title-card-crop.png")) is True


def test_real_face_crop_is_not_rejected():
    # A real captured face crop with no legible text in it.
    assert _crop_is_text_heavy(_load("real-face-crop.png")) is False


def test_min_words_threshold_is_configurable():
    img = _load("title-card-crop.png")
    # An absurdly high threshold should never trigger, regardless of content.
    assert _crop_is_text_heavy(img, min_words=1000) is False


def test_empty_crop_does_not_crash():
    import numpy as np

    empty = np.zeros((0, 0, 3), dtype="uint8")
    assert _crop_is_text_heavy(empty) is False
