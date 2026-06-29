"""External (non-Edge) line audio from audiobook-maker or manual import."""
from __future__ import annotations

import io
import json
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import format as F

MANIFEST_NAME = "manifest.json"
LINES_DIR = "lines"


@dataclass
class ExternalAudioPack:
    book_id: str
    root: Path
    lines: dict[int, dict] = field(default_factory=dict)  # line_idx -> entry

    @classmethod
    def load(cls, book_id: str, audio_root: Path) -> "ExternalAudioPack | None":
        manifest_p = audio_root / book_id / MANIFEST_NAME
        if not manifest_p.is_file():
            return None
        try:
            raw = json.loads(manifest_p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        pack = cls(book_id=book_id, root=audio_root / book_id)
        for entry in raw.get("lines") or []:
            idx = int(entry["line_idx"])
            pack.lines[idx] = entry
        return pack if pack.lines else None

    def has_audio(self) -> bool:
        return bool(self.lines)

    def line_count(self) -> int:
        return len(self.lines)

    def get_line_bytes(self, line_idx: int) -> bytes | None:
        entry = self.lines.get(line_idx)
        if not entry:
            return None
        rel = entry.get("file") or entry.get("path") or f"{LINES_DIR}/{line_idx:06d}.mp3"
        if rel.startswith("/"):
            rel = rel.lstrip("/")
        path = self.root / rel
        if not path.is_file():
            # flat lines/000000.mp3 fallback
            alt = self.root / LINES_DIR / f"{line_idx:06d}.mp3"
            if alt.is_file():
                path = alt
            else:
                alt_wav = self.root / LINES_DIR / f"{line_idx:06d}.wav"
                path = alt_wav if alt_wav.is_file() else path
        try:
            return path.read_bytes() if path.is_file() else None
        except OSError:
            return None

    def manifest_entries_for_pack(self) -> list[dict]:
        out = []
        for idx in sorted(self.lines):
            entry = self.lines[idx]
            data = self.get_line_bytes(idx)
            pack_path = f"{F.AUDIO_PREFIX}{idx:06d}.mp3"
            out.append({
                "line_idx": idx,
                "path": pack_path,
                "bytes": len(data) if data else 0,
                "start_ms": entry.get("start_ms"),
                "end_ms": entry.get("end_ms"),
            })
        return out

    def as_dict(self) -> dict[str, Any]:
        return {
            "book_id": self.book_id,
            "audio_engine": F.AUDIO_ENGINE_EXTERNAL,
            "line_count": self.line_count(),
            "lines": [
                {**self.lines[i], "line_idx": i}
                for i in sorted(self.lines)
            ],
        }


def write_external_manifest(book_id: str, audio_root: Path, lines: list[dict]) -> Path:
    root = audio_root / book_id
    root.mkdir(parents=True, exist_ok=True)
    (root / LINES_DIR).mkdir(exist_ok=True)
    manifest = {
        "book_id": book_id,
        "audio_engine": F.AUDIO_ENGINE_EXTERNAL,
        "source": "import",
        "lines": lines,
    }
    mp = root / MANIFEST_NAME
    mp.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return mp


def import_external_zip(book_id: str, zip_bytes: bytes, audio_root: Path) -> ExternalAudioPack:
    """Import vae/audio/* zip or flat lines/*.mp3 archive."""
    root = audio_root / book_id
    lines_dir = root / LINES_DIR
    root.mkdir(parents=True, exist_ok=True)
    lines_dir.mkdir(exist_ok=True)

    manifest_lines: list[dict] = []
    with zipfile.ZipFile(io.BytesIO(zip_bytes), "r") as zf:
        # vae-offline-pack audio section
        if F.AUDIO_MANIFEST_NAME in zf.namelist():
            audio_manifest = json.loads(zf.read(F.AUDIO_MANIFEST_NAME))
            for item in audio_manifest:
                idx = int(item["line_idx"])
                src = item["path"]
                if src not in zf.namelist():
                    continue
                dest_name = f"{idx:06d}.mp3"
                (lines_dir / dest_name).write_bytes(zf.read(src))
                entry: dict[str, Any] = {
                    "line_idx": idx,
                    "file": f"{LINES_DIR}/{dest_name}",
                }
                if item.get("start_ms") is not None:
                    entry["start_ms"] = item["start_ms"]
                if item.get("end_ms") is not None:
                    entry["end_ms"] = item["end_ms"]
                manifest_lines.append(entry)
        else:
            for name in zf.namelist():
                base = Path(name).name
                if not base.endswith((".mp3", ".wav", ".m4a")):
                    continue
                stem = Path(base).stem
                try:
                    idx = int(stem)
                except ValueError:
                    continue
                dest_name = f"{idx:06d}{Path(base).suffix}"
                (lines_dir / dest_name).write_bytes(zf.read(name))
                manifest_lines.append({
                    "line_idx": idx,
                    "file": f"{LINES_DIR}/{dest_name}",
                })

    if not manifest_lines:
        raise ValueError("no audio lines found in archive")

    write_external_manifest(book_id, audio_root, manifest_lines)
    pack = ExternalAudioPack.load(book_id, audio_root)
    if not pack:
        raise ValueError("import failed")
    return pack


def delete_external_audio(book_id: str, audio_root: Path) -> bool:
    root = audio_root / book_id
    if not root.exists():
        return False
    import shutil
    shutil.rmtree(root)
    return True
