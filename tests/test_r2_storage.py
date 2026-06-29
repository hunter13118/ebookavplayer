"""Tests for R2 pack mirror helpers."""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


def test_r2_configured_requires_env(monkeypatch):
    monkeypatch.delenv("R2_BUCKET", raising=False)
    from server.storage.r2 import r2_configured
    assert r2_configured() is False

    monkeypatch.setenv("R2_BUCKET", "vae-packs")
    monkeypatch.setenv("R2_ACCESS_KEY_ID", "key")
    monkeypatch.setenv("R2_SECRET_ACCESS_KEY", "secret")
    monkeypatch.setenv("R2_ACCOUNT_ID", "acct")
    from importlib import reload
    import server.storage.r2 as r2mod
    reload(r2mod)
    assert r2mod.r2_configured() is True


def test_sync_cache_to_r2_uploads(tmp_path, monkeypatch):
    local = tmp_path / "abc.vaepack"
    local.write_bytes(b"PK\x03\x04")

    with patch("server.pack.r2_store.r2.r2_configured", return_value=True), \
         patch("server.pack.r2_store.r2.upload_file", return_value="packs/cache/abc123.vaepack") as up:
        from server.pack.r2_store import sync_cache_to_r2
        key = sync_cache_to_r2("abc123", local)
    assert key == "packs/cache/abc123.vaepack"
    up.assert_called_once()


def test_get_cached_pack_bytes_from_r2(tmp_path, monkeypatch):
    from server.pack.cache import get_cached_pack_bytes

    with patch("server.pack.r2_store.fetch_cache_from_r2", return_value=b"zipbytes"):
        out = get_cached_pack_bytes(tmp_path / "packs", "missing-local")
    assert out == b"zipbytes"
