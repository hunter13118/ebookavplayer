"""Phase 2+ tests: selective image regeneration (preview picker API contract)."""
from __future__ import annotations

from server.analyze.schema import AnalysisCharacter, AnalysisScene, BookAnalysis
from server.images.generate import media_work_items


def _mini_analysis() -> BookAnalysis:
    return BookAnalysis(
        book_id="t",
        title="T",
        characters=[
            AnalysisCharacter(id="a", name="A", importance="primary"),
            AnalysisCharacter(id="b", name="B", importance="secondary"),
        ],
        scenes=[
            AnalysisScene(id="s1", chapter=1, title="One"),
            AnalysisScene(id="s2", chapter=1, title="Two", reuse_background_of="s1"),
            AnalysisScene(id="s3", chapter=2, title="Three"),
        ],
    )


def test_media_work_items_selected_cover_and_one_character():
    a = _mini_analysis()
    n = media_work_items(
        a,
        force_all=True,
        scope="selected",
        include_cover=True,
        character_ids=["a"],
        scene_ids=None,
    )
    assert n == 2  # cover + char a (b is stock when force_all=False but force_all=True includes all chars in plan)


def test_media_work_items_selected_one_background():
    a = _mini_analysis()
    n = media_work_items(
        a,
        force_all=True,
        scope="selected",
        include_cover=False,
        character_ids=None,
        scene_ids=["s3"],
    )
    assert n == 1  # s2 reuses s1; s1 and s3 are generated backgrounds


def test_media_work_items_selected_mixed():
    a = _mini_analysis()
    n = media_work_items(
        a,
        force_all=True,
        scope="selected",
        include_cover=True,
        character_ids=["b"],
        scene_ids=["s1"],
    )
    # cover + b (force_all puts b in generate list) + s1 bg
    assert n == 3
