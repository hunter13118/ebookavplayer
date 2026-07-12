"""Regression test — /generate rejects a broken-grid reference image
(scripts/local-image-server/server.py).

Root cause of a real, confirmed-live bug: worker/_shared/reference-images.js
falls back to a character's own CURRENT LIVE SPRITE as its highest-priority
IP-Adapter reference whenever no explicit reference crop is assigned. If
that sprite is itself a broken "character sheet" grid — the exact artifact
_generate_with_retry guards against on the OUTPUT side — IP-Adapter
faithfully reproduces its tiled layout on the next generation too. Every
regen conditioned on the prior regen's defect, so the artifact never
cleared no matter how many times the user retried (confirmed live: this was
happening for every affected character, including after several unrelated
mitigations). /generate now runs the same _looks_like_grid check against an
incoming reference image and drops it (falls back to unconditioned
generation) rather than using it.

Never touches the actual diffusion pipeline — _load_pipeline and
_generate_with_retry are monkeypatched so this runs in milliseconds.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

from PIL import Image

_SERVER_PATH = Path(__file__).parent.parent / "scripts" / "local-image-server" / "server.py"
_spec = importlib.util.spec_from_file_location("local_image_server", _SERVER_PATH)
server = importlib.util.module_from_spec(_spec)
sys.modules["local_image_server"] = server
_spec.loader.exec_module(server)

import base64  # noqa: E402
import io  # noqa: E402


def _b64_png(size=(64, 64), color=(200, 180, 160)):
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


class _FakePipe:
    def set_ip_adapter_scale(self, scale):
        pass


def test_reference_flagged_as_grid_is_dropped(monkeypatch):
    captured = {}

    monkeypatch.setattr(server, "_load_pipeline", lambda profile: _FakePipe())
    monkeypatch.setattr(server, "_looks_like_grid", lambda img: True)

    def fake_generate_with_retry(pipe, profile, prompt, width, height, reference_image=None, check_quality=None):
        captured["reference_image"] = reference_image
        captured["check_quality"] = check_quality
        return Image.new("RGB", (width, height))

    monkeypatch.setattr(server, "_generate_with_retry", fake_generate_with_retry)

    req = server.GenerateRequest(prompt="a character", model="animagine-xl", reference_image_b64=_b64_png())
    server.generate(req)

    assert captured["reference_image"] is None, \
        "a reference flagged as a broken grid must not reach the diffusion pipeline"
    # Root cause of a real, confirmed-live bug: a rejected reference must
    # still force the output quality gate on — see
    # test_generate_with_retry.py's test_check_quality_true_still_gates...
    # for why (animagine-xl's base-model multi-character tendency isn't
    # solely an IP-Adapter artifact).
    assert captured["check_quality"] is True, \
        "a request that originally asked for a reference must still be quality-gated, even after rejection"


def test_force_reference_bypasses_the_grid_check(monkeypatch):
    # Manual override: the grid classifier is a heuristic, not infallible —
    # a user who's looked at their character's current image and confirmed
    # it's actually fine (a false positive) needs a way to force it through.
    captured = {}

    monkeypatch.setattr(server, "_load_pipeline", lambda profile: _FakePipe())
    monkeypatch.setattr(server, "_looks_like_grid", lambda img: True)  # would normally reject

    def fake_generate_with_retry(pipe, profile, prompt, width, height, reference_image=None, check_quality=None):
        captured["reference_image"] = reference_image
        return Image.new("RGB", (width, height))

    monkeypatch.setattr(server, "_generate_with_retry", fake_generate_with_retry)

    req = server.GenerateRequest(
        prompt="a character", model="animagine-xl", reference_image_b64=_b64_png(), force_reference=True,
    )
    server.generate(req)

    assert captured["reference_image"] is not None, \
        "force_reference=True must skip the broken-grid check and use the reference anyway"


def test_clean_reference_is_kept(monkeypatch):
    captured = {}

    monkeypatch.setattr(server, "_load_pipeline", lambda profile: _FakePipe())
    monkeypatch.setattr(server, "_looks_like_grid", lambda img: False)

    def fake_generate_with_retry(pipe, profile, prompt, width, height, reference_image=None, check_quality=None):
        captured["reference_image"] = reference_image
        return Image.new("RGB", (width, height))

    monkeypatch.setattr(server, "_generate_with_retry", fake_generate_with_retry)

    req = server.GenerateRequest(prompt="a character", model="animagine-xl", reference_image_b64=_b64_png())
    server.generate(req)

    assert captured["reference_image"] is not None, \
        "a clean reference must still be used for IP-Adapter conditioning"
