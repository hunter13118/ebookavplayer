"""
Tests for scripts/local-align-server/server.py's pure matching logic — no
model loading, no network, no audio. Loaded via importlib because the
directory name has a hyphen (not a valid Python package path).

Covers IncrementalAligner: cross-chunk state that lets the server stream
newly-resolved lines back to the client the moment each transcription chunk
completes, instead of buffering the whole book before returning anything.

Regression coverage for the false-positive bug found against a real
audiobook: a publisher intro ("This is Audible.") coincidentally shares
common words with an unrelated book line ("In this world, there is a
forest..."), and a naive word-diff matcher anchored the book line to the
INTRO's timestamp instead of leaving it unmatched. See MIN_ANCHOR_BLOCK_WORDS.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_SERVER_PATH = Path(__file__).resolve().parents[1] / "scripts" / "local-align-server" / "server.py"
_spec = importlib.util.spec_from_file_location("local_align_server", _SERVER_PATH)
if _spec is None or _spec.loader is None:
    pytest.skip("local-align-server/server.py not found", allow_module_level=True)
local_align_server = importlib.util.module_from_spec(_spec)
try:
    _spec.loader.exec_module(local_align_server)
except ImportError:
    pytest.skip("torch/whisperx not installed in this environment", allow_module_level=True)

_normalize_words = local_align_server._normalize_words
IncrementalAligner = local_align_server.IncrementalAligner
_chunk_bounds = local_align_server._chunk_bounds


def word(text, start_s, end_s):
    return {"word": text, "start": start_s, "end": end_s}


def test_normalize_words_lowercases_and_strips_punctuation():
    assert _normalize_words("This place is called the Black Forest.") == [
        "this", "place", "is", "called", "the", "black", "forest",
    ]


def test_normalize_words_handles_empty_and_punctuation_only():
    assert _normalize_words("") == []
    assert _normalize_words("—!?") == []


def test_chunk_bounds_uses_a_small_first_window_then_the_regular_size():
    # 3-min first chunk, 10-min regular chunks, 25-min total book.
    orig_first, orig_regular = local_align_server.FIRST_CHUNK_MS, local_align_server.CHUNK_MS
    try:
        local_align_server.FIRST_CHUNK_MS = 3 * 60 * 1000
        local_align_server.CHUNK_MS = 10 * 60 * 1000
        bounds = _chunk_bounds(25 * 60 * 1000)
    finally:
        local_align_server.FIRST_CHUNK_MS, local_align_server.CHUNK_MS = orig_first, orig_regular
    assert bounds == [
        (0, 3 * 60 * 1000),
        (3 * 60 * 1000, 13 * 60 * 1000),
        (13 * 60 * 1000, 23 * 60 * 1000),
        (23 * 60 * 1000, 25 * 60 * 1000),
    ]


def test_chunk_bounds_resumes_from_an_offset_skipping_the_first_window():
    # A resumed run has already covered [0, resume_ms) in a prior call — it
    # should pick up with regular-size chunks from resume_ms, not repeat the
    # short first-chunk warmup (see checkpointM4bFirstProgress on the client).
    orig_first, orig_regular = local_align_server.FIRST_CHUNK_MS, local_align_server.CHUNK_MS
    try:
        local_align_server.FIRST_CHUNK_MS = 3 * 60 * 1000
        local_align_server.CHUNK_MS = 10 * 60 * 1000
        bounds = _chunk_bounds(25 * 60 * 1000, resume_ms=13 * 60 * 1000)
    finally:
        local_align_server.FIRST_CHUNK_MS, local_align_server.CHUNK_MS = orig_first, orig_regular
    assert bounds == [
        (13 * 60 * 1000, 23 * 60 * 1000),
        (23 * 60 * 1000, 25 * 60 * 1000),
    ]


def test_isolated_common_word_overlap_with_intro_does_not_create_a_false_anchor():
    """The exact real-world scenario found against a real audiobook: a
    publisher intro shares "this"/"is" with an unrelated first line, but
    nothing else. That must NOT anchor the book line to the intro's (wrong)
    timestamp — the multi-word block for line 1 is the only reliable anchor."""
    lines = [
        {"idx": 0, "text": "In this world, there is a forest dense with trees."},
        {"idx": 1, "text": "Monstrous bears and packs of whip-smart wolves roam freely within its confines."},
    ]
    asr_words = [
        word("This", 0.5, 0.8), word("is", 1.0, 1.2), word("Audible.", 1.3, 1.6),
        word("monstrous", 30.6, 31.2), word("bears", 31.3, 31.8), word("and", 31.9, 32.0),
        word("packs", 32.1, 32.4), word("of", 32.5, 32.6), word("whip", 32.7, 33.0),
        word("smart", 33.0, 33.3), word("wolves", 33.4, 33.7), word("roam", 33.8, 34.1),
        word("freely", 34.2, 34.5), word("within", 34.6, 34.9), word("its", 35.0, 35.1),
        word("confines.", 35.1, 35.7),
    ]

    aligner = IncrementalAligner(lines, total_ms=60_000)
    out = aligner.feed(asr_words, chunk_duration_ms=240_000)["lines"] + aligner.flush()["lines"]

    line0, line1 = out
    # Line 0 must NOT be anchored to the intro's 0.5-1.2s window — that would
    # be the exact bug: mistaking "this"/"is" overlap for a real match.
    assert line0["start_ms"] != 500
    assert line0["words"] == []
    # It collapses to the first REAL anchor's start instead (no narration of
    # its own — interpolation correctly gives it zero duration there).
    assert line0["start_ms"] == 30600
    assert line0["end_ms"] == 30600

    # Line 1's long contiguous match IS trusted.
    assert line1["start_ms"] == 30600
    assert line1["end_ms"] == 35700
    assert len(line1["words"]) == 13  # monstrous..confines, 13 normalized tokens

    meta = aligner.meta()
    assert meta["lead_in_ms"] == 30600
    assert meta["unmatched_line_count"] == 1


def test_short_lines_with_only_isolated_matches_are_not_falsely_anchored():
    lines = [{"idx": 0, "text": "the"}, {"idx": 1, "text": "a"}]
    asr_words = [word("the", 5.0, 5.1), word("cat", 5.1, 5.3), word("a", 9.0, 9.1)]

    aligner = IncrementalAligner(lines, total_ms=20_000)
    out = aligner.feed(asr_words, chunk_duration_ms=240_000)["lines"] + aligner.flush()["lines"]
    assert out[0]["words"] == []
    assert out[1]["words"] == []
    assert aligner.meta()["unmatched_line_count"] == 2


def test_reliable_multi_word_match_is_still_anchored_when_it_meets_the_block_size_floor():
    """A 6-word contiguous match (the MIN_ANCHOR_BLOCK_WORDS default) is
    trusted — the fix shouldn't make every line unmatchable, just raise the
    bar high enough that a coincidental common-phrase overlap can't clear it."""
    lines = [{"idx": 0, "text": "Ha! What a joke, he said flatly."}]
    asr_words = [word(w, 95.6 + i * 0.2, 95.8 + i * 0.2) for i, w in enumerate(
        ["ha", "what", "a", "joke", "he", "said", "flatly"],
    )]

    aligner = IncrementalAligner(lines, total_ms=200_000)
    out = aligner.feed(asr_words, chunk_duration_ms=240_000)["lines"] + aligner.flush()["lines"]
    assert out[0]["start_ms"] == 95600
    assert aligner.meta()["unmatched_line_count"] == 0


