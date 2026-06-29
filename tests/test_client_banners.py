"""Client-facing banner filtering."""
from server.playback.library import client_banners


def test_client_banners_hidden_when_done():
    assert client_banners({"stage": "done", "progress": 1.0, "banners": [{"id": "a"}]}) == []


def test_client_banners_latest_only_while_processing():
    banners = [{"id": "a"}, {"id": "b"}]
    out = client_banners({"stage": "imaging", "progress": 0.5, "banners": banners})
    assert out == [{"id": "b"}]
