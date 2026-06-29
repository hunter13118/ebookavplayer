"""Replace-all must not skip every asset via existing_media."""
from __future__ import annotations

from server.analyze.schema import AnalysisCharacter, AnalysisScene, BookAnalysis
from server.images.generate import generate_media


def test_generate_media_replace_all_does_not_skip(monkeypatch):
    calls = []

    def fake_gen_one(*args, **kwargs):
        calls.append(kwargs.get("kind"))
        return "/tmp/x.png", {"provider": "test"}

    monkeypatch.setattr("server.images.generate._gen_one", fake_gen_one)
    analysis = BookAnalysis(
        book_id="bk",
        title="T",
        characters=[AnalysisCharacter(id="a", name="A", importance="primary")],
        scenes=[AnalysisScene(id="s1", chapter=1, title="S", lines=[])],
    )
    existing = {
        "characters": {"a": "/media/bk/anime/char_a.png"},
        "backgrounds": {"s1": "/media/bk/anime/bg_s1.png"},
        "cover": "/media/bk/anime/cover.png",
    }
    generate_media(
        analysis, "/tmp/out", None, "anime",
        force_all=True, scope="all",
        existing_media={"characters": {}, "backgrounds": {}, "cover": None},
        allow_gemini=False, allow_freemium=False, allow_local=False,
    )
    assert "character" in calls
    assert "background" in calls
    assert "cover" in calls