def test_a_bare_common_phrase_below_the_new_block_size_floor_is_rejected():
    """The exact real-world scenario found against a real audiobook: "go to
    the", "out of the", "we were all" are common enough 3-word fragments
    that a whole-novel search corpus contains many coincidental repeats —
    a 3-word block (the OLD default) is not enough signal; this must fall
    back to interpolation instead of anchoring to the wrong occurrence."""
    lines = [{"idx": 0, "text": "he wanted to go to the market"}]
    asr_words = [word(w, 10.0 + i * 0.2, 10.2 + i * 0.2) for i, w in enumerate(["go", "to", "the"])]

    aligner = IncrementalAligner(lines, total_ms=200_000)
    out = aligner.feed(asr_words, chunk_duration_ms=240_000)["lines"] + aligner.flush()["lines"]
    assert out[0]["words"] == []
    assert aligner.meta()["unmatched_line_count"] == 1


def test_no_anchors_at_all_falls_back_to_proportional_interpolation():
    lines = [{"idx": 0, "text": "hello"}, {"idx": 1, "text": "world"}]
    aligner = IncrementalAligner(lines, total_ms=10_000)
    assert aligner.feed([], chunk_duration_ms=240_000) == {"lines": [], "gaps": []}
    out = aligner.flush()["lines"]
    meta = aligner.meta()
    assert meta["lead_in_ms"] == 0
    assert meta["unmatched_line_count"] == 2
    assert out[0]["start_ms"] < out[1]["start_ms"]


