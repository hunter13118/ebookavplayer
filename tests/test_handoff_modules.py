"""Tests for IMAGE AND VOICE HANDOFF module ports."""
from __future__ import annotations

from server.audio.voice_expression import (
    build_expression_plan,
    normalize_expression,
)
from server.images.freemium import (
    art_style_to_freemium,
    compose_prompt,
    normalize_style,
    build_chain,
)


def test_art_style_mapping():
    assert art_style_to_freemium("semi-real") == "realistic"
    assert art_style_to_freemium("anime") == "anime"
    assert art_style_to_freemium("cartoon") == "comic"
    assert art_style_to_freemium("pixel") == "pixel"


def test_compose_prompt_anime_character():
    p = compose_prompt(
        "A sorceress in purple robes",
        subject_type="character",
        style="anime",
    )
    assert "isekai anime" in p
    assert "Portrait bust character sprite" in p
    assert "transparent background" in p.lower()
    assert "sorceress" in p


def test_compose_prompt_character_with_sprite_background():
    p = compose_prompt(
        "A knight in armor",
        subject_type="character",
        style="neutral",
        sprite_background="a plain flat white background",
    )
    assert "plain flat white background" in p
    assert "transparent background" not in p.lower()


def test_compose_prompt_cartoon_background():
    p = compose_prompt(
        "Moonlit cathedral courtyard",
        subject_type="background",
        style="cartoon",
    )
    assert "Adventure Time" in p
    assert "no characters" in p.lower()


def test_normalize_style_cartoon_alias():
    assert normalize_style("Cartoon style") == "comic"


def test_handoff_chain_prefers_pin():
    chain = build_chain("character", "pollinations-seed")
    assert chain[0] == "pollinations-seed"
    assert "cloudflare" in chain


def test_freemium_extract_chain_prefers_pin():
    from server.analyze.freemium_extract import build_chain as extract_chain
    chain = extract_chain("cerebras")
    assert chain[0] == "cerebras"
    assert "gemini" in chain


def test_whisper_expression_plan_has_dsp():
    plan = build_expression_plan(
        {"text": "Stay close.", "expression": "whisper", "intensity": 0.8},
        "edge",
    )
    assert plan["ssml"]["volume"].startswith("-")
    assert any(a["type"] == "highpass" for a in plan["dsp"])
    assert normalize_expression("she screamed") == "yell"
