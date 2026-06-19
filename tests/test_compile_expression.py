"""P1: expression tags from analysis → playback compile."""
import json
from pathlib import Path

import pytest

pytest.importorskip("pydantic")

from server.analyze.gemini import analysis_from_json
from server.playback.compile import compile_book

SAMPLE = Path("server/sample/sample_analysis.json")


def test_gemini_whisper_preserved():
    data = json.loads(SAMPLE.read_text("utf-8"))
    book = compile_book(analysis_from_json(data))
    garrick = book.scenes[1].lines[2]
    assert garrick.text.startswith("Quiet, boy")
    assert garrick.expression == "whisper"
    assert garrick.environment == "hall"
    assert garrick.intensity == pytest.approx(0.85)


def test_heuristic_when_expression_normal():
    data = json.loads(SAMPLE.read_text("utf-8"))
    data["scenes"][0]["lines"][1]["expression"] = "normal"
    data["scenes"][0]["lines"][1]["text"] = "STOP RIGHT THERE!"
    book = compile_book(analysis_from_json(data))
    line = book.scenes[0].lines[1]
    assert line.expression == "yell"