# --------------------------------------------------------------------------- #
# Incremental streaming behavior — the whole point of IncrementalAligner       #
# --------------------------------------------------------------------------- #

def test_feed_returns_only_newly_resolved_lines_and_holds_back_straddling_ones():
    """Two lines fully covered by chunk 1's anchors get returned immediately;
    a third line whose words split across chunk 1 and chunk 2 is held back
    until chunk 2 completes it — never emitted twice, never emitted early."""
    lines = [
        {"idx": 0, "text": "one two three four five six"},
        {"idx": 1, "text": "seven eight nine ten eleven twelve"},
        {"idx": 2, "text": "thirteen fourteen fifteen sixteen seventeen eighteen nineteen"},
    ]
    aligner = IncrementalAligner(lines, total_ms=20_000)

    chunk1_words = [word(w, i * 1.0, i * 1.0 + 0.5) for i, w in enumerate(
        ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen"],
    )]
    resolved_after_chunk1 = aligner.feed(chunk1_words, chunk_duration_ms=240_000)["lines"]
    resolved_idxs = [ln["idx"] for ln in resolved_after_chunk1]
    assert resolved_idxs == [0, 1]  # line 2 only partially matched (just "thirteen") — held back

    # Chunk 2 supplies the rest of line 2's words — 6 more, a reliable block on its own.
    chunk2_words = [word(w, 10 + i, 10 + i + 0.5) for i, w in enumerate(
        ["fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"],
    )]
    resolved_after_chunk2 = aligner.feed(chunk2_words, chunk_duration_ms=240_000)["lines"]
    assert [ln["idx"] for ln in resolved_after_chunk2] == [2]

    # Never emitted twice.
    assert aligner.flush() == {"lines": [], "gaps": []}


def test_feed_advances_cursor_so_later_chunks_only_search_the_remaining_tail():
    lines = [
        {"idx": 0, "text": "alpha beta gamma delta epsilon zeta"},
        {"idx": 1, "text": "eta theta iota kappa lambda mu"},
    ]
    aligner = IncrementalAligner(lines, total_ms=20_000)
    assert aligner.cursor == 0

    words1 = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]
    aligner.feed([word(w, i, i + 0.5) for i, w in enumerate(words1)], chunk_duration_ms=240_000)
    assert aligner.cursor == 6  # past line 0's 6 words only

    words2 = ["eta", "theta", "iota", "kappa", "lambda", "mu"]
    aligner.feed([word(w, 10 + i, 10 + i + 0.5) for i, w in enumerate(words2)], chunk_duration_ms=240_000)
    assert aligner.cursor == 12


def test_resume_with_a_truncated_remaining_lines_list_preserves_original_idx():
    """A resumed /align call (see docs/M4B_FIRST_FLOW.md's align-resume
    section) sends only the lines NOT already resolved in the caller's
    cached manifest — line 0 here stands in for one already resolved by an
    earlier, now-discarded run. The aligner must not renumber what's left:
    each emitted row's idx has to be the ORIGINAL book idx (1, not 0), so the
    client can merge results back into its existing lineTimings by that same
    key. Word timestamps are absolute file-position seconds (matching
    _transcribe_chunk's real offset_s behavior for a chunk starting at
    resume_ms), not relative to this call's audio."""
    remaining_lines = [{"idx": 1, "text": "eta theta iota kappa lambda mu"}]
    aligner = IncrementalAligner(remaining_lines, total_ms=20_000)

    words = ["eta", "theta", "iota", "kappa", "lambda", "mu"]
    # Absolute timestamps starting well past 0 — as if this chunk began at a
    # real resume_ms offset, not at the top of the file.
    resolved = aligner.feed([word(w, 500 + i, 500 + i + 0.5) for i, w in enumerate(words)], chunk_duration_ms=240_000)
    assert [ln["idx"] for ln in resolved["lines"]] == [1]
    assert resolved["lines"][0]["start_ms"] == 500_000


