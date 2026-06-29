"""generate-media should return immediately (background thread)."""
from __future__ import annotations

import time
from unittest.mock import patch

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from server.app import create_app  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    from server.playback import library as L
    monkeypatch.setattr(L, "DATA_DIR", tmp_path)
    monkeypatch.setattr(L, "BOOKS_DIR", tmp_path / "books")
    books = tmp_path / "books"
    books.mkdir(parents=True)
    bid = "timeout-test"
    (books / f"{bid}.analysis.json").write_text(
        '{"book_id":"timeout-test","title":"T","characters":[],"scenes":[]}',
        encoding="utf-8",
    )
    return TestClient(create_app()), bid


def test_generate_media_post_returns_under_one_second(client):
    tc, bid = client
    with patch("server.app._run_generate_media"):
        t0 = time.time()
        r = tc.post(
            f"/books/{bid}/generate-media",
            json={
                "scope": "selected",
                "force_all": False,
                "character_ids": ["mei"],
                "compare": True,
                "ignore_pins": True,
            },
        )
        elapsed = time.time() - t0
    assert r.status_code == 200
    assert r.json().get("job_id")
    assert elapsed < 1.0
