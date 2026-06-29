"""Speech-tag repair after LLM extraction — verbatim text preserved."""
from __future__ import annotations

import pytest

pytest.importorskip("pydantic")

from server.analyze.repair import repair_analysis, repair_scene_lines
from server.analyze.schema import AnalysisCharacter, AnalysisLine, AnalysisScene, BookAnalysis


def _scene(*lines: AnalysisLine) -> AnalysisScene:
    return AnalysisScene(id="s1", chapter=1, title="Test", lines=list(lines))


def _book(*scenes: AnalysisScene) -> BookAnalysis:
    return BookAnalysis(
        book_id="bk",
        title="T",
        characters=[
            AnalysisCharacter(id="kuro", name="Kuro"),
            AnalysisCharacter(id="mei", name="Mei Asano"),
        ],
        scenes=list(scenes),
    )


def test_pronoun_tag_text_unchanged():
    lines = [
        AnalysisLine(character_id="kuro", text="Hello.", kind="dialogue"),
        AnalysisLine(character_id="narrator", text="he said quietly.", kind="narration"),
    ]
    out = repair_scene_lines(lines)
    assert out[1].text == "he said quietly."
    assert out[1].kind == "narration"


def test_lone_said_delivery_becomes_narration_without_rewording():
    lines = [
        AnalysisLine(character_id="kuro", text="Hi.", kind="dialogue"),
        AnalysisLine(character_id="narrator", text="said", kind="delivery", delivery_verb="said"),
    ]
    out = repair_scene_lines(lines)
    assert out[1].text == "said"
    assert out[1].kind == "narration"
    assert out[1].delivery_verb is None


def test_merge_split_tag_fragments():
    lines = [
        AnalysisLine(character_id="kuro", text="Hi.", kind="dialogue"),
        AnalysisLine(character_id="narrator", text="he said", kind="narration"),
        AnalysisLine(character_id="narrator", text="quietly.", kind="narration"),
    ]
    out = repair_scene_lines(lines)
    assert len(out) == 2
    assert out[1].text == "he said quietly."


def test_stylized_delivery_preserved():
    lines = [
        AnalysisLine(character_id="mei", text="It is cold.", kind="dialogue"),
        AnalysisLine(
            character_id="narrator", text="sang Mei", kind="delivery",
            line_weight="minor", delivery_verb="sang",
        ),
    ]
    out = repair_scene_lines(lines)
    assert out[1].kind == "delivery"
    assert out[1].text == "sang Mei"
    assert out[1].delivery_verb == "sang"


def test_renormalize_chapters_maps_front_matter_offset():
    from server.analyze.repair import renormalize_chapters
    from server.analyze.schema import AnalysisScene, BookAnalysis
    book = BookAnalysis(
        book_id="t", title="T",
        scenes=[
            AnalysisScene(id="s1", chapter=3, title="One", lines=[]),
            AnalysisScene(id="s2", chapter=4, title="Two", lines=[]),
        ],
    )
    out = renormalize_chapters(book)
    assert [s.chapter for s in out.scenes] == [1, 2]


def test_repair_analysis_full_book():
    book = _book(_scene(
        AnalysisLine(character_id="kuro", text="Hi.", kind="dialogue"),
        AnalysisLine(character_id="narrator", text="he said,", kind="narration"),
        AnalysisLine(character_id="kuro", text="Bye.", kind="dialogue"),
    ))
    out = repair_analysis(book)
    assert out.scenes[0].lines[1].text == "he said,"


def test_split_merged_tag_after_dialogue():
    lines = [
        AnalysisLine(character_id="kuro", text="Took you long enough,", kind="dialogue"),
        AnalysisLine(
            character_id="narrator",
            text="he said, climbing out and brushing imaginary dust from a uniform.",
            kind="narration",
        ),
    ]
    out = repair_scene_lines(lines)
    assert len(out) == 3
    assert out[1].text == "he said,"
    assert out[1].kind == "narration"
    assert "climbing out" in out[2].text


def test_third_person_thought_becomes_narration():
    lines = [
        AnalysisLine(
            character_id="mei",
            text="Mei thought of all the things she had carried up to that rooftop.",
            kind="thought",
        ),
    ]
    out = repair_scene_lines(lines)
    assert out[0].character_id == "narrator"
    assert out[0].kind == "narration"