def test_a_chunk_with_no_reliable_match_advances_nothing_and_emits_nothing():
    """A chunk that's pure silence/unrelated audio (e.g. mid-book dead air)
    must not corrupt state — the next chunk should still be able to resolve
    everything normally."""
    lines = [{"idx": 0, "text": "one two three four five six"}]
    aligner = IncrementalAligner(lines, total_ms=20_000)

    assert aligner.feed([], chunk_duration_ms=240_000) == {"lines": [], "gaps": []}
    # single word, below MIN_ANCHOR_BLOCK_WORDS (and below MIN_GAP_WORDS too)
    assert aligner.feed([word("unrelated", 1.0, 1.2)], chunk_duration_ms=240_000) == {"lines": [], "gaps": []}
    assert aligner.cursor == 0

    words = ["one", "two", "three", "four", "five", "six"]
    resolved = aligner.feed([word(w, 5 + i, 5 + i + 0.5) for i, w in enumerate(words)], chunk_duration_ms=240_000)["lines"]
    assert [ln["idx"] for ln in resolved] == [0]


def test_flush_finalizes_a_line_that_never_matched_using_the_last_known_anchor():
    lines = [
        {"idx": 0, "text": "one two three four five six"},
        {"idx": 1, "text": "unmatched trailing line"},
    ]
    aligner = IncrementalAligner(lines, total_ms=20_000)
    words = ["one", "two", "three", "four", "five", "six"]
    aligner.feed([word(w, i, i + 0.5) for i, w in enumerate(words)], chunk_duration_ms=240_000)
    out = aligner.flush()["lines"]
    assert out[0]["idx"] == 1
    assert aligner.meta()["unmatched_line_count"] == 1


# --------------------------------------------------------------------------- #
# Bounded lookahead — regression for a real full-book failure                 #
# --------------------------------------------------------------------------- #

def test_a_long_coincidental_match_far_ahead_in_a_big_book_is_rejected_as_implausible():
    """Found against a real 6.6-hour audiobook: with an UNBOUNDED search
    space (the whole rest of a ~1000-line book), difflib found a long (10+
    word), MIN_ANCHOR_BLOCK_WORDS-passing "reliable" block matching natural-
    language repetition (common connective words recurring in ordinary
    prose) hundreds of lines further into the book than a few minutes of
    real audio could possibly have reached — jumping straight from early
    Chapter 1 to late Chapter 8 in under 20 minutes of a 6.6-hour book. The
    lookahead bound (MAX_WORDS_PER_SECOND) must reject that distant match
    even though it's long enough to pass the block-size filter."""
    # A short "genuine" line right after the cursor, then thousands of
    # filler words, then a much-later line that happens to share a long
    # common phrase with what the (short, few-second) chunk actually said.
    filler = " ".join(["filler"] * 3000)
    lines = [
        {"idx": 0, "text": "real spoken content here right now"},
        {"idx": 1, "text": filler},
        {"idx": 2, "text": "the man walked slowly and quietly across the room"},
    ]
    aligner = IncrementalAligner(lines, total_ms=6 * 60 * 60 * 1000)  # a long, ~6-hour book

    # This chunk covers only 10 REAL seconds of audio and genuinely says
    # "real spoken content here" — but the ASR words ALSO happen to line up
    # with idx 2's phrase later in known_words (a coincidental 9-word run).
    asr_words = [word(w, i * 0.5, i * 0.5 + 0.4) for i, w in enumerate(
        ["real", "spoken", "content", "here", "right", "now",
         "the", "man", "walked", "slowly", "and", "quietly", "across", "the", "room"],
    )]
    resolved = aligner.feed(asr_words, chunk_duration_ms=10_000)["lines"]  # only 10s of real audio elapsed

    resolved_idxs = [ln["idx"] for ln in resolved]
    # Line 0 resolves normally (early, within any reasonable lookahead).
    assert 0 in resolved_idxs
    # Line 2 must NOT resolve from this single 10-second, 13-word chunk —
    # jumping past ~3000 filler words in 10 seconds is not remotely
    # plausible narration pace, however cleanly the phrase happened to match.
    assert 2 not in resolved_idxs
    assert aligner.cursor < 3000  # nowhere near line 2's position (past the filler)


