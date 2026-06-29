"""Backup / revert generated art assets (before/after compare)."""
from __future__ import annotations

import shutil
from pathlib import Path


def asset_filename(kind: str, key: str) -> str | None:
    if kind == "cover":
        return "cover.png"
    if kind == "characters":
        return f"char_{key}.png"
    if kind == "backgrounds":
        return f"bg_{key}.png"
    if kind == "inserts":
        return f"insert_{key}.png"
    return None


def asset_path(media_dir: Path, book_id: str, style: str, kind: str, key: str) -> Path | None:
    fn = asset_filename(kind, key)
    if not fn:
        return None
    return media_dir / book_id / style / fn


def prev_path(path: Path) -> Path:
    return path.parent / f"{path.stem}.prev{path.suffix}"


def prev_filename(kind: str, key: str) -> str | None:
    fn = asset_filename(kind, key)
    if not fn:
        return None
    stem, dot, ext = fn.partition(".")
    return f"{stem}.prev.{ext}" if dot else f"{fn}.prev"


def public_url(book_id: str, style: str, filename: str) -> str:
    return f"/media/{book_id}/{style}/{filename}"


def cache_bust_url(url: str, ts_ms: int | None = None) -> str:
    """Append ?v= for browser cache busting after overwrite."""
    if not url:
        return url
    base = url.split("?", 1)[0]
    ts = ts_ms if ts_ms is not None else int(__import__("time").time() * 1000)
    return f"{base}?v={ts}"


def prev_public_url(book_id: str, style: str, kind: str, key: str) -> str | None:
    pfn = prev_filename(kind, key)
    return public_url(book_id, style, pfn) if pfn else None


def backup_media_asset(
    media_dir: Path,
    book_id: str,
    style: str,
    kind: str,
    key: str,
) -> str | None:
    """Copy current asset to `.prev.png`; return its public URL if a backup was made."""
    path = asset_path(media_dir, book_id, style, kind, key)
    if not path or not path.is_file():
        return None
    dest = prev_path(path)
    shutil.copy2(path, dest)
    return public_url(book_id, style, dest.name)


def revert_media_asset(media_dir: Path, book_id: str, style: str, kind: str, key: str) -> bool:
    """Restore `.prev` copy over the live asset."""
    path = asset_path(media_dir, book_id, style, kind, key)
    if not path:
        return False
    prev = prev_path(path)
    if not prev.is_file():
        return False
    shutil.copy2(prev, path)
    return True


def commit_media_asset(
    media_dir: Path,
    book_id: str,
    style: str,
    kind: str,
    key: str,
) -> str | None:
    """Confirm the live asset (drop .prev backup) and return a cache-busted URL."""
    path = asset_path(media_dir, book_id, style, kind, key)
    if not path or not path.is_file():
        return None
    prev = prev_path(path)
    if prev.is_file():
        prev.unlink()
    fn = asset_filename(kind, key)
    if not fn:
        return None
    return cache_bust_url(public_url(book_id, style, fn))
