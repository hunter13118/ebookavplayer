"""
Local WhisperX forced-alignment server for VAE's `whisperx-local` align tier.

Implements the contract the frontend expects (see
web/src/timing/whisperxAlignerClient.js):

    GET  /health
    -> {"status": "ok", "device": {"asr": "cpu", "align": "mps"|"cpu"},
        "model": "<asr model id>", "ready": bool}

    POST /align
    multipart form:
      m4b:   the whole attached audiobook file (uploaded once)
      lines: JSON string, [{ "idx": int, "text": str }, ...] — EVERY known
             line in the book, in book order, spanning every chapter. No
             per-chapter time guesses are sent; there's nothing to guess —
             real boundaries fall out of matching against the real audio.
    -> streamed NDJSON, one row per processed time-window plus a final marker:
         {"status": "chunk", "lines": [{"idx": int, "start_ms": int, "end_ms": int,
                                         "words": [[word, start_ms, end_ms], ...]}, ...],
          "processed_ms": int, "total_ms": int,
          "meta": {"asr_device": str, "align_device": str,
                   "lead_in_ms": int, "unmatched_line_count": int}}
         {"status": "done", "meta": {...same shape...}}
       `lines` on a "chunk" row is only the NEWLY-resolved lines since the
       last row (often empty, e.g. during a long front-matter stretch) — a
       caller wanting live, incremental playback applies each row's lines
       to its timeline as they arrive rather than waiting for "done".

Why a SINGLE continuous transcription instead of per-chapter slices (the
previous design): commercial audiobooks routinely open with narration that
doesn't exist in the EPUB at all — "Seven Seas Sirens presents...", "This is
Audible" — and may have a translator's note, bonus chapter, or next-volume
teaser at the end. The old design had to GUESS each chapter's start/end
timestamp before listening to anything (from the container's embedded chpl
markers, or worst case a character-count-proportional split of total
duration), then sliced the file to that guess and only ever transcribed
that slice. Any front-matter audio silently ate into chapter 1's guessed
span, throwing off every subsequent chapter's guess — the aligner was then
confidently forced-aligning the WRONG audio, with no way to recover since it
never saw anything outside its slice.

Instead: transcribe the ENTIRE file once (chunked only for memory/progress-
streaming reasons, not content boundaries — see CHUNK_MS), building one
continuous, globally-timestamped word stream. Then fuzzy word-diff match
(difflib) the WHOLE known book (every line, every chapter, concatenated in
book order) against that word stream. A leading publisher intro, a mid-book
translator's aside, a trailing bonus chapter — none of it needs to be
predicted ahead of time; it simply fails to match anything and the matcher
skips over it. Chapter boundaries become a BYPRODUCT of where each
chapter's lines land in time, not a precondition for transcribing correctly.

Matching runs INCREMENTALLY, one chunk at a time (IncrementalAligner below),
instead of buffering the whole book's transcript before matching anything.
The first chunk defaults to a few minutes (FIRST_CHUNK_MS) specifically so a
freshly-attached .m4b gets its first stretch of REAL timing back — and is
playable/readable with it — in well under a minute, with the rest of the
book's alignment continuing to stream in in the background as later chunks
complete. Each chunk's newly-resolved lines are sent the moment they're
known; a client can apply them to a live playback timeline in place.

Run:  source .venv/bin/activate && python scripts/local-align-server/server.py
Then: add http://127.0.0.1:7861 as a connection in Settings > Backends,
      pick "WhisperX forced-align (local, most accurate)" as the sync
      strategy when attaching a .m4b.
"""
from __future__ import annotations

import difflib
import json
import logging
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Iterator

import torch
import whisperx
from whisperx.audio import SAMPLE_RATE as WHISPERX_SAMPLE_RATE
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("local-align-server")

ASR_MODEL = os.environ.get("ALIGN_ASR_MODEL", "small")
LANGUAGE = os.environ.get("ALIGN_LANGUAGE", "en")
# faster-whisper's CTranslate2 backend has no MPS/Metal support (confirmed:
# ctranslate2.get_supported_compute_types only exposes cpu/cuda) — ASR always
# runs on CPU here. The wav2vec2 alignment model IS plain PyTorch and does
# support MPS, so the two stages are allowed to run on different devices.
ASR_DEVICE = "cpu"
ALIGN_DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"
ASR_COMPUTE_TYPE = os.environ.get("ALIGN_ASR_COMPUTE_TYPE", "int8")

app = FastAPI()
# The web client (localhost:5173 in dev, or wherever it's hosted) is a
# different origin than this server (127.0.0.1:7861) by browser rules even
# on the same machine — without this, every fetch (including the plain
# GET /health poll in web/src/backends/health.js) fails as a CORS error
# before the response body is ever readable, and the connection shows
# permanently "offline" in Settings > Backends regardless of server health.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
asr_model = None
align_model = None
align_metadata = None


@app.on_event("startup")
def load_models():
    global asr_model, align_model, align_metadata
    log.info("loading ASR model %s on %s (compute_type=%s)...", ASR_MODEL, ASR_DEVICE, ASR_COMPUTE_TYPE)
    asr_model = whisperx.load_model(
        ASR_MODEL,
        device=ASR_DEVICE,
        compute_type=ASR_COMPUTE_TYPE,
        language=LANGUAGE,
        vad_method="silero",  # avoids needing a gated HF token for pyannote VAD
    )
    log.info("loading alignment model for language=%s on %s...", LANGUAGE, ALIGN_DEVICE)
    align_model, align_metadata = whisperx.load_align_model(language_code=LANGUAGE, device=ALIGN_DEVICE)
    log.info("models loaded, ready to align")


