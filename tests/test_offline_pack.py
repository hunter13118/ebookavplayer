"""Offline pack API routes, import, synth, and audiobook tier tests."""
from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from server.app import create_app  # noqa: E402
from server.pack.build import (
    build_pack_bytes,
    import_pack_to_server,
    read_pack_manifest,
)
from server.pack import format as F
from server.pack.synth import synthesize_line_mp3, _apply_voice_override, _apply_voice_override


@pytest.fixture
def data_env(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    from server.playback import library as L

    monkeypatch.setattr(L, "DATA_DIR", tmp_path)
    monkeypatch.setattr(L, "BOOKS_DIR", tmp_path / "books")
    books = tmp_path / "books"
    books.mkdir(parents=True)
    return tmp_path, books, L


@pytest.fixture
def ready_book(data_env):
    tmp_path, books, L = data_env
    bid = "pack-route-test"
    book_json = {
        "book_id": bid,
        "title": "Pack Route",
        "author": "QA",
        "scenes": [{
            "id": "s1",
            "background": f"/media/{bid}/semi-real/bg.png",
            "lines": [{"idx": 0, "text": "Line.", "character_id": "narrator"}],
        }],
    }
    (books / f"{bid}.json").write_text(json.dumps(book_json), encoding="utf-8")
    (books / f"{bid}.status.json").write_text(
        json.dumps({"status": "ready", "stage": "done", "progress": 1.0, "art_style": "semi-real"}),
        encoding="utf-8",
    )
    media = tmp_path / "media" / bid / "semi-real"
    media.mkdir(parents=True)
    (media / "bg.png").write_bytes(b"\x89PNG")
    return bid, book_json


@pytest.fixture
def client(data_env):
    return TestClient(create_app())


def test_format_constants():
    assert F.FORMAT_ID == "vae-offline-pack"
    assert F.TIER_VISUAL in F.VALID_TIERS
    assert F.MANIFEST_NAME.startswith("vae/")


def test_apply_voice_override_edge():
    line = {"character_id": "elara", "text": "Hi", "voice": "default-v"}
    overrides = {"characters": {"elara": {"source": "edge", "voice": "en-US-JennyNeural", "pitch": "+5Hz"}}}
    out = _apply_voice_override(line, overrides)
    assert out["voice"] == "en-US-JennyNeural"
    assert out["pitch"] == "+5Hz"


@pytest.mark.parametrize("_", [0])
def test_build_audiobook_pack_with_mock_synth(tmp_path, monkeypatch, _):
    async def run():
        monkeypatch.setenv("DATA_DIR", str(tmp_path))
        book = {
            "book_id": "audio-demo",
            "title": "Audio",
            "scenes": [{"id": "s1", "lines": [
                {"idx": 0, "text": "One.", "character_id": "narrator"},
                {"idx": 1, "text": "", "character_id": "narrator"},
                {"idx": 2, "text": "Two.", "character_id": "narrator"},
            ]}],
        }

        async def fake_synth(line, _voices):
            if line.get("idx") == 0:
                return b"mp3-a"
            if line.get("idx") == 2:
                return b"mp3-b"
            return None

        raw = await build_pack_bytes(
            book, tier=F.TIER_AUDIOBOOK, style="semi-real", synthesize_line=fake_synth,
        )
        manifest = read_pack_manifest(raw)
        assert manifest["tier"] == F.TIER_AUDIOBOOK
        assert manifest["audio_line_count"] == 2
        assert manifest["audio_engine"] == F.AUDIO_ENGINE_EDGE

        with zipfile.ZipFile(io.BytesIO(raw), "r") as zf:
            audio_manifest = json.loads(zf.read(F.AUDIO_MANIFEST_NAME))
            assert len(audio_manifest) == 2
            assert zf.read(f"{F.AUDIO_PREFIX}000000.mp3") == b"mp3-a"

    import asyncio
    asyncio.run(run())


def test_build_pack_invalid_tier():
    async def run():
        with pytest.raises(ValueError, match="invalid tier"):
            await build_pack_bytes({"book_id": "x", "scenes": []}, tier="nope", style="semi-real")

    import asyncio
    asyncio.run(run())


def test_build_pack_resume_embedded(tmp_path, monkeypatch):
    async def run():
        monkeypatch.setenv("DATA_DIR", str(tmp_path))
        book = {"book_id": "r", "title": "R", "scenes": [{"id": "s", "lines": []}]}
        raw = await build_pack_bytes(
            book, tier=F.TIER_VISUAL, style="anime",
            resume={"line": 3, "sceneId": "s", "chapter": 1},
        )
        with zipfile.ZipFile(io.BytesIO(raw), "r") as zf:
            saved = json.loads(zf.read(F.BOOK_NAME))
            assert saved["resume"]["line"] == 3

    import asyncio
    asyncio.run(run())


def test_import_pack_to_server(tmp_path):
    async def run():
        book = {
            "book_id": "import-me",
            "title": "Import",
            "scenes": [{
                "id": "s1",
                "background": "/media/import-me/anime/bg.png",
                "lines": [{"idx": 0, "text": "Hi"}],
            }],
        }
        media_root = tmp_path / "media"
        media_root.mkdir(parents=True)
        (media_root / "import-me" / "anime").mkdir(parents=True)
        (media_root / "import-me" / "anime" / "bg.png").write_bytes(b"PNG")

        raw = await build_pack_bytes(book, tier=F.TIER_VISUAL, style="anime")
        books_dir = tmp_path / "books"
        books_dir.mkdir()
        out = import_pack_to_server(raw, media_root=media_root, books_dir=books_dir)
        assert out["book_id"] == "import-me"
        assert (books_dir / "import-me.json").is_file()
        assert (media_root / "import-me" / "anime" / "bg.png").read_bytes() == b"PNG"

    import asyncio
    asyncio.run(run())


def test_download_pack_route(client, ready_book):
    bid, _ = ready_book
    r = client.get(f"/books/{bid}/pack?tier=visual")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"
    manifest = read_pack_manifest(r.content)
    assert manifest["book_id"] == bid
    assert manifest["tier"] == F.TIER_VISUAL


def test_download_pack_audiobook_route(client, ready_book):
    bid, _ = ready_book
    with patch("server.pack.synth.synthesize_line_mp3", new_callable=AsyncMock) as mock:
        mock.return_value = b"\xff\xfb"
        r = client.get(f"/books/{bid}/pack?tier=audiobook")
    assert r.status_code == 200
    manifest = read_pack_manifest(r.content)
    assert manifest["tier"] == F.TIER_AUDIOBOOK
    assert mock.await_count >= 1


def test_download_pack_rejects_processing(client, data_env, ready_book):
    bid, _ = ready_book
    _, books, _ = data_env
    (books / f"{bid}.status.json").write_text(
        json.dumps({"status": "processing", "stage": "imaging", "progress": 0.5}),
        encoding="utf-8",
    )
    r = client.get(f"/books/{bid}/pack?tier=visual")
    assert r.status_code == 409


def test_download_pack_unknown_book(client):
    r = client.get("/books/no-such-book/pack?tier=visual")
    assert r.status_code == 404


def test_import_pack_route(client, ready_book):
    bid, book_json = ready_book
    async def run():
        return await build_pack_bytes(book_json, tier=F.TIER_VISUAL, style="semi-real")

    import asyncio
    raw = asyncio.run(run())
    r = client.post(
        f"/books/{bid}/pack/import",
        files={"file": ("test.vaepack", raw, "application/zip")},
    )
    assert r.status_code == 200
    assert r.json()["book_id"] == bid


def test_import_pack_route_rejects_mismatch(client, ready_book):
    bid, book_json = ready_book
    book_json = {**book_json, "book_id": "other-id"}
    async def run():
        return await build_pack_bytes(book_json, tier=F.TIER_VISUAL, style="semi-real")

    import asyncio
    raw = asyncio.run(run())
    r = client.post(
        f"/books/{bid}/pack/import",
        files={"file": ("test.vaepack", raw, "application/zip")},
    )
    assert r.status_code == 400


def test_start_pack_build_job(client, ready_book, tmp_path, monkeypatch):
    bid, _ = ready_book
    monkeypatch.setattr("server.app.PACKS_DIR", tmp_path / "packs")
    with patch("server.pack.synth.synthesize_line_mp3", new_callable=AsyncMock) as mock:
        mock.return_value = b"\xff\xfb"
        r = client.post(f"/books/{bid}/pack/build", json={"tier": F.TIER_AUDIOBOOK})
    assert r.status_code == 200
    job_id = r.json()["job_id"]
    assert job_id

    import time
    deadline = time.time() + 10
    status = r.json()
    while time.time() < deadline and status.get("status") not in ("done", "error"):
        time.sleep(0.05)
        status = client.get(f"/books/{bid}/pack/build/{job_id}").json()
    assert status["status"] == "done"
    assert status["ready"] is True

    dl = client.get(f"/books/{bid}/pack/build/{job_id}/file")
    assert dl.status_code == 200
    manifest = read_pack_manifest(dl.content)
    assert manifest["tier"] == F.TIER_AUDIOBOOK


def test_pack_build_file_not_ready(client, ready_book):
    bid, _ = ready_book
    with patch("server.pack.jobs._run_pack_build", lambda *a, **k: None):
        r = client.post(f"/books/{bid}/pack/build", json={"tier": F.TIER_VISUAL})
    job_id = r.json()["job_id"]
    r2 = client.get(f"/books/{bid}/pack/build/{job_id}/file")
    assert r2.status_code == 409


def test_pack_build_unknown_job(client, ready_book):
    bid, _ = ready_book
    r = client.get(f"/books/{bid}/pack/build/no-such-job")
    assert r.status_code == 404


@pytest.mark.parametrize("_", [0])
def test_synthesize_line_mp3_empty_text(_, monkeypatch):
    async def run():
        out = await synthesize_line_mp3({"text": "   "}, {})
        assert out is None

    import asyncio
    asyncio.run(run())


def test_cache_key_changes_with_voices():
    from server.pack.cache import compute_cache_key

    book = {"book_id": "b", "scenes": [{"lines": [{"idx": 0, "text": "Hi"}]}]}
    k1 = compute_cache_key("b", F.TIER_AUDIOBOOK, "anime", book, {})
    k2 = compute_cache_key("b", F.TIER_AUDIOBOOK, "anime", book, {"narrator": {"voice": "x"}})
    assert k1 != k2


def test_pack_build_cache_hit(client, ready_book, tmp_path, monkeypatch):
    bid, _ = ready_book
    packs = tmp_path / "packs"
    monkeypatch.setattr("server.app.PACKS_DIR", packs)
    with patch("server.pack.synth.synthesize_line_mp3", new_callable=AsyncMock) as mock:
        mock.return_value = b"\xff\xfb"
        r1 = client.post(f"/books/{bid}/pack/build", json={"tier": F.TIER_AUDIOBOOK})
    assert r1.status_code == 200
    job_id = r1.json()["job_id"]
    import time
    deadline = time.time() + 10
    status = r1.json()
    while time.time() < deadline and status.get("status") != "done":
        time.sleep(0.05)
        status = client.get(f"/books/{bid}/pack/build/{job_id}").json()
    assert status["status"] == "done"
    with patch("server.pack.synth.synthesize_line_mp3", new_callable=AsyncMock) as mock2:
        mock2.return_value = b"\xff\xfb"
        r2 = client.post(f"/books/{bid}/pack/build", json={"tier": F.TIER_AUDIOBOOK})
    assert r2.json()["cached"] is True
    assert r2.json()["status"] == "done"
    assert mock2.await_count == 0


def test_pack_build_force_bypasses_cache(client, ready_book, tmp_path, monkeypatch):
    bid, _ = ready_book
    packs = tmp_path / "packs"
    monkeypatch.setattr("server.app.PACKS_DIR", packs)
    with patch("server.pack.synth.synthesize_line_mp3", new_callable=AsyncMock) as mock:
        mock.return_value = b"\xff\xfb"
        r1 = client.post(f"/books/{bid}/pack/build", json={"tier": F.TIER_AUDIOBOOK})
        job_id = r1.json()["job_id"]
        import time
        deadline = time.time() + 10
        status = r1.json()
        while time.time() < deadline and status.get("status") != "done":
            time.sleep(0.05)
            status = client.get(f"/books/{bid}/pack/build/{job_id}").json()
        r = client.post(f"/books/{bid}/pack/build", json={"tier": F.TIER_AUDIOBOOK, "force": True})
    assert r.json()["cached"] is False


def test_cancel_pack_build(client, ready_book, tmp_path, monkeypatch):
    bid, _ = ready_book
    monkeypatch.setattr("server.app.PACKS_DIR", tmp_path / "packs")

    async def slow_build(*args, **kwargs):
        import asyncio
        await asyncio.sleep(3)
        return b"PK"

    with patch("server.pack.build.build_pack_bytes", side_effect=slow_build):
        r = client.post(f"/books/{bid}/pack/build", json={"tier": F.TIER_VISUAL, "force": True})
    job_id = r.json()["job_id"]
    import time
    time.sleep(0.1)
    cancel = client.post(f"/books/{bid}/pack/build/{job_id}/cancel")
    assert cancel.status_code == 200
    assert cancel.json()["status"] == "cancelled"


def test_external_audio_import_and_build(client, ready_book, tmp_path, monkeypatch):
    bid, book_json = ready_book
    audio_root = tmp_path / "audio"
    packs = tmp_path / "packs"
    monkeypatch.setattr("server.app.AUDIO_DIR", audio_root)
    monkeypatch.setattr("server.app.PACKS_DIR", packs)

    import zipfile
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("000000.mp3", b"\xff\xfb\x90")
    buf.seek(0)

    imp = client.post(
        f"/books/{bid}/audio/import",
        files={"file": ("audio.zip", buf.read(), "application/zip")},
    )
    assert imp.status_code == 200
    assert imp.json()["line_count"] == 1

    man = client.get(f"/books/{bid}/audio/manifest")
    assert man.json()["available"] is True

    with patch("server.pack.synth.synthesize_line_mp3", new_callable=AsyncMock) as mock:
        mock.return_value = b"\xff\xfb"
        r = client.post(f"/books/{bid}/pack/build", json={"tier": F.TIER_AUDIOBOOK, "force": True})
    job_id = r.json()["job_id"]
    import time
    deadline = time.time() + 10
    status = r.json()
    while time.time() < deadline and status.get("status") not in ("done", "error"):
        time.sleep(0.05)
        status = client.get(f"/books/{bid}/pack/build/{job_id}").json()
    assert status["status"] == "done"
    assert status["audio_source"] == F.AUDIO_ENGINE_EXTERNAL
    assert mock.await_count == 0

    dl = client.get(f"/books/{bid}/pack/build/{job_id}/file")
    manifest = read_pack_manifest(dl.content)
    assert manifest["audio_engine"] == F.AUDIO_ENGINE_EXTERNAL

