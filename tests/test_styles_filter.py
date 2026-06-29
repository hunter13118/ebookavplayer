"""Pixel filter style must not break during partial art regen."""
from __future__ import annotations

from server.playback import styles as S


def test_generation_target_style_from_pixel_filter():
    media = {
        "active": "pixel",
        "styles": {
            "anime": {"characters": {"a": "/x"}, "backgrounds": {}, "complete": True},
            "pixel": {"mode": "filter", "filter_source": "anime"},
        },
    }
    assert S.generation_target_style(media, "pixel") == "anime"


def test_mark_style_generating_preserves_pixel_filter_slot():
    media = {
        "active": "pixel",
        "styles": {
            "anime": {"characters": {"a": "/x"}, "backgrounds": {"s": "/y"}, "complete": True},
            "pixel": {"mode": "filter", "filter_source": "anime"},
        },
    }
    out = S.mark_style_generating(media, "pixel")
    assert out["styles"]["pixel"]["mode"] == "filter"
    assert out["styles"]["anime"]["complete"] is False
