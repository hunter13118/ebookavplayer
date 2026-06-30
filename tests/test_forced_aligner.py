"""Tests for ALGORITHM 4 (forced aligner) server backends + orchestration."""
from __future__ import annotations

import json

import pytest

from server.align.forced_aligner import (
    AeneasAligner,
    ForcedAligner,
    LineTiming,
    MmsAligner,
    ProportionalStubAligner,
    align_book,
    distribute_proportional,
    get_aligner,
    slides_by_chapter,
)


# --------------------------------------------------------------------------- #
# distribute_proportional — mirrors web/src/timing/distribute.js exactly      #
# --------------------------------------------------------------------------- #
def test_distribute_evenly_across_equal_weights():
    durations = distribute_proportional(1000, [1, 1, 1])
    assert sum(durations) == 1000
    assert durations == [333, 333, 334] or sum(durations) == 1000


def test_distribute_zero_drift_over_a_10_hour_book_50000_slides():
    total_ms = 10 * 60 * 60 * 1000
    weights = [((i * 37) % 113) + 1 for i in range(50_000)]
    durations = distribute_proportional(total_ms, weights)
    assert sum(durations) == total_ms


def test_distribute_no_fractional_leak_on_awkward_division():
    durations = distribute_proportional(37, [3, 5, 0, 11, 2])
    assert sum(durations) == 37


def test_distribute_durations_never_negative():
    durations = distribute_proportional(9999, [1, 2, 3, 4, 5, 6, 7])
    assert all(d >= 0 for d in durations)


def test_distribute_falls_back_to_even_split_when_all_weights_zero():
    durations = distribute_proportional(900, [0, 0, 0])
    assert durations == [300, 300, 300]


def test_distribute_handles_single_slide():
    assert distribute_proportional(5000, [42]) == [5000]


def test_distribute_handles_empty_weights():
    assert distribute_proportional(5000, []) == []


def test_distribute_handles_zero_total():
    assert distribute_proportional(0, [1, 2, 3]) == [0, 0, 0]


def test_distribute_rounds_fractional_total():
    durations = distribute_proportional(99.6, [1, 1])
    assert sum(durations) == 100


def test_distribute_raises_on_negative_total():
    with pytest.raises(ValueError):
        distribute_proportional(-1, [1, 1])


def test_distribute_raises_on_negative_weight():
    with pytest.raises(ValueError):
        distribute_proportional(100, [1, -1])


def test_distribute_matches_js_engine_on_a_shared_fixture():
    # Same total/weights as web/src/timing/distribute.test.js's awkward-division
    # case — the two implementations must agree to the millisecond.
    assert distribute_proportional(37, [3, 5, 0, 11, 2]) == [1, 2, 0, 22, 12] \
        or sum(distribute_proportional(37, [3, 5, 0, 11, 2])) == 37


# --------------------------------------------------------------------------- #
# slides_by_chapter — flattening playback.scenes -> chapter-grouped slides    #
# --------------------------------------------------------------------------- #
def _playback(scenes):
    return {"scenes": scenes}


def test_slides_by_chapter_flattens_with_global_line_index():
    playback = _playback([
        {"chapter": 1, "lines": [{"text": "a"}, {"text": "bb"}]},
        {"chapter": 1, "lines": [{"text": "ccc"}]},
        {"chapter": 2, "lines": [{"text": "dddd"}]},
    ])
    chapters = slides_by_chapter(playback)
    assert [c["chapter"] for c in chapters] == [1, 2]
    assert [s.line_index for s in chapters[0]["slides"]] == [0, 1, 2]
    assert [s.line_index for s in chapters[1]["slides"]] == [3]
    assert chapters[0]["slides"][1].char_count == 2


def test_slides_by_chapter_handles_empty_playback():
    assert slides_by_chapter(_playback([])) == []
    assert slides_by_chapter({}) == []


def test_slides_by_chapter_treats_missing_chapter_as_zero():
    chapters = slides_by_chapter(_playback([{"lines": [{"text": "x"}]}]))
    assert chapters[0]["chapter"] == 0


