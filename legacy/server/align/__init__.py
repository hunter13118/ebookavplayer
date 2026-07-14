"""ALGORITHM 4 — Local Phonetic Forced-Aligner ("Smart Offline").

The heavy acoustic alignment runs on the user's OWN machine (this FastAPI tier),
never in the stateless edge. It accepts a book id (+ an optional server-readable
.m4b path) and emits a per-line millisecond timeline in the SAME manifest shape the
player already consumes (server/pack/external_audio.py + GET /books/{id}/audio/manifest),
so the result drops straight into the existing offline-audio path.

Pluggable backends:
  * ProportionalStubAligner  — deterministic, dependency-free, zero-drift. Always
                               available; used in CI and as the universal fallback.
  * AeneasAligner / MmsAligner — real acoustic aligners; used iff their binaries
                               are installed on the host. Drop-in skeletons.
"""

from .forced_aligner import (
    ForcedAligner,
    ProportionalStubAligner,
    AeneasAligner,
    MmsAligner,
    LineTiming,
    align_book,
    get_aligner,
    slides_by_chapter,
    distribute_proportional,
)

__all__ = [
    "ForcedAligner",
    "ProportionalStubAligner",
    "AeneasAligner",
    "MmsAligner",
    "LineTiming",
    "align_book",
    "get_aligner",
    "slides_by_chapter",
    "distribute_proportional",
]