def test_a_short_coincidental_match_reachable_only_via_the_lookahead_floor_is_rejected():
    """Regression for the "player jumps to a random spot" bug: a match block
    long enough to pass MIN_ANCHOR_BLOCK_WORDS (6) but found well beyond what
    this chunk's OWN elapsed real time could plausibly justify — reachable
    only because MIN_LOOKAHEAD_WORDS's floor (or a dry spell) inflated the
    search window — must now clear the stricter STRICT_ANCHOR_BLOCK_WORDS bar
    instead. Unlike the test above (a match far outside even the inflated
    window, rejected by the window bound itself), this one lands INSIDE the
    window — before this fix, nothing rejected it."""
    filler = " ".join(["filler"] * 194)
    lines = [
        {"idx": 0, "text": "real spoken content here right now"},  # 6 words, positions 0-5
        {"idx": 1, "text": filler},  # positions 6-199
        {"idx": 2, "text": "the man walked slowly and quietly across"},  # 7 words, position 200
    ]
    aligner = IncrementalAligner(lines, total_ms=6 * 60 * 60 * 1000)

    # 10 real seconds of audio -> real_pace_bound = int(10 * 4) = 40 words,
    # well short of line 2's position (200) — but MIN_LOOKAHEAD_WORDS (400)
    # still puts it inside the search window.
    asr_words = [word(w, i * 0.5, i * 0.5 + 0.4) for i, w in enumerate(
        ["real", "spoken", "content", "here", "right", "now",
         "the", "man", "walked", "slowly", "and", "quietly", "across"],
    )]
    resolved = aligner.feed(asr_words, chunk_duration_ms=10_000)["lines"]

    resolved_idxs = [ln["idx"] for ln in resolved]
    assert 0 in resolved_idxs  # the genuine, near-cursor content still resolves
    assert 2 not in resolved_idxs  # the far-but-in-window coincidence does not
    assert aligner.cursor <= 10  # nowhere near line 2's position (200)


# --------------------------------------------------------------------------- #
# Gap detection — surfacing audio-only content ("insert" opcodes) as         #
# narrator filler instead of silently discarding it. See MIN_GAP_WORDS.       #
# --------------------------------------------------------------------------- #

def test_a_sandwiched_adlib_between_two_anchors_is_emitted_as_a_gap():
    """A narrator aside inserted mid-book, bracketed by real anchors on both
    sides within the SAME feed() call, is captured immediately."""
    lines = [
        {"idx": 0, "text": "one two three four five six"},
        {"idx": 1, "text": "seven eight nine ten eleven twelve"},
    ]
    aligner = IncrementalAligner(lines, total_ms=60_000)
    line0_words = ["one", "two", "three", "four", "five", "six"]
    adlib_words = ["hey", "listener", "this", "bonus", "scene", "was", "recorded", "later"]  # 8 words
    line1_words = ["seven", "eight", "nine", "ten", "eleven", "twelve"]
    asr_words = [word(w, i * 1.0, i * 1.0 + 0.5) for i, w in enumerate(
        line0_words + adlib_words + line1_words,
    )]

    result = aligner.feed(asr_words, chunk_duration_ms=240_000)
    assert [ln["idx"] for ln in result["lines"]] == [0, 1]
    assert len(result["gaps"]) == 1
    gap = result["gaps"][0]
    assert gap["text"] == "hey listener this bonus scene was recorded later"
    assert gap["word_count"] == 8
    # Sits acoustically between line 0's last word and line 1's first word.
    assert gap["start_ms"] >= 6000
    assert gap["end_ms"] <= 14000
    assert aligner.meta()["gap_count"] == 1


def test_sub_min_gap_words_noise_is_discarded_not_emitted():
    """The 'occasional 1-word deviation we can expect' tolerance — a couple
    of stray ASR words (below MIN_GAP_WORDS) between two anchors must NOT
    produce a visible gap, mirroring how MIN_ANCHOR_BLOCK_WORDS already
    tolerates isolated noise on the anchor side."""
    lines = [
        {"idx": 0, "text": "one two three four five six"},
        {"idx": 1, "text": "seven eight nine ten eleven twelve"},
    ]
    aligner = IncrementalAligner(lines, total_ms=60_000)
    line0_words = ["one", "two", "three", "four", "five", "six"]
    noise = ["um", "okay"]  # 2 words — below the default MIN_GAP_WORDS=8
    line1_words = ["seven", "eight", "nine", "ten", "eleven", "twelve"]
    asr_words = [word(w, i, i + 0.5) for i, w in enumerate(line0_words + noise + line1_words)]

    result = aligner.feed(asr_words, chunk_duration_ms=240_000)
    assert [ln["idx"] for ln in result["lines"]] == [0, 1]
    assert result["gaps"] == []
    assert aligner.meta()["gap_count"] == 0


