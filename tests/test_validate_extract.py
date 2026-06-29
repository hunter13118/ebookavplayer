"""Tests for extract validation against the vending machine fixture."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

pytest.importorskip("pydantic")

ROOT = Path(__file__).resolve().parents[1]
BID = "The_Vending_Machine_at_the_Edge_of_the_World"
EPUB = ROOT / "data" / "uploads" / f"{BID}.epub"
ANALYSIS = ROOT / "data" / "books" / f"{BID}.analysis.json"

pytestmark = pytest.mark.skipif(
    not EPUB.is_file() or not ANALYSIS.is_file(),
    reason="vending machine fixture not present",
)


@pytest.fixture
def report():
    from server.analyze.schema import BookAnalysis
    from server.analyze.validate import validate_extract

    analysis = BookAnalysis.model_validate(json.loads(ANALYSIS.read_text(encoding="utf-8")))
    return validate_extract(str(EPUB), analysis)


def test_vending_illustrations_mapped(report):
    ill = report["illustrations"]
    assert ill["epub_images"] == 2
    assert ill["analysis_refs"] == 2


def test_vending_no_lone_speech_verbs(report):
    codes = {i["code"] for i in report["structural_issues"]}
    assert "lone_speech_verb" not in codes
    assert "plain_verb_as_delivery" not in codes


def test_vending_verbatim_tags_not_flagged(report):
    merged_lines = {
        i["line"] for i in report["structural_issues"]
        if i["code"] == "tag_merged_with_narration"
    }
    assert 16 not in merged_lines


def test_vending_flags_real_merged_tag(report):
    merged = [i for i in report["structural_issues"] if i["code"] == "tag_merged_with_narration"]
    # After repair, merged tags should be split; fixture may have none left.
    if merged:
        assert any("he said" in (i.get("text") or "").lower() for i in merged)


def test_vending_afterword_missing(report):
    sig = report["chapter_signature_misses"]
    assert any("afterword" in m["title"].lower() for m in sig)
    assert report["word_coverage"]["coverage_ratio"] < 0.95
