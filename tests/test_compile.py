"""Playback compiler — needs pydantic (skipped automatically if unavailable)."""
import json
from pathlib import Path

import pytest

pytest.importorskip("pydantic")

from server.analyze.gemini import analysis_from_json
from server.playback.compile import compile_book

SAMPLE = Path("server/sample/sample_analysis.json")


def _analysis():
    return analysis_from_json(json.loads(SAMPLE.read_text("utf-8")))


def test_compiles_and_flattens():
    book = compile_book(_analysis())
    assert book.book_id == "the-silver-gate"
    assert len(book.scenes) == 2
    idxs = [ln.idx for s in book.scenes for ln in s.lines]
    assert idxs == list(range(len(idxs)))          # stable, contiguous indices


def test_every_line_has_resolved_voice():
    book = compile_book(_analysis())
    for s in book.scenes:
        for ln in s.lines:
            assert ln.voice and "Neural" in ln.voice


def test_narrator_present_and_voiced():
    book = compile_book(_analysis(), narrator_gender="female")
    assert "narrator" in book.characters
    assert book.characters["narrator"]["voice"]


def test_background_reuse_resolves():
    data = json.loads(SAMPLE.read_text("utf-8"))
    data["scenes"][1]["reuse_background_of"] = "scene-0001"
    book = compile_book(analysis_from_json(data))
    assert book.scenes[0].background == book.scenes[1].background
