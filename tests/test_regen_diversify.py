"""Regen diversify mode."""
from __future__ import annotations

from unittest.mock import patch

from server.images.generate import REGEN_DIVERSITY_HINT, _apply_diversify


def test_apply_diversify_appends_hint():
    out = _apply_diversify("Mei: teen girl", diversify=True)
    assert REGEN_DIVERSITY_HINT in out


def test_apply_diversify_off_unchanged():
    assert _apply_diversify("Hello", diversify=False) == "Hello"


def test_diversify_uses_random_seed(monkeypatch):
    from server.analyze.schema import AnalysisCharacter, AnalysisScene, BookAnalysis
    from server.images import generate as G

    calls = []

    def fake_gen_one(desc, refs, path, **kw):
        calls.append(kw.get("seed"))
        return None, {}

    analysis = BookAnalysis(
        book_id="t",
        title="T",
        characters=[AnalysisCharacter(id="mei", name="Mei", importance="primary")],
        scenes=[AnalysisScene(id="s1", chapter=1, title="One")],
    )

    with patch.object(G, "_gen_one", side_effect=fake_gen_one):
        with patch.object(G.random, "randint", return_value=424242):
            G.generate_media(
                analysis, "/tmp/out", None, "semi-real",
                scope="selected", character_ids=["mei"], diversify=True,
            )
    assert calls == [424242]
