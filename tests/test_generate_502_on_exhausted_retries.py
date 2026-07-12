"""Regression test — /generate returns HTTP 502 when every quality-gate
retry attempt still shows the character-sheet grid artifact
(scripts/local-image-server/server.py).

Root cause of a real, confirmed-live bug: _generate_with_retry used to be
"best-effort — always return the last attempt, never raise." A specific
character ("Anne") reliably produced a 15-tile grid on EVERY one of 3
attempts, twice in a row across separate regen jobs — the old behavior
shipped that straight to the user as their committed portrait, with no
error anywhere in the pipeline to signal anything had gone wrong.
_generate_with_retry now raises GenerationQualityError after exhausting
retries; /generate converts that to HTTP 502 so the worker's existing
provider-fallback chain (freemium-image.js's generateImage, which already
treats any local_sd error as "try the next tier") gets a chance to use a
different provider instead of silently shipping known-broken art.

Never touches the actual diffusion pipeline — _load_pipeline and
_generate_with_retry are monkeypatched so this runs in milliseconds.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

_SERVER_PATH = Path(__file__).parent.parent / "scripts" / "local-image-server" / "server.py"
_spec = importlib.util.spec_from_file_location("local_image_server", _SERVER_PATH)
server = importlib.util.module_from_spec(_spec)
sys.modules["local_image_server"] = server
_spec.loader.exec_module(server)


class _FakePipe:
    def set_ip_adapter_scale(self, scale):
        pass


def test_exhausted_retries_surfaces_as_http_502(monkeypatch):
    monkeypatch.setattr(server, "_load_pipeline", lambda profile: _FakePipe())

    def always_fails(*args, **kwargs):
        raise server.GenerationQualityError("animagine-xl: still showed the grid artifact after 3 attempts")

    monkeypatch.setattr(server, "_generate_with_retry", always_fails)

    req = server.GenerateRequest(prompt="a character", model="animagine-xl")
    with pytest.raises(HTTPException) as exc_info:
        server.generate(req)

    assert exc_info.value.status_code == 502
