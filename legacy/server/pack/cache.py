"""Content-addressed cache for vae-offline-pack builds."""
from __future__ import annotations

import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .build import collect_media_urls


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def playback_fingerprint(playback: dict) -> list[str]:
    rows: list[str] = []
    for scene in playback.get("scenes") or []:
        for line in scene.get("lines") or []:
            rows.append(f"{line.get('idx')}:{line.get('text', '')}")
    return rows


def compute_cache_key(
    book_id: str,
    tier: str,
    style: str,
    playback: dict,
    voices: dict | None,
    *,
    audio_source: str = "edge-tts",
) -> str:
    """Stable key — invalidates when script, voices, style, media refs, or audio source change."""
    payload = {
        "book_id": book_id,
        "tier": tier,
        "style": style,
        "audio_source": audio_source,
        "voices": voices or {},
        "lines": playback_fingerprint(playback),
        "media_urls": sorted(collect_media_urls(playback)),
    }
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:24]


def cache_dir(packs_dir: Path) -> Path:
    d = packs_dir / "cache"
    d.mkdir(parents=True, exist_ok=True)
    return d


def cache_pack_path(packs_dir: Path, cache_key: str) -> Path:
    return cache_dir(packs_dir) / f"{cache_key}.vaepack"


def cache_meta_path(packs_dir: Path, cache_key: str) -> Path:
    return cache_dir(packs_dir) / f"{cache_key}.json"


def read_cache_meta(packs_dir: Path, cache_key: str) -> dict[str, Any] | None:
    p = cache_meta_path(packs_dir, cache_key)
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def get_cached_pack(packs_dir: Path, cache_key: str) -> Path | None:
    pack = cache_pack_path(packs_dir, cache_key)
    return pack if pack.is_file() else None


def store_cached_pack(
    packs_dir: Path,
    cache_key: str,
    source: Path,
    *,
    book_id: str,
    tier: str,
    style: str,
    audio_source: str,
) -> Path:
    dest = cache_pack_path(packs_dir, cache_key)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, dest)
    cache_meta_path(packs_dir, cache_key).write_text(
        json.dumps({
            "cache_key": cache_key,
            "book_id": book_id,
            "tier": tier,
            "style": style,
            "audio_source": audio_source,
            "stored_at": _utc_now(),
            "bytes": dest.stat().st_size,
        }, indent=2),
        encoding="utf-8",
    )
    try:
        from .r2_store import sync_cache_to_r2
        sync_cache_to_r2(cache_key, dest)
    except Exception:
        pass
    return dest


def get_cached_pack_bytes(packs_dir: Path, cache_key: str) -> bytes | None:
    """Local disk first, then optional R2 mirror."""
    local = get_cached_pack(packs_dir, cache_key)
    if local:
        return local.read_bytes()
    try:
        from .r2_store import fetch_cache_from_r2
        return fetch_cache_from_r2(cache_key)
    except Exception:
        return None
