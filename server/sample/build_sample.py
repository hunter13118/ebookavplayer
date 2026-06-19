"""Compile the sample analysis into a playback book (host: needs pydantic).

    python3 -m server.sample.build_sample

Demonstrates the full compile path (voice assignment, bg reuse, flattening)
that the live /ingest endpoint runs after the Gemini mega-pass.
"""
from __future__ import annotations

import json
from pathlib import Path

from ..analyze.gemini import analysis_from_json
from ..playback.compile import compile_book

HERE = Path(__file__).parent
OUT = Path("data/books/the-silver-gate.json")


def main() -> None:
    data = json.loads((HERE / "sample_analysis.json").read_text("utf-8"))
    analysis = analysis_from_json(data)
    book = compile_book(analysis, art_style="semi-real", narrator_gender="male")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(book.model_dump_json(indent=2), encoding="utf-8")
    analysis_out = OUT.parent / "the-silver-gate.analysis.json"
    analysis_out.write_text(json.dumps(data, indent=2), encoding="utf-8")
    print(f"wrote {OUT} ({len(book.scenes)} scenes)")
    print(f"wrote {analysis_out}")


if __name__ == "__main__":
    main()