def test_replace_opcodes_do_not_produce_gaps_even_when_long():
    """A run of audio with NO equal block at all this call (both sides
    non-empty and totally mismatched) is one 'replace' opcode, not 'insert'
    — deliberately NOT treated as a gap in v1, the same fuzzy-match-noise
    tolerance the system already extends to abridgment/ASR mishearing.
    Long on purpose: confirms this is a scope decision, not just a
    length threshold."""
    lines = [{"idx": 0, "text": "one two three four five six"}]
    aligner = IncrementalAligner(lines, total_ms=60_000)
    mismatched = [
        "completely", "unrelated", "audio", "content",
        "that", "never", "matches", "anything", "at", "all",
    ]
    asr_words = [word(w, i, i + 0.5) for i, w in enumerate(mismatched)]

    result = aligner.feed(asr_words, chunk_duration_ms=240_000)
    assert result["lines"] == []
    assert result["gaps"] == []

    final = aligner.flush()
    assert final["gaps"] == []
    assert aligner.meta()["unmatched_line_count"] == 1  # book line still shown via interpolation, not dropped


def test_front_matter_before_the_first_anchor_is_captured_once_bracketed():
    """Publisher intro / cold-open ad-lib before any real book content is
    read — captured as a gap once a real anchor arrives after it, exactly
    like a mid-book aside; group 0 (before any anchor ever appeared) is not
    a special case."""
    lines = [{"idx": 0, "text": "one two three four five six"}]
    aligner = IncrementalAligner(lines, total_ms=60_000)
    intro_words = ["seven", "seas", "sirens", "presents", "this", "audiobook", "production", "now"]
    book_words = ["one", "two", "three", "four", "five", "six"]
    asr_words = [word(w, i, i + 0.5) for i, w in enumerate(intro_words + book_words)]

    result = aligner.feed(asr_words, chunk_duration_ms=240_000)
    assert [ln["idx"] for ln in result["lines"]] == [0]
    assert len(result["gaps"]) == 1
    assert result["gaps"][0]["text"] == "seven seas sirens presents this audiobook production now"


def test_back_matter_after_the_last_anchor_is_only_finalized_at_flush():
    """A trailing outro/bonus-chapter tease after the book's last real line
    resolves must NOT appear from feed() alone — only flush() (no more audio
    coming) finalizes a dangling, never-bracketed tail."""
    lines = [{"idx": 0, "text": "one two three four five six"}]
    aligner = IncrementalAligner(lines, total_ms=60_000)
    line0_words = ["one", "two", "three", "four", "five", "six"]
    outro_words = ["thanks", "for", "listening", "to", "this", "bonus", "epilogue", "chapter"]
    asr_words = [word(w, i, i + 0.5) for i, w in enumerate(line0_words + outro_words)]

    result = aligner.feed(asr_words, chunk_duration_ms=240_000)
    assert [ln["idx"] for ln in result["lines"]] == [0]
    assert result["gaps"] == []  # dangling tail — feed() never finalizes it on its own

    final = aligner.flush()
    assert len(final["gaps"]) == 1
    assert final["gaps"][0]["text"] == "thanks for listening to this bonus epilogue chapter"


def test_a_gap_split_across_a_chunk_boundary_coalesces_into_one_segment():
    """A single ad-lib whose words happen to straddle two transcription
    chunks, with no anchor found anywhere in between, must merge into ONE
    gap — not two — once it's finally finalized."""
    lines = [{"idx": 0, "text": "one two three four five six"}]
    aligner = IncrementalAligner(lines, total_ms=60_000)
    line0_words = ["one", "two", "three", "four", "five", "six"]
    adlib_part1 = ["hey", "listener", "this", "bonus"]
    chunk1 = [word(w, i, i + 0.5) for i, w in enumerate(line0_words + adlib_part1)]
    result1 = aligner.feed(chunk1, chunk_duration_ms=240_000)
    assert result1["gaps"] == []  # still dangling — chunk 1 ends mid-adlib

    adlib_part2 = ["scene", "was", "recorded", "later"]
    chunk2 = [word(w, 20 + i, 20 + i + 0.5) for i, w in enumerate(adlib_part2)]
    result2 = aligner.feed(chunk2, chunk_duration_ms=240_000)
    assert result2["gaps"] == []  # still dangling — no anchor after it anywhere yet

    final = aligner.flush()
    assert len(final["gaps"]) == 1
    assert final["gaps"][0]["text"] == "hey listener this bonus scene was recorded later"
    assert final["gaps"][0]["word_count"] == 8


