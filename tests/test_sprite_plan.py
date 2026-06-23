"""Tests for line-attribution stock vs custom sprite planning."""
from __future__ import annotations

from server.analyze.schema import AnalysisCharacter, AnalysisLine, AnalysisScene, BookAnalysis
from server.images.sprite_plan import (
    count_character_lines,
    plan_character_sprites,
    stock_sprite_url,
    use_stock_sprite,
)


def _analysis_with_lines() -> BookAnalysis:
    return BookAnalysis(
        book_id="t",
        title="T",
        characters=[
            AnalysisCharacter(id="hero", name="Hero", importance="primary", gender="male"),
            AnalysisCharacter(id="side", name="Side", importance="secondary", gender="female"),
            AnalysisCharacter(id="extra", name="Extra", importance="background", gender="male"),
        ],
        scenes=[
            AnalysisScene(
                id="s1",
                chapter=1,
                title="One",
                lines=[
                    AnalysisLine(character_id="hero", kind="dialogue", text="Hello."),
                    AnalysisLine(character_id="hero", kind="dialogue", text="Again."),
                    AnalysisLine(character_id="hero", kind="dialogue", text="More."),
                    AnalysisLine(character_id="hero", kind="dialogue", text="Still."),
                    AnalysisLine(character_id="side", kind="dialogue", text="Hi."),
                    AnalysisLine(character_id="narrator", kind="narration", text="They met."),
                ],
            ),
        ],
    )


def test_count_character_lines_excludes_narrator():
    counts = count_character_lines(_analysis_with_lines())
    assert counts["hero"] == 4
    assert counts["side"] == 1
    assert "narrator" not in counts


def test_low_line_side_character_uses_stock():
    a = _analysis_with_lines()
    counts = count_character_lines(a)
    total = sum(counts.values())
    by_id = {c.id: c for c in a.characters}
    assert use_stock_sprite(by_id["side"], counts["side"], total) is True
    assert use_stock_sprite(by_id["hero"], counts["hero"], total) is False


def test_plan_character_sprites_splits_cast():
    gen, stock = plan_character_sprites(_analysis_with_lines())
    assert "hero" in gen
    assert "side" in stock
    assert "extra" in stock


def test_stock_sprite_url_is_deterministic():
    assert stock_sprite_url("side", "female").startswith("/media/stock/f")
    assert stock_sprite_url("side", "female") == stock_sprite_url("side", "female")
