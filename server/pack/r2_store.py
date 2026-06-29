"""R2 mirror for content-addressed offline pack cache."""
from __future__ import annotations

from pathlib import Path

from ..storage import r2


def sync_cache_to_r2(cache_key: str, local_path: Path) -> str | None:
    if not r2.r2_configured() or not local_path.is_file():
        return None
    key = r2.pack_object_key(cache_key)
    r2.upload_file(key, str(local_path))
    return key


def sync_job_to_r2(job_id: str, local_path: Path) -> str | None:
    if not r2.r2_configured() or not local_path.is_file():
        return None
    key = r2.job_object_key(job_id)
    r2.upload_file(key, str(local_path))
    return key


def fetch_cache_from_r2(cache_key: str) -> bytes | None:
    if not r2.r2_configured():
        return None
    return r2.get_bytes(r2.pack_object_key(cache_key))


def fetch_job_from_r2(job_id: str) -> bytes | None:
    if not r2.r2_configured():
        return None
    return r2.get_bytes(r2.job_object_key(job_id))
