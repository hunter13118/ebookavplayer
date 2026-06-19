"""ART_STYLES.md P1–P5: style-namespaced media manifest."""
from __future__ import annotations

from server.playback import styles as S


def test_flat_manifest_migrates():
    flat = {
        "characters": {"a": "/m/a.png"},
        "backgrounds": {"s1": "/m/bg.png"},
        "cover": "/m/cover.png",
        "image_pins": {"a": {"provider": "x", "seed": 1}},
    }
    m = S.ensure_manifest(flat, default_active="anime")
    assert m["active"] == "anime"
    assert m["styles"]["anime"]["characters"]["a"] == "/m/a.png"
    assert m["styles"]["anime"]["complete"] is True


def test_pixel_filter_uses_source_media():
    m = S.ensure_manifest({
        "active": "semi-real",
        "styles": {
            "semi-real": {
                "characters": {"hero": "/m/semi-real/hero.png"},
                "backgrounds": {},
                "cover": None,
                "complete": True,
            },
        },
    })
    m = S.enable_pixel_filter(m, source_style="semi-real")
    flat, display, art_filter = S.resolve_compile_media(m)
    assert art_filter == "pixel"
    assert display == "pixel"
    assert flat["characters"]["hero"] == "/m/semi-real/hero.png"


def test_style_status_and_can_activate():
    m = S.ensure_manifest({
        "active": "semi-real",
        "styles": {
            "semi-real": {"characters": {"a": "/x"}, "backgrounds": {}, "complete": True},
        },
    })
    assert S.style_status(m, "semi-real") == "ready"
    assert S.style_status(m, "anime") == "empty"
    assert S.can_activate(m, "semi-real")
    assert not S.can_activate(m, "anime")
    assert S.can_activate(m, "pixel")  # filter available


def test_delete_style_guard():
    m = S.ensure_manifest({
        "active": "semi-real",
        "styles": {
            "semi-real": {"characters": {"a": "/x"}, "backgrounds": {}, "complete": True},
            "anime": {"characters": {}, "backgrounds": {}, "complete": False},
        },
    })
    assert S.generated_style_count(m) == 1
    m2 = S.delete_style(m, "anime")
    assert "anime" not in m2["styles"]
