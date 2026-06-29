"""Internal queue webhook for Cloudflare pack builds."""
from __future__ import annotations

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from server.app import create_app  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("QUEUE_WEBHOOK_SECRET", "test-secret")
    from server.playback import library as L
    monkeypatch.setattr(L, "DATA_DIR", tmp_path)
    monkeypatch.setattr(L, "BOOKS_DIR", tmp_path / "books")
    books = tmp_path / "books"
    books.mkdir(parents=True)
    bid = "queue-test"
    (books / f"{bid}.json").write_text(
        '{"book_id":"queue-test","title":"Q","scenes":[{"id":"s1","lines":[{"idx":0,"text":"Hi"}]}]}',
        encoding="utf-8",
    )
    return TestClient(create_app())


def test_internal_health(client):
    r = client.get("/internal/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_queue_webhook_requires_secret(client):
    r = client.post("/internal/queue/pack-build", json={
        "job_id": "job1",
        "book_id": "queue-test",
        "tier": "visual",
    })
    assert r.status_code == 401


def test_queue_webhook_starts_job(client):
    r = client.post(
        "/internal/queue/pack-build",
        json={"job_id": "job1", "book_id": "queue-test", "tier": "visual"},
        headers={"X-Queue-Secret": "test-secret"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["job_id"] == "job1"
    assert body["status"] in ("done", "queued", "building")
