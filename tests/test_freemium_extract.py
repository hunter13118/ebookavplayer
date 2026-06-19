"""Tests for freemium text extraction cascade + per-book provider pinning."""
from __future__ import annotations

import json

import pytest

from server.analyze.freemium_extract import (
    build_chain,
    chunk_text,
    merge_analysis_dicts,
    parse_model_json,
)
from server.analyze.extract import extract_book, ExtractUnavailable
from server.analyze.gemini import GeminiUnavailable
from server.playback import library as L


def test_parse_model_json_strips_fence():
    raw = '```json\n{"characters": [], "scenes": []}\n```'
    data = parse_model_json(raw)
    assert data["characters"] == []


def test_parse_model_json_repairs_trailing_comma():
    raw = '{"characters": [], "scenes": [],}'
    data = parse_model_json(raw)
    assert "scenes" in data


def test_chunk_text_splits_paragraphs():
    para = "A" * 200
    text = "\n\n".join([para] * 300)
    chunks = chunk_text(text, max_tokens=500)
    assert len(chunks) > 1
    for c in chunks:
        assert len(c) <= 500 * 4 + 50


def test_build_chain_pins_provider():
    chain = build_chain("groq")
    assert chain[0] == "groq"
    assert "gemini" in chain


def test_merge_analysis_dicts_dedupes_characters():
    a = {
        "characters": [{"id": "hero", "name": "Hero", "aliases": ["H"], "description": "tall"}],
        "scenes": [{"id": "s1", "lines": []}],
    }
    b = {
        "characters": [{"id": "hero", "name": "Hero", "aliases": ["The Hero"], "description": "tall warrior"}],
        "scenes": [{"id": "s2", "lines": []}],
    }
    merged = merge_analysis_dicts([a, b])
    assert len(merged["characters"]) == 1
    assert len(merged["scenes"]) == 2
    assert "The Hero" in merged["characters"][0]["aliases"]


def test_extract_pin_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(L, "BOOKS_DIR", tmp_path / "books")
    monkeypatch.setattr(L, "DATA_DIR", tmp_path)
    L.write_extract_pin("bk-pin", "cerebras", "llama-3.3-70b")
    pin = L.read_extract_pin("bk-pin")
    assert pin["provider"] == "cerebras"
    assert pin["model"] == "llama-3.3-70b"


def test_extract_book_falls_back_to_freemium(tmp_path, monkeypatch):
    monkeypatch.setattr(L, "BOOKS_DIR", tmp_path / "books")
    monkeypatch.setattr(L, "DATA_DIR", tmp_path)

    def _fail_gemini(*_a, **_k):
        raise GeminiUnavailable("quota gone", code="quota_exhausted")

    sample = {
        "book_id": "bk",
        "title": "T",
        "author": "A",
        "characters": [{
            "id": "narrator",
            "name": "Narrator",
            "gender": "unknown",
            "importance": "primary",
            "description": "",
        }],
        "scenes": [{
            "id": "scene-0001",
            "chapter": 1,
            "title": "",
            "location": "hall",
            "background_desc": "A hall",
            "present_character_ids": [],
            "lines": [{
                "character_id": "narrator",
                "text": "Hello.",
                "kind": "narration",
            }],
        }],
    }

    def _freemium_ok(user_text, *, system_prompt, prefer_provider=None, on_event=None):
        return {"provider": "groq", "model": "llama-3.3-70b-versatile", "data": sample}

    monkeypatch.setattr("server.analyze.extract.analyze_book", _fail_gemini)
    monkeypatch.setattr("server.analyze.extract.freemium_extract", _freemium_ok)

    analysis = extract_book("bk", "T", "A", "Hello world text here.")
    assert analysis.book_id == "bk"
    pin = L.read_extract_pin("bk")
    assert pin["provider"] == "groq"


def test_extract_book_uses_stored_non_gemini_pin(tmp_path, monkeypatch):
    monkeypatch.setattr(L, "BOOKS_DIR", tmp_path / "books")
    monkeypatch.setattr(L, "DATA_DIR", tmp_path)
    L.write_extract_pin("bk2", "mistral", "mistral-small-latest")

    called = {"gemini": False, "prefer": None}

    def _no_gemini(*_a, **_k):
        called["gemini"] = True
        raise AssertionError("should not call gemini")

    def _freemium_ok(user_text, *, system_prompt, prefer_provider=None, on_event=None):
        called["prefer"] = prefer_provider
        return {
            "provider": "mistral",
            "model": "mistral-small-latest",
            "data": {
                "book_id": "bk2",
                "characters": [],
                "scenes": [{
                    "id": "scene-0001", "chapter": 1, "location": "x",
                    "background_desc": "x", "lines": [
                        {"character_id": "narrator", "text": "Hi", "kind": "narration"},
                    ],
                }],
            },
        }

    monkeypatch.setattr("server.analyze.extract.analyze_book", _no_gemini)
    monkeypatch.setattr("server.analyze.extract.freemium_extract", _freemium_ok)

    extract_book("bk2", "T", "A", "Some text.")
    assert called["gemini"] is False
    assert called["prefer"] == "mistral"


def test_extract_book_all_fail_raises(tmp_path, monkeypatch):
    monkeypatch.setattr(L, "BOOKS_DIR", tmp_path / "books")
    monkeypatch.setattr(L, "DATA_DIR", tmp_path)
    monkeypatch.setenv("DISABLE_FREEMIUM_EXTRACT", "1")

    def _fail_gemini(*_a, **_k):
        raise GeminiUnavailable("nope", code="quota_exhausted")

    monkeypatch.setattr("server.analyze.extract.analyze_book", _fail_gemini)

    with pytest.raises(ExtractUnavailable):
        extract_book("bk3", "T", "A", "text")