@app.get("/health")
def health():
    ready = asr_model is not None and align_model is not None
    # "ok" (not just "status") because web/src/backends/health.js's checkHealth()
    # gates online/offline on health?.ok specifically, matching every other
    # backend connection's contract (see worker/worker.js's GET /health).
    return {
        "ok": ready,
        "status": "ok" if ready else "loading",
        "device": {"asr": ASR_DEVICE, "align": ALIGN_DEVICE},
        "model": ASR_MODEL,
        "ready": ready,
    }


@app.get("/pipeline")
def pipeline():
    # Stub so web/src/backends/health.js's checkPipeline() (which every
    # connection with a baseUrl gets polled by, see connections.js) doesn't
    # 404 against this align-only server once it's added as a connection —
    # this server has no provider/pipeline config to report.
    return {"providers": {}}


_WORD_RE = re.compile(r"[a-z0-9']+")


def _normalize_words(text: str) -> list[str]:
    """Lowercase word tokens for fuzzy matching — punctuation/case shouldn't
    break a match between EPUB text and what a narrator actually said."""
    return _WORD_RE.findall(text.lower())


def _slice_audio(m4b_path: str, start_ms: int, end_ms: int, out_path: str) -> None:
    """ffmpeg does the slice AND the resample-to-16kHz-mono in one step —
    whisperx.load_audio() would otherwise just re-invoke ffmpeg again on
    whatever we hand it, so there's no point doing this in two passes."""
    start_s = max(0, start_ms) / 1000
    duration_s = max(0.01, (end_ms - start_ms) / 1000)
    cmd = [
        "ffmpeg", "-y", "-nostdin", "-loglevel", "error",
        "-ss", f"{start_s:.3f}", "-i", m4b_path, "-t", f"{duration_s:.3f}",
        "-ar", "16000", "-ac", "1", "-f", "wav", out_path,
    ]
    subprocess.run(cmd, check=True)