def test_a_dangling_insert_is_held_until_a_later_chunks_anchor_brackets_it():
    """The cross-chunk symmetric case of the sandwiched test above: the
    ad-lib's closing anchor arrives in a LATER feed() call, not the same one
    — the gap must stay invisible until that later call, then appear."""
    lines = [
        {"idx": 0, "text": "one two three four five six"},
        {"idx": 1, "text": "seven eight nine ten eleven twelve"},
    ]
    aligner = IncrementalAligner(lines, total_ms=60_000)
    line0_words = ["one", "two", "three", "four", "five", "six"]
    trailing_adlib = ["hey", "listener", "this", "bonus", "scene", "was", "recorded", "later"]
    chunk1 = [word(w, i, i + 0.5) for i, w in enumerate(line0_words + trailing_adlib)]
    result1 = aligner.feed(chunk1, chunk_duration_ms=240_000)
    assert [ln["idx"] for ln in result1["lines"]] == [0]
    assert result1["gaps"] == []  # dangling — no anchor after it yet

    line1_words = ["seven", "eight", "nine", "ten", "eleven", "twelve"]
    chunk2 = [word(w, 20 + i, 20 + i + 0.5) for i, w in enumerate(line1_words)]
    result2 = aligner.feed(chunk2, chunk_duration_ms=240_000)
    assert [ln["idx"] for ln in result2["lines"]] == [1]
    assert len(result2["gaps"]) == 1
    assert result2["gaps"][0]["text"] == "hey listener this bonus scene was recorded later"


# ── M4B-first /transcribe: sentence grouping (_words_to_sentences) ────────────
_words_to_sentences = local_align_server._words_to_sentences


def test_words_to_sentences_splits_on_terminal_punctuation():
    # start/end are whole-file SECONDS (as _transcribe_chunk emits); the helper
    # converts to ms and groups into sentences at .!?
    words = [
        word("First", 0.0, 0.3), word("one.", 0.3, 0.6),
        word("Second", 1.0, 1.3), word("two!", 1.3, 1.6),
    ]
    lines = _words_to_sentences(words, start_idx=0)
    assert [ln["text"] for ln in lines] == ["First one.", "Second two!"]
    assert lines[0]["idx"] == 0 and lines[1]["idx"] == 1
    assert lines[0]["start_ms"] == 0 and lines[0]["end_ms"] == 600
    assert lines[0]["words"] == [["First", 0, 300], ["one.", 300, 600]]


def test_words_to_sentences_keeps_closing_quote_with_the_sentence():
    words = [word('"Stop', 0.0, 0.3), word('now!"', 0.3, 0.6), word("Next", 1.0, 1.3), word("line.", 1.3, 1.6)]
    lines = _words_to_sentences(words, start_idx=0)
    assert [ln["text"] for ln in lines] == ['"Stop now!"', "Next line."]


def test_words_to_sentences_emits_trailing_fragment_without_terminal_punctuation():
    # A chunk can end mid-sentence; the dangling words still become a line so no
    # transcript is dropped (the next chunk simply starts a new sentence).
    words = [word("Trailing", 0.0, 0.3), word("words", 0.3, 0.6), word("here", 0.6, 0.9)]
    lines = _words_to_sentences(words, start_idx=7)
    assert len(lines) == 1
    assert lines[0]["idx"] == 7
    assert lines[0]["text"] == "Trailing words here"


def test_words_to_sentences_indexes_from_start_idx():
    words = [word("A.", 0.0, 0.1), word("B.", 0.2, 0.3)]
    lines = _words_to_sentences(words, start_idx=40)
    assert [ln["idx"] for ln in lines] == [40, 41]
