"""Build and parse vae-offline-pack ZIP archives."""
from __future__ import annotations

import hashlib
import io
import json
import re
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from ..playback.compile import _media_path_from_url
from . import format as F

ProgressCb = Callable[[float, str], None] | None

_MEDIA_URL_RE = re.compile(r"/media/[^\"'\s)]+")


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def collect_media_urls(book: dict) -> set[str]:
    """Gather unique /media/... URLs referenced by compiled playback JSON."""
    raw = json.dumps(book, ensure_ascii=False)
    found = set(_MEDIA_URL_RE.findall(raw))
    # Normalize: strip cache-bust query for dedup + stable pack paths.
    return {u.split("?", 1)[0] for u in found if u.startswith("/media/")}


def _pack_media_path(server_url: str) -> str:
    """Map /media/book/style/file.png → vae/media/files/book/style/file.png"""
    rel = server_url.removeprefix("/media/")
    return f"{F.MEDIA_PREFIX}{rel}"


def _line_audio_name(line_idx: int) -> str:
    return f"{F.AUDIO_PREFIX}{line_idx:06d}.mp3"


async def build_pack_bytes(
    book: dict,
    *,
    tier: str,
    style: str,
    voices: dict | None = None,
    resume: dict | None = None,
    synthesize_line: Callable | None = None,
    external_audio: Any | None = None,
    on_progress: ProgressCb = None,
    should_cancel: Callable[[], bool] | None = None,
) -> bytes:
    """Assemble a vae-offline-pack ZIP.

    Audiobook tier: prefers `external_audio` (ExternalAudioPack), else `synthesize_line`.
    """
    if tier not in F.VALID_TIERS:
        raise ValueError(f"invalid tier: {tier}")

    def cancelled() -> bool:
        return bool(should_cancel and should_cancel())

    book_id = book.get("book_id") or "unknown"
    media_urls = sorted(collect_media_urls(book))
    media_index: dict[str, str] = {}
    buf = io.BytesIO()

    lines_flat: list[dict] = []
    for scene in book.get("scenes") or []:
        lines_flat.extend(scene.get("lines") or [])

    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        book_copy = json.loads(json.dumps(book))
        if resume:
            book_copy["resume"] = resume
        book_bytes = json.dumps(book_copy, ensure_ascii=False, indent=2).encode("utf-8")
        zf.writestr(F.BOOK_NAME, book_bytes)

        voices_payload = voices or book.get("voice_overrides") or {}
        zf.writestr(F.VOICES_NAME, json.dumps(voices_payload, ensure_ascii=False, indent=2).encode("utf-8"))

        total_media = max(len(media_urls), 1)
        for i, url in enumerate(media_urls):
            if cancelled():
                raise InterruptedError("pack build cancelled")
            p = _media_path_from_url(url)
            pack_path = _pack_media_path(url)
            media_index[url] = pack_path
            if p and p.is_file():
                zf.write(p, pack_path)
            if on_progress:
                on_progress((i + 1) / total_media * 0.5, f"media {i + 1}/{len(media_urls)}")

        zf.writestr(F.MEDIA_INDEX_NAME, json.dumps(media_index, indent=2).encode("utf-8"))

        audio_manifest: list[dict] = []
        audio_engine = None
        if tier == F.TIER_AUDIOBOOK:
            use_external = external_audio is not None and external_audio.has_audio()
            if use_external:
                audio_engine = F.AUDIO_ENGINE_EXTERNAL
            elif synthesize_line is not None:
                audio_engine = F.AUDIO_ENGINE_EDGE
            else:
                raise ValueError("audiobook tier requires external audio or synthesize_line")

            speakable = [ln for ln in lines_flat if (ln.get("text") or "").strip()]
            total_audio = max(len(speakable), 1)
            for j, ln in enumerate(speakable):
                if cancelled():
                    raise InterruptedError("pack build cancelled")
                idx = int(ln.get("idx", j))
                audio = None
                if use_external:
                    audio = external_audio.get_line_bytes(idx)
                if not audio and synthesize_line:
                    audio = await synthesize_line(ln, voices_payload)
                if audio:
                    ap = _line_audio_name(idx)
                    zf.writestr(ap, audio)
                    entry = {
                        "line_idx": idx,
                        "path": ap,
                        "bytes": len(audio),
                    }
                    if use_external:
                        ext_entry = external_audio.lines.get(idx) or {}
                        if ext_entry.get("start_ms") is not None:
                            entry["start_ms"] = ext_entry["start_ms"]
                        if ext_entry.get("end_ms") is not None:
                            entry["end_ms"] = ext_entry["end_ms"]
                    audio_manifest.append(entry)
                if on_progress:
                    on_progress(0.5 + (j + 1) / total_audio * 0.5, f"audio {j + 1}/{len(speakable)}")

            zf.writestr(F.AUDIO_MANIFEST_NAME, json.dumps(audio_manifest, indent=2).encode("utf-8"))

        manifest = {
            "format": F.FORMAT_ID,
            "format_version": F.FORMAT_VERSION,
            "pack_id": f"{book_id}@{style}@{tier}",
            "book_id": book_id,
            "title": book.get("title", book_id),
            "author": book.get("author", ""),
            "tier": tier,
            "style": style,
            "audio_engine": audio_engine,
            "created_at": _utc_now(),
            "media_count": len(media_index),
            "audio_line_count": len(audio_manifest),
            "line_count": len(lines_flat),
        }
        zf.writestr(F.MANIFEST_NAME, json.dumps(manifest, indent=2).encode("utf-8"))

    return buf.getvalue()


def read_pack_manifest(zip_bytes: bytes) -> dict[str, Any]:
    with zipfile.ZipFile(io.BytesIO(zip_bytes), "r") as zf:
        if F.MANIFEST_NAME not in zf.namelist():
            raise ValueError("missing vae/manifest.json")
        manifest = json.loads(zf.read(F.MANIFEST_NAME))
    if manifest.get("format") != F.FORMAT_ID:
        raise ValueError("not a vae-offline-pack")
    if manifest.get("format_version", 0) != F.FORMAT_VERSION:
        raise ValueError("unsupported pack format version")
    return manifest


def import_pack_to_server(zip_bytes: bytes, *, media_root: Path, books_dir: Path) -> dict[str, Any]:
    """Extract pack into server data dirs (upload path for web → server sync)."""
    with zipfile.ZipFile(io.BytesIO(zip_bytes), "r") as zf:
        manifest = json.loads(zf.read(F.MANIFEST_NAME))
        book = json.loads(zf.read(F.BOOK_NAME))
        book_id = manifest["book_id"]
        style = manifest["style"]

        media_index = json.loads(zf.read(F.MEDIA_INDEX_NAME))
        for server_url, pack_path in media_index.items():
            if pack_path not in zf.namelist():
                continue
            rel = server_url.removeprefix("/media/")
            dest = media_root / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(zf.read(pack_path))

        # Persist compiled book snapshot for legacy fallback.
        book_path = books_dir / f"{book_id}.json"
        book_path.write_text(json.dumps(book, ensure_ascii=False, indent=2), encoding="utf-8")

        return {"ok": True, "book_id": book_id, "style": style, "manifest": manifest}
