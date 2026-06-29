"""EPUB illustration placement from parse markers."""
from __future__ import annotations

import pytest

pytest.importorskip("pydantic")

from server.analyze.schema import AnalysisCharacter, AnalysisLine, AnalysisScene, BookAnalysis
from server.epub.placements import (
    apply_illustration_placements,
    apply_single_illustration_fallback,
    markers_in_chapter_text,
)


def test_markers_in_chapter_text():
    text = "Intro\n\n[[ILLUS:0]]\n\nRain had stopped by the time they arrived."
    assert markers_in_chapter_text(text) == [(0, "Rain had stopped by the time they arrived.")]


def test_apply_illustration_placements_by_following_text():
    analysis = BookAnalysis(
        book_id="bk",
        title="T",
        characters=[AnalysisCharacter(id="mira", name="Mira")],
        scenes=[AnalysisScene(
            id="s1", chapter=1, title="Gate",
            lines=[
                AnalysisLine(character_id="narrator", text="Rain had stopped.", kind="narration"),
                AnalysisLine(character_id="mira", text="Hello.", kind="dialogue"),
            ],
        )],
    )
    markers = {1: [(0, "Rain had stopped.")]}
    out = apply_illustration_placements(analysis, markers)
    assert out.scenes[0].lines[0].illustration_ref == 0
    assert out.scenes[0].lines[1].illustration_ref is None


def test_apply_illustration_before_dialogue_line():
    analysis = BookAnalysis(
        book_id="bk",
        title="T",
        characters=[AnalysisCharacter(id="mira", name="Mira")],
        scenes=[AnalysisScene(
            id="s1", chapter=1, title="Gate",
            lines=[
                AnalysisLine(character_id="narrator", text="Rain had stopped.", kind="narration"),
                AnalysisLine(character_id="mira", text="Hello there.", kind="dialogue"),
            ],
        )],
    )
    markers = {1: [(0, "Hello there.")]}
    out = apply_illustration_placements(analysis, markers)
    assert out.scenes[0].lines[1].illustration_ref == 0


def test_apply_single_illustration_fallback():
    analysis = BookAnalysis(
        book_id="bk",
        title="T",
        characters=[AnalysisCharacter(id="mira", name="Mira")],
        scenes=[AnalysisScene(
            id="s1", chapter=1, title="Gate",
            lines=[
                AnalysisLine(character_id="narrator", text="Setup.", kind="narration"),
                AnalysisLine(character_id="mira", text="Hi.", kind="dialogue"),
            ],
        )],
    )
    out = apply_single_illustration_fallback(analysis, 1)
    assert out.scenes[0].lines[0].illustration_ref is None
    assert out.scenes[0].lines[1].illustration_ref == 0
