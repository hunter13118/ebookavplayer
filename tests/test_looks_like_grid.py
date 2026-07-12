"""Integration test — _looks_like_grid (scripts/local-image-server/server.py).

Root cause of a real, confirmed-live bug: _face_count (whole-image face
cascade) under-counts badly on real "character sheet" grid outputs — an
8-tile grid scored "faces=1" and shipped as-is. A pixel-only replacement
(per-cell face cascade, then row/column edge-projection periodicity) was
tried and rejected: both failed on real captured examples (Helen's and
Anne's grids have different tile-background patterns than Diana's, and
neither geometric heuristic generalized across all three). _looks_like_grid
instead asks the local Ollama vision model (gemma3:27b, the same one already
used for plate-to-character matching) — a semantic "does this look like a
grid of faces" judgment, which is what a vision LLM is suited for.

Requires a reachable Ollama server with the vision model pulled — skipped
entirely if unavailable, matching _looks_like_grid's own fail-open (returns
False, never raises) behavior.
"""
from __future__ import annotations

import importlib.util
import json
import sys
import urllib.request
from pathlib import Path

import pytest
from PIL import Image

_SERVER_PATH = Path(__file__).parent.parent / "scripts" / "local-image-server" / "server.py"
_spec = importlib.util.spec_from_file_location("local_image_server", _SERVER_PATH)
server = importlib.util.module_from_spec(_spec)
sys.modules["local_image_server"] = server
_spec.loader.exec_module(server)

FIXTURES = Path(__file__).parent / "fixtures"


def _ollama_available() -> bool:
    try:
        with urllib.request.urlopen("http://localhost:11434/api/tags", timeout=2) as resp:
            data = json.load(resp)
        names = {m.get("name") for m in data.get("models", [])}
        return any(n == "gemma3:27b" or (n or "").startswith("gemma3:27b") for n in names)
    except Exception:
        return False


if not _ollama_available():
    pytest.skip("Ollama with gemma3:27b not reachable", allow_module_level=True)


def _load(name: str):
    return Image.open(FIXTURES / name)


def test_character_sheet_grid_is_detected():
    # A real captured "generated portrait" that's actually a 3x3 tiled grid
    # of repeated face variations — the exact artifact this guards against.
    assert server._looks_like_grid(_load("character-sheet-grid.png")) is True


def test_clean_single_portrait_is_not_flagged():
    # A real captured clean single-character generation — must not
    # false-positive, or every generation would retry needlessly.
    assert server._looks_like_grid(_load("clean-single-portrait.png")) is False