def _probe_duration_ms(m4b_path: str) -> int:
    """ffprobe instead of whisperx.load_audio — avoids decoding a whole
    multi-hour file into memory (~2GB+ as float32) just to learn its length."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", m4b_path],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    return round(float(out) * 1000)


# Chunk size is purely a memory/progress-streaming knob, NOT a content
# boundary — unlike the old per-chapter slicing, nothing here assumes a
# chunk starts or ends at any meaningful point in the book. A chunk that
# happens to cut mid-word can drop that one word from the transcript; the
# fuzzy matcher below tolerates a few missing words fine (interpolates),
# so this isn't worth the complexity of overlapping/deduping chunks.
#
# The FIRST chunk is deliberately much smaller than the rest: it's the
# difference between "attach a .m4b, wait ~30s, start listening/reading with
# real synced timing" and "wait for the whole book." Once the user is
# already reading on that first real stretch, later chunks can be larger —
# fewer ffmpeg/model-call round trips for the same total work.
FIRST_CHUNK_MS = int(os.environ.get("ALIGN_FIRST_CHUNK_MS", str(4 * 60 * 1000)))
CHUNK_MS = int(os.environ.get("ALIGN_CHUNK_MS", str(15 * 60 * 1000)))

# See the comment at the matcher call site in IncrementalAligner.feed.
# Found against a real, full-length (6.6-hour) audiobook that 3 was far too
# low a bar once the search corpus is a whole novel: every one of a string
# of bad anchors traced back to a bare 3-word match on phrase fragments
# ("go to the", "out of the", "we were all", "it was time to") that
# ordinary prose simply repeats dozens of times. A coincidental EXACT match
# gets exponentially rarer as block length grows, so 6+ consecutive words
# is a real anchor to a much higher confidence than 3 ever was — this is
# the same reasoning text-fingerprinting/plagiarism-detection systems use
# n-grams of 5+ words as robust identity anchors instead of 2-3.
MIN_ANCHOR_BLOCK_WORDS = int(os.environ.get("ALIGN_MIN_ANCHOR_WORDS", "6"))

# Floor for surfacing a run of audio-only words (narrator ad-libs, publisher
# intros, spoken chapter titles not in the EPUB) as a "gap" the client renders
# as narrator filler. Set higher than MIN_ANCHOR_BLOCK_WORDS on purpose: a
# wrong anchor just mis-times one line, but a wrong gap fabricates a visible
# narrator bubble the user actually reads — the false-positive bar should be
# at least as high, arguably higher. Judgment call, not derived from a real
# audiobook corpus the way MIN_ANCHOR_BLOCK_WORDS's regression story was —
# expect this to need tuning once tested against a real book with known ad-libs.
MIN_GAP_WORDS = int(os.environ.get("ALIGN_MIN_GAP_WORDS", "8"))

# Separate, much lower floor for gap words at the EDGES — before the first
# anchor is ever matched (a publisher bumper: "This is Audible.", "Podium
# Studios presents") or after the last known line resolves (trailing outro).
# MIN_GAP_WORDS's false-positive concern doesn't apply out here: a mid-book
# "insert" run sits between two real anchors, so a wrong one fabricates a
# fake narrator line inside real content — but at the edges there IS no book
# content on the open side to coincidentally collide with, so a short run is
# almost certainly real (found via a real audiobook's opening bumpers being
# dropped entirely at MIN_GAP_WORDS=8 — see IncrementalAligner.feed's `edge`
# tagging). Default of 2 still filters a single stray ASR token.
MIN_EDGE_GAP_WORDS = int(os.environ.get("ALIGN_MIN_EDGE_GAP_WORDS", "2"))

# Whisper occasionally mis-segments a stretch of real speech: a VAD-merged
# segment gets reported with an implausibly long span for how few words it
# actually contains, and everything else genuinely spoken within that span is
# silently dropped from the transcript — not misheard, just never decoded.
# Confirmed against this project's own sample audiobook's opening bumper: a
# publisher intro + narrator credits + spoken "Prologue" title (26 real
# words spanning ~18s) came back from a >=30s ASR call as only two words,
# " This is Audible", with the segment's own reported end timestamp 18
# seconds later — but transcribing that SAME audio span in isolation, alone,
# under 30s, decoded it completely and correctly every time. The mechanism
# looks tied to Whisper's own ~30s internal processing window combined with
# VAD segment merging (more likely to misfire on music/sfx-mixed bumper
# audio than on clean narration) — safe, isolated re-transcription of just
# the suspect span is a robust repair that doesn't depend on knowing any
# particular book's intro length ahead of time.
MIN_SEGMENT_WPS = float(os.environ.get("ALIGN_MIN_SEGMENT_WPS", "0.8"))  # real narration runs 2-3+ words/sec
MIN_SUSPECT_SEGMENT_S = float(os.environ.get("ALIGN_MIN_SUSPECT_SEGMENT_S", "6"))  # ignore short segments/pauses
REPAIR_WINDOW_S = float(os.environ.get("ALIGN_REPAIR_WINDOW_S", "25"))  # empirically reliable single-shot window
# ASR decoding is deterministic for a given exact input — retrying the IDENTICAL
# slice never changes the answer. But the result is extremely sensitive to the
# exact start offset: on this project's own reproduction, starting the same
# repair window at 0.49s/0.6s/1.0s decoded 3/3/2 words, while 0.9s decoded 12
# and 1.3s decoded 34 — tiny shifts land the window on a different internal
# ~30s processing boundary. So each attempt nudges the start forward by
# REPAIR_JITTER_S instead of repeating the same call, and whichever attempt
# recovers the most words wins (cheaper and more stable than recursing on the
# result until one attempt happens to look "clean" — that bounced between a
# few-word and a many-word reading of the same span for 25+ rounds before
# converging on an answer no better than an early attempt already had).
MAX_REPAIR_ATTEMPTS = int(os.environ.get("ALIGN_MAX_REPAIR_ATTEMPTS", "8"))
REPAIR_JITTER_S = float(os.environ.get("ALIGN_REPAIR_JITTER_S", "0.15"))

# Bounds how far AHEAD in the book a single chunk is allowed to match, in
# words-per-second of real narration — a second, independent defense against
# the same class of bug: even a 6+ word "reliable" block can occasionally be
# a coincidental match if the corpus is large enough, so a match implying an
# implausible narration pace (hundreds of lines within a few minutes) is
# rejected regardless of block length. 4 words/sec (~240 wpm) sits above
# typical audiobook narration (~150-160 wpm) with headroom for a fast
# narrator, while still catching a multi-hundred-line jump within minutes.
MAX_WORDS_PER_SECOND = float(os.environ.get("ALIGN_MAX_WORDS_PER_SECOND", "4"))
# Floor so a very short/quiet chunk still gets a reasonable search window.
MIN_LOOKAHEAD_WORDS = int(os.environ.get("ALIGN_MIN_LOOKAHEAD_WORDS", "400"))

# Hard ceiling on how far elapsed_since_advance_ms alone is allowed to grow
# the lookahead window. Without this, a long dry spell (several consecutive
# chunks that fail to match anything — a hard-to-transcribe stretch, or the
# Whisper mis-segmentation bug above) inflates the window toward "most of the
# book," and a coincidental MIN_ANCHOR_BLOCK_WORDS-sized match on an ordinary
# repeated phrase (found in practice: a book's random spot getting "jumped
# to" mid-playback) becomes reachable purely because the window got large,
# not because the narration plausibly raced there. Once cursor advances past
# a false anchor it never reverts (see feed()'s `self.cursor = max(...)`), so
# everything between the true position and the false one gets bogus
# interpolated timings — this bounds the blast radius of that failure mode.
# ~90 minutes of narration at MAX_WORDS_PER_SECOND's pace — generous enough
# for a real, long dry spell to still resync normally, but not "anywhere in a
# 10-hour audiobook."
MAX_LOOKAHEAD_WORDS = int(os.environ.get("ALIGN_MAX_LOOKAHEAD_WORDS", "20000"))

# Stricter block-size floor for an anchor whose position is only reachable
# because of MIN_LOOKAHEAD_WORDS's floor or dry-spell inflation — i.e. beyond
# what the chunk's OWN elapsed real time (no floor, no cap) could plausibly
# justify. A normal-pace anchor keeps MIN_ANCHOR_BLOCK_WORDS's bar; one found
# only via a generously inflated window needs a longer, higher-confidence
# run before being trusted — the same reasoning MIN_ANCHOR_BLOCK_WORDS's own
# comment gives for why 6 beats 3 (coincidental exact matches get
# exponentially rarer as block length grows), applied a second time
# specifically to the "found suspiciously far away" case.
STRICT_ANCHOR_BLOCK_WORDS = int(os.environ.get("ALIGN_STRICT_ANCHOR_BLOCK_WORDS", "10"))


def _chunk_bounds(total_ms: int, resume_ms: int = 0) -> list[tuple[int, int]]:
    """[(start_ms, end_ms), ...] covering the whole file — small first
    window, then the regular chunk size for everything after it.
    `resume_ms` skips straight to the regular chunk size starting at that
    offset (a resumed run has no need for the short first-chunk warmup)."""
    bounds = []
    if resume_ms > 0:
        start_ms = min(resume_ms, total_ms)
        size_ms = CHUNK_MS
    else:
        start_ms = 0
        size_ms = FIRST_CHUNK_MS
    while start_ms < total_ms:
        end_ms = min(start_ms + size_ms, total_ms)
        bounds.append((start_ms, end_ms))
        start_ms = end_ms
        size_ms = CHUNK_MS
    return bounds


def _segment_word_count(seg: dict) -> int:
    return len((seg.get("text") or "").split())


def _repair_suspect_segments(segments: list[dict], audio) -> list[dict]:
    """Re-transcribe any segment whose words-per-second is implausibly low
    for real speech — see MIN_SEGMENT_WPS's comment for why this happens and
    why a narrow, isolated re-transcription reliably recovers it.
    Up to MAX_REPAIR_ATTEMPTS independent attempts are made per suspect
    segment, keeping whichever recovered the most total words — the repair
    window's own end boundary is sometimes just as unreliable as the
    original failure, so this doesn't trust any single attempt as
    authoritative, but it also doesn't recurse on the result: that let a
    noisy boundary bounce between few-word and many-word readings of the
    same span for 25+ rounds before settling on an answer no better than an
    early attempt already had."""
    repaired = []
    for seg in segments:
        duration = seg["end"] - seg["start"]
        word_count = _segment_word_count(seg)
        wps = word_count / duration if duration > 0 else 999
        if duration < MIN_SUSPECT_SEGMENT_S or wps >= MIN_SEGMENT_WPS:
            repaired.append(seg)
            continue

        total_audio_s = len(audio) / WHISPERX_SAMPLE_RATE
        best_segs, best_words = [seg], word_count
        for attempt in range(MAX_REPAIR_ATTEMPTS):
            attempt_start = seg["start"] + attempt * REPAIR_JITTER_S
            window_end = min(attempt_start + REPAIR_WINDOW_S, total_audio_s)
            start_sample = max(0, round(attempt_start * WHISPERX_SAMPLE_RATE))
            end_sample = round(window_end * WHISPERX_SAMPLE_RATE)
            sub_result = asr_model.transcribe(audio[start_sample:end_sample], batch_size=8, language=LANGUAGE)
            if not sub_result["segments"]:
                continue
            shifted = [
                {**s, "start": s["start"] + attempt_start, "end": s["end"] + attempt_start}
                for s in sub_result["segments"]
            ]
            total_words = sum(_segment_word_count(s) for s in shifted)
            if total_words > best_words:
                best_segs, best_words = shifted, total_words

        if best_words > word_count:
            log.info(
                "repaired a suspect segment [%.1f-%.1f]s (%.2f words/sec, %d words) into %d word(s)",
                seg["start"], seg["end"], wps, word_count, best_words,
            )
        repaired.extend(best_segs)
    return repaired


def _transcribe_chunk(m4b_path: str, start_ms: int, end_ms: int) -> list[dict]:
    """ASR + word-align one time-window of the file. Returns word dicts with
    start/end already shifted to whole-file-relative seconds."""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        slice_path = tmp.name
    try:
        _slice_audio(m4b_path, start_ms, end_ms, slice_path)
        audio = whisperx.load_audio(slice_path)
        asr_result = asr_model.transcribe(audio, batch_size=8, language=LANGUAGE)
        if not asr_result["segments"]:
            return []  # silence/no speech in this window — expected, not an error
        segments = _repair_suspect_segments(asr_result["segments"], audio)
        aligned = whisperx.align(
            segments, align_model, align_metadata, audio, ALIGN_DEVICE,
            return_char_alignments=False,
        )
        offset_s = start_ms / 1000
        return [
            {"word": w["word"], "start": w["start"] + offset_s, "end": w["end"] + offset_s}
            for w in aligned["word_segments"] if "start" in w and "end" in w
        ]
    finally:
        Path(slice_path).unlink(missing_ok=True)


class IncrementalAligner:
    """Cross-chunk state for matching the WHOLE book against a whole-file
    transcript that arrives a chunk at a time. `cursor` is a monotonically
    advancing position in the book's word stream: everything before it is
    considered resolved (either really matched, or interpolated once its
    neighbors are known), so each new chunk only needs to search the
    remaining, still-unresolved tail of the book — bounding the match cost
    as the book progresses instead of re-scanning everything every time.

    feed() is called once per chunk, in order, and returns whichever lines
    are now fully resolvable (every one of their words falls before the new
    cursor position) — the FIRST time each line is ever returned, since
    `next_line_to_emit` only moves forward. A line straddling the current
    boundary (some of its words matched, some still pending) is held back
    until a later chunk resolves the rest of it, so interpolation for any
    of its still-unmatched words has a real "after" anchor to work with
    instead of guessing at the book's tail.

    flush() is called once, after the last chunk, to finalize anything left
    — same interpolation logic, but with no more audio coming, so remaining
    lines fall back to the last real anchor rather than waiting further.
    """

    def __init__(self, lines: list[dict], total_ms: int):
        self.lines = lines
        self.total_ms = total_ms
        self.known_words: list[str] = []
        self.line_word_span: list[tuple[int, int]] = []  # [start, end) index into known_words, per line
        for ln in lines:
            toks = _normalize_words(ln["text"])
            start = len(self.known_words)
            self.known_words.extend(toks)
            self.line_word_span.append((start, len(self.known_words)))
        self.cursor = 0
        self.all_anchors: list[tuple[int, str, float, float]] = []  # (known_idx, word, start_s, end_s)
        self.next_line_to_emit = 0
        self.lead_in_ms: int | None = None
        self.unmatched_line_count = 0
        self.prev_end_ms = 0
        # Real audio time elapsed since the cursor last advanced — bounds how
        # far ahead feed() is allowed to search (see MAX_WORDS_PER_SECOND).
        # Accumulates across consecutive chunks that fail to match anything,
        # so a genuinely quiet/failed chunk doesn't starve the NEXT chunk's
        # search window below what real elapsed time would justify.
        self.elapsed_since_advance_ms = 0
        # Audio-only words (difflib "insert" opcodes — ASR words with no
        # book-side counterpart at all) not yet safe to finalize as a gap.
        # "Safe" means bounded by a real anchor on both sides — words are
        # tagged with the gap_group_id current at the moment they're seen,
        # and gap_group_id only advances when a NEW anchor is accepted, so a
        # run of pending words whose group_id is behind the current counter
        # is guaranteed to have a real anchor after it (mirrors how
        # _finalize_through withholds a line straddling the cursor boundary).
        # A never-closed run (the tail of the book, or content with no anchor
        # ever found) is only finalized at flush() — analogous to front/back
        # matter, which has no anchor on one side by definition.
        self.pending_gap_words: list[dict] = []
        self.gap_group_id = 0
        self.finalized_gap_count = 0

    def _interpolated_time(self, word_idx: int) -> float:
        """Linear interpolate a word's absolute book-relative time (sec)
        from the nearest matched anchors on either side; falls back to
        proportional position in the whole book if there are no anchors at all."""
        anchors = self.all_anchors
        if not anchors:
            frac = word_idx / max(1, len(self.known_words))
            return frac * self.total_ms / 1000
        before = [a for a in anchors if a[0] <= word_idx]
        after = [a for a in anchors if a[0] >= word_idx]
        if before and after and before[-1][0] != after[0][0]:
            b_idx, _, _, b_end = before[-1]
            a_idx, _, a_start, _ = after[0]
            frac = (word_idx - b_idx) / (a_idx - b_idx)
            return b_end + frac * (a_start - b_end)
        if before:
            return before[-1][3]
        return after[0][2]

    def _finalize_through(self, is_final: bool) -> list[dict]:
        out = []
        while self.next_line_to_emit < len(self.lines):
            i = self.next_line_to_emit
            ln = self.lines[i]
            w_start, w_end = self.line_word_span[i]
            if not is_final and w_end > self.cursor:
                break  # straddles the current boundary — wait for more audio
            if w_end <= w_start:
                # Empty line text (shouldn't normally happen) — anchor to the
                # previous line's end so it doesn't collapse to zero duration.
                out.append({"idx": ln["idx"], "start_ms": self.prev_end_ms, "end_ms": self.prev_end_ms, "words": []})
                self.next_line_to_emit += 1
                continue
            line_anchors = [a for a in self.all_anchors if w_start <= a[0] < w_end]
            if line_anchors:
                start_s = min(a[2] for a in line_anchors)
                end_s = max(a[3] for a in line_anchors)
            else:
                self.unmatched_line_count += 1
                start_s = self._interpolated_time(w_start)
                end_s = self._interpolated_time(w_end - 1)
            start_ms, end_ms = round(start_s * 1000), round(end_s * 1000)
            out.append({
                "idx": ln["idx"], "start_ms": start_ms, "end_ms": end_ms,
                "words": [[a[1], round(a[2] * 1000), round(a[3] * 1000)] for a in line_anchors],
            })
            self.prev_end_ms = end_ms
            self.next_line_to_emit += 1
        return out

    def _finalize_gaps(self, is_final: bool) -> list[dict]:
        """Emit any pending audio-only word runs that are now safe to
        finalize — bounded by a real anchor on both sides, i.e. their
        gap_group_id is behind the current (still-open) group. At flush()
        (no more audio coming) the currently-open group is finalized too,
        the same way flush() falls back to interpolation for a trailing line
        with no "after" anchor to wait for."""
        finalize_below = self.gap_group_id + 1 if is_final else self.gap_group_id
        to_finalize = [w for w in self.pending_gap_words if w["group_id"] < finalize_below]
        if not to_finalize:
            return []
        self.pending_gap_words = [w for w in self.pending_gap_words if w["group_id"] >= finalize_below]

        out = []
        bucket: list[dict] = []
        for w in to_finalize:
            if bucket and w["group_id"] != bucket[-1]["group_id"]:
                self._emit_gap_bucket(bucket, out)
                bucket = []
            bucket.append(w)
        self._emit_gap_bucket(bucket, out)
        return out

    def _emit_gap_bucket(self, bucket: list[dict], out: list[dict]) -> None:
        """Coalesce one contiguous same-group run of pending words into a
        single gap record, dropping it silently if it's shorter than the
        applicable floor — MIN_EDGE_GAP_WORDS for a bucket recorded entirely
        before the first anchor or entirely as trailing back-matter (see
        `edge` on _record_gap_words), MIN_GAP_WORDS otherwise. A bucket is
        homogeneous w.r.t. `edge` by construction: gap_group_id (what splits
        buckets) always advances the moment an anchor is accepted, which is
        the same event that ends "before the first anchor"."""
        threshold = MIN_EDGE_GAP_WORDS if all(w["edge"] for w in bucket) else MIN_GAP_WORDS
        if len(bucket) < threshold:
            return
        self.finalized_gap_count += 1
        out.append({
            "start_ms": round(bucket[0]["start"] * 1000),
            "end_ms": round(bucket[-1]["end"] * 1000),
            "text": " ".join(w["word"] for w in bucket),
            "word_count": len(bucket),
        })

    def _record_gap_words(self, words: list[dict], edge: bool = False) -> None:
        for w in words:
            self.pending_gap_words.append({
                "word": w["word"], "start": w["start"], "end": w["end"],
                "group_id": self.gap_group_id, "edge": edge,
            })

    def feed(self, asr_words: list[dict], chunk_duration_ms: int) -> dict:
        """Match one chunk's transcribed words against the still-unresolved
        tail of the book, advance the cursor past whatever's now reliably
        matched, and return any lines/gaps that are now fully resolvable."""
        self.elapsed_since_advance_ms += max(0, chunk_duration_ms)
        remaining_all = self.known_words[self.cursor:]
        if not asr_words:
            return {"lines": [], "gaps": self._finalize_gaps(is_final=False)}

        if not remaining_all:
            # The whole book is already resolved — every word left in this
            # (and any future) chunk is trailing back-matter with nothing to
            # search against; it's all gap candidates under the still-open
            # group. edge=True: no book content follows, so MIN_EDGE_GAP_WORDS
            # applies instead of MIN_GAP_WORDS.
            self._record_gap_words(asr_words, edge=True)
            return {"lines": [], "gaps": self._finalize_gaps(is_final=False)}

        # Bound the search to a plausible lookahead — see MAX_WORDS_PER_SECOND's
        # comment. Grows with elapsed_since_advance_ms so a chunk following one
        # or more chunks that failed to match anything still gets a fair,
        # proportionally larger window rather than being starved — but capped
        # at MAX_LOOKAHEAD_WORDS so a long enough dry spell can't inflate it to
        # "most of the book" (see that constant's comment).
        real_pace_bound = int(self.elapsed_since_advance_ms / 1000 * MAX_WORDS_PER_SECOND)
        max_lookahead = min(MAX_LOOKAHEAD_WORDS, max(MIN_LOOKAHEAD_WORDS, real_pace_bound))
        remaining = remaining_all[:max_lookahead]

        asr_tokens = [_normalize_words(w["word"])[0] if _normalize_words(w["word"]) else "" for w in asr_words]
        matcher = difflib.SequenceMatcher(a=remaining, b=asr_tokens, autojunk=False)
        # Only blocks of MIN_ANCHOR_BLOCK_WORDS+ CONSECUTIVE matched words
        # count as real anchors: a lone matched "this" or "is" is exactly as
        # likely to be a coincidental hit against unrelated front-matter (a
        # publisher's "This is Audible." shares both words with an unrelated
        # book line like "In this world, there is a forest...") as it is to
        # be a genuine anchor. A real spoken match to real book content
        # reliably matches several consecutive words in a row; isolated
        # single/double-word hits are noise, not signal. A block only
        # reachable because MIN_LOOKAHEAD_WORDS's floor or a dry spell
        # inflated the window past what this chunk's OWN elapsed time could
        # plausibly justify (real_pace_bound, uncapped/unfloored) needs a
        # longer, STRICT_ANCHOR_BLOCK_WORDS run instead — see that constant's
        # comment for why "found suspiciously far away" deserves a higher bar.
        new_anchors: list[tuple[int, str, float, float]] = []
        last_anchor_local_idx = -1
        first_block_b: int | None = None
        for block in matcher.get_matching_blocks():
            required = MIN_ANCHOR_BLOCK_WORDS if block.a <= real_pace_bound else STRICT_ANCHOR_BLOCK_WORDS
            if block.size < required:
                continue
            if first_block_b is None:
                first_block_b = block.b
            for i in range(block.size):
                w = asr_words[block.b + i]
                new_anchors.append((self.cursor + block.a + i, w["word"], w["start"], w["end"]))
            last_anchor_local_idx = max(last_anchor_local_idx, block.a + block.size - 1)

        if new_anchors:
            # Leading front-matter: if no anchor has EVER been confirmed
            # before this call, everything in the audio before this call's
            # very FIRST confirmed anchor is audio-only by construction —
            # there's no book content on the open side to legitimately match
            # against. Record it directly instead of relying on the opcode
            # diff below to classify it: a short bumper sharing common words
            # with the real opening line (the exact "This is Audible."/"In
            # this world, there is a forest..." case MIN_ANCHOR_BLOCK_WORDS's
            # comment warns about) fragments into interleaved equal/delete/
            # replace opcodes via coincidental short-word overlap, and only
            # "insert" opcodes are ever recorded as gap text below — a
            # "replace" (e.g. "Audible." pairing against leftover book words)
            # would otherwise be silently dropped instead of surfaced.
            leading_b_end = 0
            if first_block_b and not self.all_anchors:
                self._record_gap_words(asr_words[:first_block_b], edge=True)
                leading_b_end = first_block_b

            # Gap classification needs a SEPARATE, bounded re-diff: `remaining`
            # above still holds hundreds of words of untouched book tail past
            # any anchor found here (bounded only by the lookahead, not by
            # what THIS call actually resolved) — diffing ad-libbed audio
            # against that leftover book text makes difflib call it a
            # "replace" (both sides non-empty, one "explains" the other) since
            # it looks like a substitution for content that, as far as THIS
            # diff knows, hasn't been ruled out yet. Trimming `a` to end
            # exactly at the last anchor accepted above removes that false
            # leftover, so audio past it — sandwiched between two of this
            # call's anchors, or trailing past the last one — correctly comes
            # out as "insert" (a-side genuinely exhausted) instead.
            bounded_remaining = remaining[:last_anchor_local_idx + 1]
            gap_matcher = difflib.SequenceMatcher(a=bounded_remaining, b=asr_tokens, autojunk=False)
            for tag, i1, i2, j1, j2 in gap_matcher.get_opcodes():
                if j2 <= leading_b_end:
                    continue  # already handled as leading front-matter above
                if tag == "equal" and (i2 - i1) >= MIN_ANCHOR_BLOCK_WORDS:
                    # Anything pending before this point is now bracketed by
                    # this anchor on its "after" side — a later insert run
                    # starts a new, still-open group needing its own closer.
                    self.gap_group_id += 1
                elif tag == "insert" and j2 > j1:
                    self._record_gap_words(asr_words[max(j1, leading_b_end):j2], edge=False)

        if not new_anchors:
            return {"lines": [], "gaps": self._finalize_gaps(is_final=False)}

        if self.lead_in_ms is None:
            self.lead_in_ms = round(min(a[2] for a in new_anchors) * 1000)
        self.all_anchors.extend(new_anchors)
        self.all_anchors.sort(key=lambda a: a[0])
        self.cursor = max(self.cursor, max(a[0] for a in new_anchors) + 1)
        self.elapsed_since_advance_ms = 0
        return {"lines": self._finalize_through(is_final=False), "gaps": self._finalize_gaps(is_final=False)}

    def flush(self) -> dict:
        """Finalize everything still unresolved — no more audio is coming,
        so any remaining lines fall back to interpolation against the final
        anchor set instead of waiting for an "after" anchor that won't arrive,
        and any still-open gap group (trailing back-matter, or a book with no
        anchors at all) is finalized too instead of waiting for a bracket
        that will never come."""
        if self.lead_in_ms is None:
            self.lead_in_ms = 0
        return {"lines": self._finalize_through(is_final=True), "gaps": self._finalize_gaps(is_final=True)}

    def meta(self) -> dict:
        return {
            "lead_in_ms": self.lead_in_ms or 0,
            "unmatched_line_count": self.unmatched_line_count,
            "gap_count": self.finalized_gap_count,
        }


def _align_stream(m4b_path: str, lines: list[dict], resume_ms: int = 0) -> Iterator[str]:
    try:
        total_ms = _probe_duration_ms(m4b_path)
        aligner = IncrementalAligner(lines, total_ms)

        def row(new_lines, new_gaps, processed_ms):
            return json.dumps({
                "status": "chunk", "lines": new_lines, "gaps": new_gaps,
                "processed_ms": processed_ms, "total_ms": total_ms,
                "meta": {"asr_device": ASR_DEVICE, "align_device": ALIGN_DEVICE, **aligner.meta()},
            }) + "\n"

        for start_ms, end_ms in _chunk_bounds(total_ms, resume_ms):
            try:
                asr_words = _transcribe_chunk(m4b_path, start_ms, end_ms)
            except Exception:  # one bad window must not abort the whole run
                log.exception("transcription failed for window %sms-%sms", start_ms, end_ms)
                asr_words = []
            result = aligner.feed(asr_words, end_ms - start_ms)
            yield row(result["lines"], result["gaps"], end_ms)

        final = aligner.flush()
        if final["lines"] or final["gaps"]:
            yield row(final["lines"], final["gaps"], total_ms)

        yield json.dumps({
            "status": "done",
            "meta": {"asr_device": ASR_DEVICE, "align_device": ALIGN_DEVICE, **aligner.meta()},
        }) + "\n"
    except Exception as e:
        log.exception("full-book alignment failed")
        yield json.dumps({"status": "error", "error": str(e)}) + "\n"
    finally:
        Path(m4b_path).unlink(missing_ok=True)


@app.post("/align")
async def align(m4b: UploadFile = File(...), lines: str = Form(...), resume_ms: int = Form(0)):
    # Resuming an interrupted alignment (a refresh/crash mid-book — see
    # docs/M4B_FIRST_FLOW.md's "Resuming an interrupted transcription", the
    # same client-side checkpoint pattern applies here): the CALLER is
    # responsible for trimming `lines` down to only the lines NOT already
    # resolved in its cached manifest before sending — the aligner's word
    # indexing is relative to whatever `lines` it's given, so a truncated
    # list naturally starts matching against audio from resume_ms onward
    # with no extra bookkeeping needed here.
    lines_parsed = json.loads(lines)
    with tempfile.NamedTemporaryFile(suffix=".m4b", delete=False) as tmp:
        tmp.write(await m4b.read())
        m4b_path = tmp.name
    if resume_ms > 0:
        log.info("resuming alignment of %s remaining line(s) from %s at %sms", len(lines_parsed), m4b.filename, resume_ms)
    else:
        log.info("aligning %s line(s) from %s", len(lines_parsed), m4b.filename)
    return StreamingResponse(
        _align_stream(m4b_path, lines_parsed, resume_ms=resume_ms), media_type="application/x-ndjson",
    )


# ── M4B-first transcription (no known script) ────────────────────────────────
# Powers the M4B-first flow (docs/M4B_FIRST_FLOW.md): the audiobook is the ONLY
# input, so there's nothing to fuzzy-match against — we just transcribe the
# whole file and hand back the raw word-timed transcript, grouped into
# sentences. That transcript IS the book text: it drives the minimal karaoke
# reader immediately, and later gets fed to the normal extraction pipeline as
# `body_text` to retro-generate scenes/characters.
#
# Contract is deliberately engine-agnostic (the ASR happens to be WhisperX
# today; an MLX backend can replace _transcribe_chunk later without any client
# change):
#
#   POST /transcribe   multipart form: m4b (the whole audiobook file)
#   -> streamed NDJSON, one row per processed time-window plus a final marker:
#      {"status":"chunk",
#       "lines":[{"idx":int,"text":str,"start_ms":int,"end_ms":int,
#                 "words":[[word,start_ms,end_ms], ...]}, ...],
#       "processed_ms":int, "total_ms":int,
#       "meta":{"asr_device":str,"align_device":str,"model":str}}
#      {"status":"done","line_count":int,"total_ms":int,"meta":{...}}
#    `lines` on a "chunk" row are only the sentences newly transcribed in THAT
#    window (globally-indexed, contiguous), so a client can render them the
#    moment they arrive instead of waiting for "done" — same incremental
#    contract as /align.

# A sentence ends on .!? (or … ), allowing trailing closing quotes/brackets so
# `stones."` or `now!"` close the sentence rather than starting the next one on
# the quote. Word tokens from WhisperX carry their own trailing punctuation.
_SENT_END_RE = re.compile(r"[.!?…][\"'”’)\]]*$")


def _words_to_sentences(words: list[dict], start_idx: int) -> list[dict]:
    """Group a flat, time-ordered word stream (whole-file seconds, from
    _transcribe_chunk) into sentence lines carrying per-word ms timings. The
    reader boldens the active sentence and typewriters word-by-word off these
    timings; the vaepack and retro-extraction both consume `text`."""
    lines: list[dict] = []
    cur: list[dict] = []

    def flush():
        nonlocal cur
        if not cur:
            return
        text = " ".join(w["word"].strip() for w in cur).strip()
        if not text:
            cur = []
            return
        lines.append({
            "text": text,
            "start_ms": round(cur[0]["start"] * 1000),
            "end_ms": round(cur[-1]["end"] * 1000),
            "words": [[w["word"].strip(), round(w["start"] * 1000), round(w["end"] * 1000)] for w in cur],
        })
        cur = []

    for w in words:
        cur.append(w)
        if _SENT_END_RE.search(w["word"].strip()):
            flush()
    flush()  # trailing fragment with no terminal punctuation is still a line

    for i, ln in enumerate(lines):
        ln["idx"] = start_idx + i
    return lines


def _transcribe_stream(m4b_path: str, resume_ms: int = 0, resume_idx: int = 0) -> Iterator[str]:
    try:
        total_ms = _probe_duration_ms(m4b_path)
        next_idx = resume_idx
        for start_ms, end_ms in _chunk_bounds(total_ms, resume_ms):
            try:
                asr_words = _transcribe_chunk(m4b_path, start_ms, end_ms)
            except Exception:  # one bad window must not abort the whole run
                log.exception("transcription failed for window %sms-%sms", start_ms, end_ms)
                asr_words = []
            new_lines = _words_to_sentences(asr_words, next_idx)
            next_idx += len(new_lines)
            yield json.dumps({
                "status": "chunk", "lines": new_lines,
                "processed_ms": end_ms, "total_ms": total_ms,
                "meta": {"asr_device": ASR_DEVICE, "align_device": ALIGN_DEVICE, "model": ASR_MODEL},
            }) + "\n"

        yield json.dumps({
            "status": "done", "line_count": next_idx, "total_ms": total_ms,
            "meta": {"asr_device": ASR_DEVICE, "align_device": ALIGN_DEVICE, "model": ASR_MODEL},
        }) + "\n"
    except Exception as e:
        log.exception("full-book transcription failed")
        yield json.dumps({"status": "error", "error": str(e)}) + "\n"
    finally:
        Path(m4b_path).unlink(missing_ok=True)


@app.post("/transcribe")
async def transcribe(m4b: UploadFile = File(...), resume_ms: int = Form(0), resume_idx: int = Form(0)):
    with tempfile.NamedTemporaryFile(suffix=".m4b", delete=False) as tmp:
        tmp.write(await m4b.read())
        m4b_path = tmp.name
    if resume_ms > 0:
        log.info("resuming transcription (M4B-first) %s at %sms (idx %s)", m4b.filename, resume_ms, resume_idx)
    else:
        log.info("transcribing (M4B-first) %s", m4b.filename)
    return StreamingResponse(
        _transcribe_stream(m4b_path, resume_ms=resume_ms, resume_idx=resume_idx),
        media_type="application/x-ndjson",
    )


if __name__ == "__main__":
    import uvicorn

    # 0.0.0.0 (not 127.0.0.1) so a phone/other device on the same LAN can
    # reach this for the M4B-first flow (docs/M4B_FIRST_FLOW.md) — matches
    # vite.config.js's server.host:true for the same reason. This is a local
    # dev tool (no auth), so anyone on the LAN can reach it; fine for a home
    # network, override via ALIGN_SERVER_HOST if that's ever a concern.
    host = os.environ.get("ALIGN_SERVER_HOST", "0.0.0.0")
    port = int(os.environ.get("ALIGN_SERVER_PORT", "7861"))
    log.info("starting on %s:%s (set ALIGN_SERVER_HOST=127.0.0.1 to restrict to this machine only)", host, port)
    uvicorn.run(app, host=host, port=port)
