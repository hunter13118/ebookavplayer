"""P6: EPUB illustration direct-use pipeline."""
from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

pytest.importorskip("pydantic")

from server.analyze.gemini import analysis_from_json
from server.analyze.schema import AnalysisCharacter, AnalysisScene, BookAnalysis
from server.epub.illustrations import load_image_index, persist_extracted_images
from server.playback.illustrations import (
    apply_direct_illustrations,
    catalog_from_urls,
    default_illustration_mode,
    normalize_illustration_mode,
    reference_bytes_for_character,
    resolve_line_illustration,
)
from server.playback.compile import compile_book


def _fresh():
    d = tempfile.mkdtemp()
    import importlib
    import os
    os.environ["DATA_DIR"] = d
    from server.playback import library as L
    importlib.reload(L)
    return L, Path(d) / "media"


def test_default_illustration_mode():
    assert default_illustration_mode("semi-real", 3) == "reference"
    assert default_illustration_mode("anime", 2) == "moment"
    assert default_illustration_mode("anime", 0) == "reference"
    assert normalize_illustration_mode("auto", "cartoon", 1) == "moment"
    assert normalize_illustration_mode("direct-use", "anime", 5) == "direct-use"
    assert normalize_illustration_mode("reference", "anime", 5) == "reference"


def test_persist_and_load_image_index():
    _, media_root = _fresh()
    blobs = [b"\x89PNG\r\n\x1a\n" + b"x" * 40, b"\xff\xd8" + b"y" * 40]
    urls = persist_extracted_images("bk", blobs, media_root)
    assert urls[0].endswith("img_00.png")
    assert urls[1].endswith("img_01.jpg")
    reloaded = load_image_index(media_root, "bk")
    assert reloaded[0] == urls[0]
    assert reloaded[1] == urls[1]


def test_apply_direct_illustrations_to_media():
    L, media_root = _fresh()
    blobs = [b"\x89PNG\r\n\x1a\n" + b"a" * 20, b"\x89PNG\r\n\x1a\n" + b"b" * 20]
    urls = persist_extracted_images("bk", blobs, media_root)
    analysis = BookAnalysis(
        book_id="bk",
        title="T",
        characters=[
            AnalysisCharacter(id="hero", name="Hero", illustration_ref=0),
        ],
        scenes=[
            AnalysisScene(id="s1", chapter=1, title="Open", illustration_ref=1, lines=[]),
        ],
    )
    counts = apply_direct_illustrations(
        "bk", analysis, urls, style="anime", set_media=L.set_media,
    )
    assert counts["characters"] == 1
    assert counts["backgrounds"] == 1
    assert counts["cover"] == 1
    m = L.read_media("bk")
    slot = m["styles"]["anime"]
    assert slot["characters"]["hero"] == urls[0]
    assert slot["backgrounds"]["s1"] == urls[1]


def test_compile_uses_illustration_urls(monkeypatch):
    monkeypatch.setattr(
        "server.playback.compile._media_file_exists", lambda _url: True,
    )
    catalog = ["/media/bk/illustrations/img_00.png", "/media/bk/illustrations/img_01.png"]
    analysis = analysis_from_json({
        "book_id": "bk",
        "title": "T",
        "characters": [{"id": "hero", "name": "Hero", "illustration_ref": 0}],
        "scenes": [{
            "id": "s1", "chapter": 1, "title": "A", "illustration_ref": 1,
            "present_character_ids": ["hero"],
            "lines": [
                {"character_id": "narrator", "text": "Open.", "kind": "narration",
                 "illustration_ref": 1},
                {"character_id": "hero", "text": "Hi.", "kind": "dialogue"},
            ],
        }],
    })
    media = {
        "characters": {"hero": "/media/bk/anime/char_hero.png"},
        "backgrounds": {"s1": "/media/bk/anime/bg_s1.png"},
        "cover": "/media/bk/anime/cover.png",
    }
    book = compile_book(analysis, media=media, illustrations=catalog)
    assert book.characters["hero"]["sprite"] == "/media/bk/anime/char_hero.png"
    assert book.scenes[0].lines[0].illustration_url == catalog[1]
    assert book.scenes[0].lines[1].illustration_url is None


def test_resolve_line_illustration_scene_fallback():
    catalog = ["/a.png", "/b.png"]
    ref, url = resolve_line_illustration(
        None, 1, is_first_line_in_scene=True, catalog=catalog,
    )
    assert ref == 1 and url == "/b.png"


def test_reference_bytes_for_character():
    analysis = BookAnalysis(
        book_id="bk",
        title="T",
        characters=[AnalysisCharacter(id="hero", name="Hero", illustration_ref=1)],
        scenes=[],
    )
    blobs = [b"a", b"b", b"c"]
    refs = reference_bytes_for_character("hero", analysis, blobs)
    assert refs == [b"b"]


def test_generate_media_skips_existing(monkeypatch):
    pytest.importorskip("pydantic")
    from server.images import generate as G

    calls = []

    def fake_gen_one(*args, **kwargs):
        calls.append(kwargs.get("kind"))
        return None, {}

    monkeypatch.setattr(G, "_gen_one", fake_gen_one)
    analysis = BookAnalysis(
        book_id="bk",
        title="T",
        characters=[AnalysisCharacter(id="a", name="A", importance="primary")],
        scenes=[AnalysisScene(id="s1", chapter=1, title="S", lines=[])],
    )
    G.generate_media(
        analysis, "/tmp/out", existing_media={
            "characters": {"a": "/media/bk/anime/char_a.png"},
            "backgrounds": {"s1": "/media/bk/anime/bg_s1.png"},
            "cover": "/media/bk/anime/cover.png",
        },
        allow_gemini=False,
        allow_freemium=False,
        allow_local=False,
    )
    assert calls == []
