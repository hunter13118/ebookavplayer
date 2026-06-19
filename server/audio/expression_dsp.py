"""Apply voiceExpression DSP atoms via ffmpeg (optional — skipped if unavailable)."""
from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)


def _ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def _atom_to_filter(atom: dict[str, Any]) -> str | None:
    t = atom.get("type")
    if t == "highpass":
        return f"highpass=f={int(atom.get('freqHz', 800))}"
    if t == "lowpass":
        return f"lowpass=f={int(atom.get('freqHz', 6000))}"
    if t == "highshelf":
        g = float(atom.get("gainDb", 0))
        f = int(atom.get("freqHz", 3000))
        return f"equalizer=f={f}:t=h:width=1:g={g}"
    if t == "gain":
        db = float(atom.get("db", 0))
        return f"volume={db}dB"
    if t == "compressor":
        th = float(atom.get("thresholdDb", -18))
        ratio = float(atom.get("ratio", 4))
        att = float(atom.get("attackMs", 5)) / 1000
        rel = float(atom.get("releaseMs", 80)) / 1000
        return f"acompressor=threshold={th}dB:ratio={ratio}:attack={att}:release={rel}"
    if t == "saturation":
        drive = float(atom.get("driveDb", 3))
        return f"afftdn=nf=-25,alimiter=limit=0.95,volume={drive/6}dB"
    if t == "delay":
        ms = int(atom.get("timeMs", 120))
        fb = float(atom.get("feedback", 0.35))
        return f"aecho=0.8:0.9:{ms}|{int(ms*1.7)}:{fb}"
    if t == "reverb":
        wet = float(atom.get("wet", 0.25))
        decay = float(atom.get("decaySec", 1.0))
        return f"aecho=0.8:0.88:{int(decay*200)}|{int(decay*400)}:{wet}"
    if t == "noise_blend":
        # Simplified: skip noise blend without sidechain (TODO: proper gated mix).
        return None
    return None


def apply_dsp_plan(mp3_bytes: bytes, dsp_atoms: list[dict[str, Any]]) -> bytes:
    """Return processed MP3, or original bytes if ffmpeg missing / no filters."""
    if not dsp_atoms or not mp3_bytes:
        return mp3_bytes
    if not _ffmpeg_available():
        log.debug("ffmpeg not found — skipping expression DSP")
        return mp3_bytes

    filters = [f for a in dsp_atoms if (f := _atom_to_filter(a))]
    if not filters:
        return mp3_bytes

    chain = ",".join(filters)
    with tempfile.TemporaryDirectory() as tmp:
        inp = Path(tmp) / "in.mp3"
        out = Path(tmp) / "out.mp3"
        inp.write_bytes(mp3_bytes)
        try:
            subprocess.run(
                ["ffmpeg", "-y", "-i", str(inp), "-af", chain, str(out)],
                check=True,
                capture_output=True,
                timeout=30,
            )
            if out.is_file() and out.stat().st_size > 0:
                return out.read_bytes()
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
            log.warning("expression DSP failed: %s", e)
    return mp3_bytes
