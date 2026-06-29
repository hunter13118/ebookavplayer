"""Expression sprite planning."""
from server.analyze.schema import AnalysisCharacter, AnalysisLine, AnalysisScene, BookAnalysis
from server.images.expression_sprites import collect_character_expressions
from server.images.moment_inserts import collect_visual_inserts


def _book():
    return BookAnalysis(
        book_id="t",
        title="T",
        characters=[
            AnalysisCharacter(id="mei", name="Mei", importance="primary", gender="female"),
        ],
        scenes=[
            AnalysisScene(
                id="s1",
                chapter=1,
                title="Rooftop",
                present_character_ids=["mei"],
                lines=[
                    AnalysisLine(
                        character_id="mei",
                        text="I cannot believe you would say that to me right now.",
                        kind="dialogue",
                        expression="angry",
                    ),
                    AnalysisLine(character_id="mei", text="Please…", kind="dialogue", expression="sad"),
                    AnalysisLine(character_id="narrator", text="She sighed.", kind="narration"),
                ],
            ),
        ],
    )


def test_collect_character_expressions():
    m = collect_character_expressions(_book())
    assert m["mei"] == {"angry", "sad"}


def test_collect_visual_inserts_heuristic():
    inserts = collect_visual_inserts(_book())
    assert inserts
    assert inserts[0]["character_id"] == "mei"