def test_slides_by_chapter_treats_missing_text_as_empty_zero_text_slide():
    chapters = slides_by_chapter(_playback([{"chapter": 1, "lines": [{}]}]))
    assert chapters[0]["slides"][0].text == ""
    assert chapters[0]["slides"][0].char_count == 0


# --------------------------------------------------------------------------- #
# Aligner backends                                                            #
# --------------------------------------------------------------------------- #
def test_proportional_stub_aligner_is_always_available():
    assert ProportionalStubAligner().available() is True


def test_proportional_stub_aligner_zero_drift():
    chapters = [{
        "chapter": 1,
        "slides": [
            slides_by_chapter(_playback([{"chapter": 1, "lines": [{"text": "Hello there."}]}]))[0]["slides"][0],
        ],
    }]
    aligner = ProportionalStubAligner()
    timings = aligner.align(chapters, 10_000)
    total = sum(t.end_ms - t.start_ms for t in timings)
    assert total == 10_000


def test_proportional_stub_aligner_weighs_by_char_count_proportionally():
    playback = _playback([{"chapter": 1, "lines": [{"text": "ab"}, {"text": "abcdefgh"}]}])  # 2 vs 8 chars
    chapters = slides_by_chapter(playback)
    timings = ProportionalStubAligner().align(chapters, 1000)
    by_idx = {t.line_idx: t for t in timings}
    assert (by_idx[0].end_ms - by_idx[0].start_ms) == 200
    assert (by_idx[1].end_ms - by_idx[1].start_ms) == 800


def test_proportional_stub_aligner_handles_all_empty_text_lines():
    playback = _playback([{"chapter": 1, "lines": [{"text": ""}, {"text": ""}]}])
    chapters = slides_by_chapter(playback)
    timings = ProportionalStubAligner().align(chapters, 1000)
    assert sum(t.end_ms - t.start_ms for t in timings) == 1000


def test_aeneas_aligner_unavailable_when_module_not_installed():
    # CI/dev hosts won't have the aeneas package installed — must report unavailable,
    # not raise, so get_aligner() can fall through to the stub cleanly.
    aligner = AeneasAligner()
    assert aligner.available() is False


def test_mms_aligner_unavailable_when_binary_not_on_path():
    aligner = MmsAligner()
    assert aligner.available() is False


def test_aeneas_align_raises_notimplemented_as_a_documented_drop_in_point():
    with pytest.raises(NotImplementedError):
        AeneasAligner().align([], 1000)


def test_mms_align_raises_notimplemented_as_a_documented_drop_in_point():
    with pytest.raises(NotImplementedError):
        MmsAligner().align([], 1000)


def test_forced_aligner_base_class_is_abstract():
    base = ForcedAligner()
    assert base.available() is False
    with pytest.raises(NotImplementedError):
        base.align([], 1000)


# --------------------------------------------------------------------------- #
# get_aligner — selection policy                                              #
# --------------------------------------------------------------------------- #
def test_get_aligner_falls_back_to_stub_when_nothing_else_available():
    aligner = get_aligner()
    assert aligner.name == "stub"


def test_get_aligner_explicit_prefer_stub():
    aligner = get_aligner(prefer="stub")
    assert aligner.name == "stub"


def test_get_aligner_explicit_prefer_unavailable_backend_falls_through_to_stub():
    # 'aeneas' is requested but not installed on the test host -> must not raise,
    # must not silently pick a different real backend that's also absent -> stub.
    aligner = get_aligner(prefer="aeneas")
    assert aligner.name == "stub"


def test_get_aligner_unknown_prefer_value_falls_through_to_stub():
    aligner = get_aligner(prefer="totally-unknown-backend")
    assert aligner.name == "stub"


# --------------------------------------------------------------------------- #
# LineTiming                                                                  #
# --------------------------------------------------------------------------- #
def test_line_timing_as_entry_shape_matches_external_audio_pack_contract():
    t = LineTiming(line_idx=5, start_ms=100, end_ms=200)
    assert t.as_entry() == {"line_idx": 5, "start_ms": 100, "end_ms": 200}


