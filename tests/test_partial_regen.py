"""Tests for partial art regen skip-list fix."""
from __future__ import annotations

from server.app import _existing_media_for_regen


def test_selected_regen_does_not_skip_chosen_characters():
    flat = {
        "characters": {"mei": "/m/mei.png", "kuro": "/m/kuro.png"},
        "backgrounds": {"s1": "/m/s1.png"},
        "cover": "/m/cover.png",
    }
    skip = _existing_media_for_regen(
        "selected", False, flat,
        character_ids=["kuro"],
        scene_ids=None,
        insert_line_indices=None,
        include_cover=False,
    )
    assert "kuro" not in skip["characters"]
    assert "mei" in skip["characters"]
    assert skip["cover"] == flat["cover"]


def test_selected_regen_regenerates_cover_when_requested():
    flat = {
        "characters": {},
        "backgrounds": {},
        "cover": "/m/cover.png",
    }
    skip = _existing_media_for_regen(
        "selected", False, flat,
        character_ids=None,
        scene_ids=None,
        insert_line_indices=None,
        include_cover=True,
    )
    assert skip["cover"] is None


def test_full_regen_clears_skip_list():
    flat = {
        "characters": {"a": "/x"},
        "backgrounds": {},
        "cover": "/c",
    }
    skip = _existing_media_for_regen(
        "all", True, flat,
        character_ids=None,
        scene_ids=None,
        insert_line_indices=None,
        include_cover=False,
    )
    assert skip == {"characters": {}, "backgrounds": {}, "inserts": {}, "cover": None}
