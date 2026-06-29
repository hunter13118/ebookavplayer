"""Pipeline registry tests."""
from __future__ import annotations

from server.pipeline.registry import (
    default_config,
    load_config,
    resolved_extract_providers,
    resolved_freemium_chain,
    save_config,
)


def test_default_config_has_extract_lane():
    cfg = default_config()
    assert "gemini" in cfg["extract"]["order"]
    assert "cerebras" in cfg["extract"]["order"]


def test_disable_stage(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    save_config({"extract": {"disabled": ["groq"]}})
    order = resolved_extract_providers()
    assert "groq" not in order
    assert "gemini" in order


def test_reorder_freemium_chain(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    save_config({
        "image_freemium_character": {
            "order": ["huggingface", "cloudflare", "pollinations-anon", "pollinations-seed"],
            "disabled": [],
        },
    })
    chain = resolved_freemium_chain("character")
    assert chain[0] == "huggingface"


def test_load_config_without_file(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    assert load_config() == default_config()
