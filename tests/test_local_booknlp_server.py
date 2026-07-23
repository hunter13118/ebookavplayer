"""
Tests for scripts/local-booknlp-server/server.py's pure string helpers — no
model loading, no network. Loaded via importlib because the directory name
has a hyphen (not a valid Python package path). Mirrors
tests/test_local_align_server.py's own loading pattern exactly.

Regression coverage for the quote-mark-doubling bug found while planning
Plan One Phase 2: a BookNLP quote span's byte-slice includes its own
enclosing quote marks, but the reader (web/src/reader/paragraphs.js)
unconditionally wraps any kind:"dialogue" line in curly quotes with no
existing-quote check — leaving them in double-rendered dialogue.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_SERVER_PATH = Path(__file__).resolve().parents[1] / "scripts" / "local-booknlp-server" / "server.py"
_spec = importlib.util.spec_from_file_location("local_booknlp_server", _SERVER_PATH)
if _spec is None or _spec.loader is None:
    pytest.skip("local-booknlp-server/server.py not found", allow_module_level=True)
local_booknlp_server = importlib.util.module_from_spec(_spec)
try:
    _spec.loader.exec_module(local_booknlp_server)
except ImportError:
    pytest.skip("truststore/torch/booknlp/fastapi not installed in this environment", allow_module_level=True)

_strip_enclosing_quotes = local_booknlp_server._strip_enclosing_quotes
_slugify = local_booknlp_server._slugify
_verbatim_span = local_booknlp_server._verbatim_span


def _tok(onset: int, offset: int) -> dict:
    """Minimal token dict — _verbatim_span only reads byte_onset/byte_offset."""
    return {"byte_onset": onset, "byte_offset": offset}


def test_verbatim_span_ascii_exact():
    text = "Kousuke put a marker here."
    # char offsets of "put a marker" within the string
    start, end = text.index("put"), text.index("here") + len("here")
    assert _verbatim_span(text, [_tok(start, 0), _tok(0, end)]) == "put a marker here"


def test_verbatim_span_multibyte_no_drift():
    """Regression: BookNLP reports CHARACTER offsets, but the span used to be
    sliced out of raw UTF-8 bytes — every 3-byte curly quote before the span
    shifted the window left, cutting words in half (Badlan|ds) and emitting
    U+FFFD mid-character. Char-slicing the decoded string is exact."""
    text = "everyone’s live from the Omitt Badlands. What am I doing?"
    end = text.index("Badlands") + len("Badlands")  # character offset
    span = _verbatim_span(text, [_tok(0, 0), _tok(0, end)])
    assert span.endswith("Omitt Badlands"), span
    assert "Badlan" != span[-6:] or span.endswith("Badlands")  # not truncated
    assert "�" not in span  # never a replacement char


def test_verbatim_span_curly_apostrophe_preserved():
    text = "y’know, it’s fine"
    span = _verbatim_span(text, [_tok(0, 0), _tok(0, len(text))])
    assert span == "y’know, it’s fine"
    assert "�" not in span


def test_verbatim_span_empty_tokens():
    assert _verbatim_span("anything", []) == ""


def test_strip_enclosing_quotes_straight():
    assert _strip_enclosing_quotes('"The wards still hum,"') == "The wards still hum,"


def test_strip_enclosing_quotes_curly():
    assert _strip_enclosing_quotes("“Are you lost?”") == "Are you lost?"


def test_strip_enclosing_quotes_leaves_inner_apostrophe_alone():
    assert _strip_enclosing_quotes('"Let\'s go,"') == "Let's go,"


def test_strip_enclosing_quotes_no_quotes_is_a_no_op():
    assert _strip_enclosing_quotes("Nothing quoted here.") == "Nothing quoted here."


def test_strip_enclosing_quotes_handles_empty_string():
    assert _strip_enclosing_quotes("") == ""
    assert _strip_enclosing_quotes('"') == ""


def test_slugify_lowercases_and_hyphenates():
    assert _slugify("Sylphie") == "sylphie"
    assert _slugify("Sir Reginald Ashworth III") == "sir-reginald-ashworth-iii"


def test_slugify_falls_back_when_nothing_alnum_survives():
    assert _slugify("") == "character"
    assert _slugify("...") == "character"
