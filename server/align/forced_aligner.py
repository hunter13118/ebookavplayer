"""Forced-aligner backends + orchestration for Algorithm 4.

The zero-drift distributor here MIRRORS web/src/timing/distribute.js exactly
(cumulative-boundary rounding) so the local fallback produces the same
millisecond-exact timelines the client algorithms do.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

MANIFEST_NAME = "manifest.json"
AUDIO_ENGINE_FORCED = "forced-aligner"


@dataclass
class LineTiming:
    line_idx: int
    start_ms: int
    end_ms: int

    def as_entry(self) -> dict:
        return {"line_idx": self.line_idx, "start_ms": self.start_ms, "end_ms": self.end_ms}


@dataclass
class _Slide:
    line_index: int
    chapter: int
    text: str

    @property
    def char_count(self) -> int:
        return len(self.text)


# --------------------------------------------------------------------------- #
# Pure helpers (mirror the JS engine)                                          #
# --------------------------------------------------------------------------- #
def slides_by_chapter(playback: dict) -> list[dict]:
    """Flatten playback.scenes into chapter-grouped slides, preserving the global
    zero-based line index (same index the client orchestrator uses)."""
    by_chapter: dict[int, list[_Slide]] = {}
    order: list[int] = []
    line_index = 0
    for scene in playback.get("scenes") or []:
        chapter = scene.get("chapter")
        chapter = int(chapter) if isinstance(chapter, (int, float)) else 0
        for line in scene.get("lines") or []:
            text = line.get("text") if isinstance(line.get("text"), str) else ""
            if chapter not in by_chapter:
                by_chapter[chapter] = []
                order.append(chapter)
            by_chapter[chapter].append(_Slide(line_index, chapter, text))
            line_index += 1
    return [{"chapter": ch, "slides": by_chapter[ch]} for ch in order]


def distribute_proportional(total_ms: int, weights: list[float]) -> list[int]:
    """Zero-drift integer distribution. sum(result) == round(total_ms) EXACTLY.

    Cumulative-boundary rounding: round each cumulative position against the
    global total, then take adjacent differences. Mirrors distribute.js.
    """
    if total_ms < 0:
        raise ValueError(f"total_ms must be >= 0, got {total_ms}")
    total = round(total_ms)
    n = len(weights)
    if n == 0:
        return []
    for i, w in enumerate(weights):
        if w < 0:
            raise ValueError(f"weight[{i}] must be >= 0, got {w}")
    s = sum(weights)
    effective = weights if s > 0 else [1.0] * n
    eff_sum = s if s > 0 else float(n)

    boundaries = [0]
    cum = 0.0
    for w in effective:
        cum += w
        boundaries.append(round((cum / eff_sum) * total))
    return [boundaries[i + 1] - boundaries[i] for i in range(n)]


# --------------------------------------------------------------------------- #
# Aligner backends                                                            #
# --------------------------------------------------------------------------- #
class ForcedAligner:
    """Abstract aligner. Subclasses turn (chapters, total_ms) into LineTimings."""

    name = "abstract"

    def available(self) -> bool:  # pragma: no cover - trivial
        return False

    def align(self, chapters: list[dict], total_ms: int) -> list[LineTiming]:
        raise NotImplementedError


class ProportionalStubAligner(ForcedAligner):
    """Deterministic, dependency-free fallback. Distributes the audio duration
    across lines by character count with zero drift. Not acoustic — but stable,
    testable, and always available so the endpoint works with no aligner binary."""

    name = "stub"

    def available(self) -> bool:
        return True

    def align(self, chapters: list[dict], total_ms: int) -> list[LineTiming]:
        all_slides: list[_Slide] = [s for ch in chapters for s in ch["slides"]]
        weights = [s.char_count for s in all_slides]
        durations = distribute_proportional(total_ms, weights)
        out: list[LineTiming] = []
        cursor = 0
        for slide, dur in zip(all_slides, durations):
            out.append(LineTiming(slide.line_index, cursor, cursor + dur))
            cursor += dur
        return out


class _BinaryAligner(ForcedAligner):
    """Shared skeleton for real aligners that shell out to a host binary."""

    binary = ""

    def available(self) -> bool:
        return bool(self.binary) and shutil.which(self.binary) is not None

    def _run(self, args: list[str]) -> str:
        proc = subprocess.run(  # noqa: S603 - host-local, operator-invoked
            [self.binary, *args],
            capture_output=True,
            text=True,
            check=True,
        )
        return proc.stdout


class AeneasAligner(_BinaryAligner):
    """Aeneas (https://github.com/readbeyond/aeneas) forced aligner.

    Drop-in point: pipe the .m4b + plaintext script (one fragment per line) through
    `python -m aeneas.tools.execute_task` and parse the JSON sync map back into
    LineTimings. Raises if the binary/module is not installed on the host.

    Implementation note: don't buffer the whole audio file or the whole alignment
    result in memory for a 10-hour book. Stream the audio into the subprocess's
    stdin and parse its (newline-delimited JSON, if the chosen aligner supports it)
    stdout line-by-line as results arrive — `asyncio.create_subprocess_exec(...,
    stdin=PIPE, stdout=PIPE)` plus an async stdout-line reader, not `subprocess.run`.
    A word-level alignment (timing per word, not per line) gives more accurate line
    boundaries than a coarser per-fragment sync map — group word timings back up to
    LineTimings by locating each line's first/last word."""

    name = "aeneas"
    binary = "python"  # invoked as `python -m aeneas.tools.execute_task`

    def available(self) -> bool:
        try:
            import importlib.util

            return importlib.util.find_spec("aeneas") is not None
        except Exception:
            return False

    def align(self, chapters: list[dict], total_ms: int) -> list[LineTiming]:  # pragma: no cover
        raise NotImplementedError(
            "AeneasAligner.align: wire `python -m aeneas.tools.execute_task` here "
            "(emit one text fragment per line, parse the sync map JSON into LineTimings)."
        )


class MmsAligner(_BinaryAligner):
    """Meta MMS forced aligner (torchaudio CTC alignment). Drop-in point: run the
    CTC aligner over the decoded audio + per-line transcript. Raises if absent.
    See AeneasAligner's docstring for the streaming-subprocess + word-level-token
    implementation note; it applies here too."""

    name = "mms"
    binary = "mms-align"

    def align(self, chapters: list[dict], total_ms: int) -> list[LineTiming]:  # pragma: no cover
        raise NotImplementedError(
            "MmsAligner.align: wire the torchaudio MMS CTC aligner here."
        )


_REGISTRY: dict[str, type[ForcedAligner]] = {
    "stub": ProportionalStubAligner,
    "aeneas": AeneasAligner,
    "mms": MmsAligner,
}


def get_aligner(prefer: str | None = None) -> ForcedAligner:
    """Return the preferred aligner if available, else the best available real one,
    else the always-available stub."""
    if prefer:
        cls = _REGISTRY.get(prefer)
        if cls:
            inst = cls()
            if inst.available():
                return inst
    for key in ("aeneas", "mms"):
        inst = _REGISTRY[key]()
        if inst.available():
            return inst
    return ProportionalStubAligner()


# --------------------------------------------------------------------------- #
# Duration probing + orchestration                                            #
# --------------------------------------------------------------------------- #
def _probe_total_ms(m4b_path: str | None) -> int | None:
    """Best-effort media-duration probe without requiring native ffmpeg.
    Uses mutagen if importable; returns None if it can't determine a duration."""
    if not m4b_path:
        return None
    p = Path(m4b_path)
    if not p.is_file():
        return None
    try:
        from mutagen.mp4 import MP4  # type: ignore

        info = MP4(str(p)).info
        if info and getattr(info, "length", None):
            return int(round(info.length * 1000))
    except Exception:
        return None
    return None


def _estimate_total_ms(chapters: list[dict]) -> int:
    """Deterministic last-resort duration when nothing else is known: a coarse
    per-line reading-time estimate (~165 wpm + 400ms floor per line)."""
    total = 0
    for ch in chapters:
        for slide in ch["slides"]:
            words = len([w for w in slide.text.split() if w])
            total += max(400, int(round(words / 165 * 60 * 1000)))
    return total


def align_book(
    book_id: str,
    audio_dir: Path,
    books_loader: Callable[[str], dict | None],
    *,
    total_ms: int | None = None,
    m4b_path: str | None = None,
    prefer: str | None = None,
) -> dict:
    """Run alignment for a book and persist the manifest the player consumes.

    Returns the manifest dict. Writes AUDIO_DIR/{book_id}/manifest.json with a
    `lines: [{line_idx, start_ms, end_ms}]` array (ExternalAudioPack-compatible),
    plus the aligner name + m4b reference as extra top-level metadata.
    """
    playback = books_loader(book_id)
    if playback is None:
        raise FileNotFoundError(f"no such book: {book_id}")

    chapters = slides_by_chapter(playback)

    resolved_total = total_ms
    duration_source = "request"
    if resolved_total is None:
        resolved_total = _probe_total_ms(m4b_path)
        duration_source = "probe"
    if resolved_total is None:
        resolved_total = _estimate_total_ms(chapters)
        duration_source = "estimate"

    aligner = get_aligner(prefer)
    timings = aligner.align(chapters, int(resolved_total))

    lines = [t.as_entry() for t in sorted(timings, key=lambda t: t.line_idx)]
    manifest = {
        "book_id": book_id,
        "audio_engine": AUDIO_ENGINE_FORCED,
        "aligner": aligner.name,
        "source": "align",
        "m4b": m4b_path,
        "total_ms": int(resolved_total),
        "duration_source": duration_source,
        "line_count": len(lines),
        "lines": lines,
    }

    root = audio_dir / book_id
    root.mkdir(parents=True, exist_ok=True)
    (root / MANIFEST_NAME).write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest
