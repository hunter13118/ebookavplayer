"""Persist EPUB embedded images and map illustration_ref indices → URLs."""
from __future__ import annotations

from pathlib import Path


def _guess_ext(blob: bytes) -> str:
    if blob[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if blob[:2] == b"\xff\xd8":
        return ".jpg"
    if len(blob) > 12 and blob[:4] == b"RIFF" and blob[8:12] == b"WEBP":
        return ".webp"
    return ".jpg"


def persist_extracted_images(
    book_id: str,
    images: list[bytes],
    media_root: Path,
) -> dict[int, str]:
    """Write raw EPUB images to disk; return {index: /media/... url}."""
    urls: dict[int, str] = {}
    if not images:
        return urls
    dest = media_root / book_id / "illustrations"
    dest.mkdir(parents=True, exist_ok=True)
    for i, blob in enumerate(images):
        if not blob:
            continue
        ext = _guess_ext(blob)
        fname = f"img_{i:02d}{ext}"
        (dest / fname).write_bytes(blob)
        urls[i] = f"/media/{book_id}/illustrations/{fname}"
    return urls


def load_image_index(media_root: Path, book_id: str) -> dict[int, str]:
    """Rebuild index from persisted illustration files (for re-ingest / tests)."""
    d = media_root / book_id / "illustrations"
    if not d.is_dir():
        return {}
    out: dict[int, str] = {}
    for p in sorted(d.glob("img_*")):
        try:
            idx = int(p.stem.split("_", 1)[1])
        except (IndexError, ValueError):
            continue
        out[idx] = f"/media/{book_id}/illustrations/{p.name}"
    return out