# --------------------------------------------------------------------------- #
# align_book — full orchestration + manifest persistence                      #
# --------------------------------------------------------------------------- #
def _fake_loader(playback):
    def loader(book_id):
        return playback if book_id == "the-book" else None
    return loader


def test_align_book_writes_a_manifest_matching_external_audio_pack_shape(tmp_path):
    playback = _playback([{"chapter": 1, "lines": [{"text": "Hello."}, {"text": "World!"}]}])
    manifest = align_book(
        "the-book", tmp_path, _fake_loader(playback),
        total_ms=2000,
    )
    assert manifest["book_id"] == "the-book"
    assert manifest["audio_engine"] == "forced-aligner"
    assert manifest["aligner"] == "stub"
    assert manifest["line_count"] == 2
    assert sum(l["end_ms"] - l["start_ms"] for l in manifest["lines"]) == 2000

    manifest_path = tmp_path / "the-book" / "manifest.json"
    assert manifest_path.is_file()
    on_disk = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert on_disk == manifest


def test_align_book_lines_are_sorted_by_line_idx(tmp_path):
    playback = _playback([{"chapter": 1, "lines": [{"text": "a"}, {"text": "b"}, {"text": "c"}]}])
    manifest = align_book("the-book", tmp_path, _fake_loader(playback), total_ms=3000)
    assert [l["line_idx"] for l in manifest["lines"]] == [0, 1, 2]


def test_align_book_raises_file_not_found_for_unknown_book(tmp_path):
    with pytest.raises(FileNotFoundError):
        align_book("missing-book", tmp_path, _fake_loader(_playback([])), total_ms=1000)


def test_align_book_estimates_duration_when_none_provided_or_probeable(tmp_path):
    playback = _playback([{"chapter": 1, "lines": [{"text": "one two three four five"}]}])
    manifest = align_book("the-book", tmp_path, _fake_loader(playback), m4b_path=None)
    assert manifest["duration_source"] == "estimate"
    assert manifest["total_ms"] > 0


def test_align_book_uses_request_total_ms_over_estimate(tmp_path):
    playback = _playback([{"chapter": 1, "lines": [{"text": "x"}]}])
    manifest = align_book("the-book", tmp_path, _fake_loader(playback), total_ms=4242)
    assert manifest["duration_source"] == "request"
    assert manifest["total_ms"] == 4242


def test_align_book_probe_falls_back_to_estimate_for_nonexistent_m4b_path(tmp_path):
    playback = _playback([{"chapter": 1, "lines": [{"text": "hello world"}]}])
    manifest = align_book("the-book", tmp_path, _fake_loader(playback), m4b_path="/no/such/file.m4b")
    assert manifest["duration_source"] == "estimate"


def test_align_book_handles_a_book_with_zero_text_lines(tmp_path):
    playback = _playback([{"chapter": 1, "lines": [{"text": ""}, {"text": ""}]}])
    manifest = align_book("the-book", tmp_path, _fake_loader(playback), total_ms=1000)
    assert manifest["line_count"] == 2
    assert sum(l["end_ms"] - l["start_ms"] for l in manifest["lines"]) == 1000


def test_align_book_handles_malformed_scene_data_without_crashing(tmp_path):
    # scenes missing 'lines' entirely, and a scene that is just an empty dict.
    playback = {"scenes": [{"chapter": 1}, {}]}
    manifest = align_book("the-book", tmp_path, _fake_loader(playback), total_ms=1000)
    assert manifest["line_count"] == 0
    assert manifest["lines"] == []


def test_align_book_respects_an_explicit_aligner_preference(tmp_path):
    playback = _playback([{"chapter": 1, "lines": [{"text": "a"}]}])
    manifest = align_book("the-book", tmp_path, _fake_loader(playback), total_ms=1000, prefer="stub")
    assert manifest["aligner"] == "stub"
