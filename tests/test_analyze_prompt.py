"""P1: Gemini mega-pass requests expression tags."""
from server.analyze.prompt import build_prompt


def test_prompt_includes_expression_fields():
    p = build_prompt("book-1", "Title", "Author", "Once upon a time.")
    assert "expression" in p
    assert "environment" in p
    assert "intensity" in p


def test_prompt_includes_dialogue_extraction_pipeline():
    p = build_prompt("book-1", "Title", "Author", "Once upon a time.")
    assert "DIALOGUE EXTRACTION PIPELINE" in p
    assert "INTERRUPTED DIALOGUE" in p
    assert "VERBATIM COVERAGE" in p
    assert "he said quietly" in p
    assert "do NOT write" in p or "do NOT write \"Kuro\"" in p


def test_prompt_includes_illustration_ref_when_images():
    p = build_prompt("book-1", "Title", "Author", "Once.", has_reference_images=True)
    assert "illustration_ref" in p
    assert "numbered 0" in p
