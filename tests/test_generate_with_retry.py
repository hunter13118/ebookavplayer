"""Regression test — _generate_with_retry (scripts/local-image-server/server.py).

Fix for the "character sheet" tiled-grid artifact confirmed live on real
generations (see detect_and_crop_faces.py's _crop_is_text_heavy docstring
and docs/LOCAL_IMAGE_GEN.md): a face count >1 in a generated portrait is a
direct signature of the bug, so retry generation when it's detected instead
of only trying to prevent every root cause via prompting.

The quality-gate/retry loop only runs when a reference_image is passed (see
_generate_with_retry's docstring) — the artifact has only ever been observed
under IP-Adapter conditioning, and running it unconditionally was confirmed
live to fire the (expensive, Ollama-backed) grid check on background/scene
generations that have nothing to do with this bug. Tests below pass a
placeholder reference_image string to exercise the retry path; the dedicated
no-reference test at the bottom covers the skip path.

This test never touches the actual diffusion pipeline — _run and
_face_count are monkeypatched so it runs in milliseconds and doesn't need a
GPU/MPS device or a downloaded model.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

# Loaded under an unambiguous name — plain `import server` collides with the
# unrelated top-level `server/` package (the legacy Python pipeline) once
# both are imported in the same pytest session, since Python caches modules
# by name in sys.modules regardless of sys.path ordering.
_SERVER_PATH = Path(__file__).parent.parent / "scripts" / "local-image-server" / "server.py"
_spec = importlib.util.spec_from_file_location("local_image_server", _SERVER_PATH)
server = importlib.util.module_from_spec(_spec)
sys.modules["local_image_server"] = server  # required before exec: server.py's @dataclass
# lookups (ModelProfile) resolve their own module via sys.modules[cls.__module__]
_spec.loader.exec_module(server)


class _FakeProfile:
    """Retry-path logging reads profile.id — a real ModelProfile isn't
    needed since _run/_face_count are both monkeypatched."""
    id = "fake-profile"


def test_returns_immediately_on_single_face(monkeypatch):
    calls = []

    def fake_run(pipe, profile, prompts, width, height, reference_image=None):
        calls.append(1)
        return [f"image-{len(calls)}"]

    monkeypatch.setattr(server, "_run", fake_run)
    monkeypatch.setattr(server, "_face_count", lambda img: 1)
    monkeypatch.setattr(server, "_looks_like_grid", lambda img: False)

    result = server._generate_with_retry(None, _FakeProfile(), "prompt", 832, 1216, reference_image="fake-ref")
    assert result == "image-1"
    assert len(calls) == 1, "must not retry when the first attempt is already clean"


def test_retries_on_multi_face_then_succeeds(monkeypatch):
    calls = []
    face_counts = [9, 1]  # first attempt: grid artifact; second: clean

    def fake_run(pipe, profile, prompts, width, height, reference_image=None):
        calls.append(1)
        return [f"image-{len(calls)}"]

    monkeypatch.setattr(server, "_run", fake_run)
    monkeypatch.setattr(server, "_face_count", lambda img: face_counts[len(calls) - 1])
    monkeypatch.setattr(server, "_looks_like_grid", lambda img: False)

    result = server._generate_with_retry(None, _FakeProfile(), "prompt", 832, 1216, reference_image="fake-ref")
    assert result == "image-2"
    assert len(calls) == 2


def test_gives_up_after_max_retries_and_raises(monkeypatch):
    # Root cause of a real, confirmed-live bug: this used to be "best-effort
    # — always return the last attempt, never raise" — reversed after a
    # specific character ("Anne") reliably produced a 15-tile grid on
    # EVERY one of 3 attempts, twice in a row, and the old behavior shipped
    # that straight to the user as their committed portrait. Raising here
    # lets /generate turn it into an HTTP error the worker's provider
    # fallback chain already knows how to react to (try the next tier)
    # instead of silently shipping known-broken art.
    calls = []

    def fake_run(pipe, profile, prompts, width, height, reference_image=None):
        calls.append(1)
        return [f"image-{len(calls)}"]

    monkeypatch.setattr(server, "_run", fake_run)
    monkeypatch.setattr(server, "_face_count", lambda img: 15)  # always broken
    monkeypatch.setattr(server, "_looks_like_grid", lambda img: False)

    with pytest.raises(server.GenerationQualityError):
        server._generate_with_retry(None, _FakeProfile(), "prompt", 832, 1216, reference_image="fake-ref")
    # Bounded — never loops forever even though it never finds a clean result.
    assert len(calls) == server.MAX_MULTI_FACE_RETRIES + 1


def test_none_face_count_is_treated_as_acceptable(monkeypatch):
    # _face_count returns None when the cascade itself is unavailable —
    # must not be treated as "many faces detected", or every generation on
    # a machine without the cascade file would retry to exhaustion.
    calls = []

    def fake_run(pipe, profile, prompts, width, height, reference_image=None):
        calls.append(1)
        return ["only-image"]

    monkeypatch.setattr(server, "_run", fake_run)
    monkeypatch.setattr(server, "_face_count", lambda img: None)
    monkeypatch.setattr(server, "_looks_like_grid", lambda img: False)

    result = server._generate_with_retry(None, _FakeProfile(), "prompt", 832, 1216, reference_image="fake-ref")
    assert result == "only-image"
    assert len(calls) == 1


def test_retries_when_grid_detected_even_if_face_count_says_clean(monkeypatch):
    # Root cause of a real, confirmed-live bug: _face_count under-counts
    # badly on real grid outputs (an 8-tile grid scored "faces=1"), so a
    # still-broken image would previously sail through the gate. This is
    # the case _looks_like_grid exists to catch — it must retry even when
    # _face_count reports "clean".
    calls = []
    grid_flags = [True, False]  # first attempt: grid the face count missed; second: clean

    def fake_run(pipe, profile, prompts, width, height, reference_image=None):
        calls.append(1)
        return [f"image-{len(calls)}"]

    monkeypatch.setattr(server, "_run", fake_run)
    monkeypatch.setattr(server, "_face_count", lambda img: 1)  # always reports "clean"
    monkeypatch.setattr(server, "_looks_like_grid", lambda img: grid_flags[len(calls) - 1])

    result = server._generate_with_retry(None, _FakeProfile(), "prompt", 832, 1216, reference_image="fake-ref")
    assert result == "image-2"
    assert len(calls) == 2


def test_no_reference_image_skips_the_check_entirely(monkeypatch):
    # Root cause of a real, confirmed-live bug: the quality gate used to run
    # unconditionally, so it flagged a background scene generation (no
    # reference, never subject to this artifact) as a grid and burned 3x
    # its generation time on retries. Backgrounds/scenes/covers never pass
    # reference_image, so this must return after exactly one _run call and
    # never touch _face_count/_looks_like_grid at all.
    calls = []
    gate_calls = []

    def fake_run(pipe, profile, prompts, width, height, reference_image=None):
        calls.append(1)
        return ["bg-image"]

    monkeypatch.setattr(server, "_run", fake_run)
    monkeypatch.setattr(server, "_face_count", lambda img: gate_calls.append("face_count"))
    monkeypatch.setattr(server, "_looks_like_grid", lambda img: gate_calls.append("looks_like_grid"))

    result = server._generate_with_retry(None, _FakeProfile(), "prompt", 832, 1216, reference_image=None)
    assert result == "bg-image"
    assert len(calls) == 1
    assert gate_calls == [], "quality gate must not run at all without a reference image"


def test_check_quality_true_still_gates_even_with_no_reference_image(monkeypatch):
    # Root cause of a real, confirmed-live bug: /generate's guard rejects a
    # reference image that _looks_like_grid flags as broken (see that
    # endpoint's docstring), which sets reference_image back to None before
    # calling _generate_with_retry. Inferring check_quality purely from
    # "is reference_image set" would then skip the quality gate on exactly
    # the request that needs it most — a character portrait whose bad
    # reference just got stripped still needs its OUTPUT checked, since
    # animagine-xl has its own base-model tendency toward multi-character
    # "character sheet" compositions independent of IP-Adapter (confirmed
    # live: a fully unconditioned generation came back as a 5-face "queen
    # and four attendants" illustration). check_quality=True must override
    # the reference_image-based default.
    calls = []
    grid_flags = [True, False]

    def fake_run(pipe, profile, prompts, width, height, reference_image=None):
        calls.append(1)
        return [f"image-{len(calls)}"]

    monkeypatch.setattr(server, "_run", fake_run)
    monkeypatch.setattr(server, "_face_count", lambda img: 1)
    monkeypatch.setattr(server, "_looks_like_grid", lambda img: grid_flags[len(calls) - 1])

    result = server._generate_with_retry(
        None, _FakeProfile(), "prompt", 832, 1216, reference_image=None, check_quality=True,
    )
    assert result == "image-2"
    assert len(calls) == 2
