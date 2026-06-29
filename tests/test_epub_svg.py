"""EPUB parse picks up SVG inserts (light-novel style)."""
from __future__ import annotations

from pathlib import Path

from server.epub.parse import parse_epub


def test_vending_machine_epub_extracts_svg_illustrations():
    epub = Path(__file__).resolve().parents[1] / (
        "data/uploads/The_Vending_Machine_at_the_Edge_of_the_World.epub"
    )
    if not epub.is_file():
        return
    book = parse_epub(str(epub))
    assert len(book.images) >= 2
    assert book.illustration_markers
    for _ch, pairs in book.illustration_markers.items():
        for _idx, following in pairs:
            assert "alt=" not in following.lower()
            assert "width=" not in following.lower()
