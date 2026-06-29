"""Library pure logic + sidecar IO (stdlib only; no pydantic needed)."""
import os
import tempfile


def _fresh_library():
    d = tempfile.mkdtemp()
    os.environ["DATA_DIR"] = d
    import importlib
    from server.playback import library as L
    importlib.reload(L)
    return L


def test_imaging_progress_band():
    L = _fresh_library()
    assert L.imaging_progress(0, 4) == L.ANALYSIS_END
    assert L.imaging_progress(4, 4) == 1.0
    assert L.ANALYSIS_END < L.imaging_progress(2, 4) < 1.0
    assert L.imaging_progress(0, 0) == 1.0


def test_select_cover_priority():
    L = _fresh_library()
    assert L.select_cover({"cover": "/m/c.png"}) == "/m/c.png"
    assert L.select_cover({"backgrounds": {"s2": "/m/b2.png"}},
                          [{"id": "s1"}, {"id": "s2"}]) == "/m/b2.png"
    assert L.select_cover({"backgrounds": {}}, [{"id": "s1"}]) is None


def test_catalog_entry_counts_lines():
    L = _fresh_library()
    scenes = [{"id": "s1", "lines": [1, 2, 3]}, {"id": "s2", "lines": [4, 5]}]
    e = L.catalog_entry("bk", {"status": "processing", "progress": 0.5, "title": "T"},
                        {"backgrounds": {"s1": "/m/b.png"}}, len(scenes), scenes)
    assert e["lines"] == 5
    assert e["status"] == "processing" and e["progress"] == 0.5
    assert e["cover"] == "/m/b.png"


def test_status_media_resume_roundtrip():
    L = _fresh_library()
    L.write_status("bk", status="processing", stage="imaging", progress=0.6, title="My Book")
    s = L.read_status("bk")
    assert s["status"] == "processing" and s["title"] == "My Book"

    L.set_media("bk", "characters", "elara", "/m/e.png")
    L.set_media("bk", "cover", "cover", "/m/cover.png")
    m = L.read_media("bk")
    assert m["styles"]["semi-real"]["characters"]["elara"] == "/m/e.png"
    assert m["styles"]["semi-real"]["cover"] == "/m/cover.png"

    L.write_resume("bk", 7, "scene-0002", 2)
    r = L.read_resume("bk")
    assert r["line"] == 7 and r["sceneId"] == "scene-0002" and r["chapter"] == 2


def test_analysis_from_playback():
    L = _fresh_library()
    playback = {
        "book_id": "demo", "title": "Demo", "author": "A",
        "characters": {
            "hero": {"name": "Hero", "gender": "male", "importance": "primary",
                     "description": "A brave knight."},
        },
        "scenes": [{
            "id": "s1", "chapter": 1, "title": "Opening",
            "present": [{"character_id": "hero"}],
            "lines": [{"character_id": "hero", "text": "Hi.", "kind": "dialogue"}],
        }],
    }
    a = L.analysis_from_playback(playback)
    assert a.book_id == "demo"
    assert len(a.characters) == 1 and a.characters[0].id == "hero"
    assert a.scenes[0].background_desc == "Opening"


def test_release_imaging_lock_clears_stuck_regen():
    L = _fresh_library()
    L.write_status(
        "bk",
        status="ready",
        stage="imaging",
        progress=0.4,
        title="T",
        generating_style="anime",
    )
    L.write_media("bk", {"active": "anime", "styles": {"anime": {"complete": False, "characters": {"a": "/x"}}}})
    out = L.release_imaging_lock("bk")
    assert out["generating_style"] is None
    assert out["stage"] == "done"
    assert out["progress"] == 1.0
    m = L.read_media("bk")
    assert m["styles"]["anime"]["complete"] is True


def test_catalog_lists_processing_book():
    L = _fresh_library()
    L.write_status("bk", status="processing", stage="parsing", progress=0.1, title="WIP")
    cat = L.list_catalog()
    ids = {e["book_id"]: e for e in cat}
    assert "bk" in ids and ids["bk"]["status"] == "processing"


def test_catalog_ignores_voices_sidecar():
    L = _fresh_library()
    L.write_status("my-book", status="ready", stage="done", progress=1.0, title="Real Book")
    L.write_voice_overrides("my-book", {"narrator": {"source": "edge", "voice": "en-US-AvaNeural"}})
    ids = {e["book_id"] for e in L.list_catalog()}
    assert "my-book" in ids
    assert "my-book.voices" not in ids
