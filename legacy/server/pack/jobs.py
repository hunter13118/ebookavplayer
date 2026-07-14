"""Background jobs for vae-offline-pack builds (audiobook tier)."""
from __future__ import annotations

import asyncio
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import format as F
from .cache import compute_cache_key, get_cached_pack, store_cached_pack

PACK_JOBS: dict[str, "PackJob"] = {}


@dataclass
class PackJob:
    book_id: str
    tier: str
    style: str
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    status: str = "queued"       # queued | building | done | error | cancelled
    progress: float = 0.0
    detail: str = ""
    log: list[str] = field(default_factory=list)
    path: Path | None = None
    error: str = ""
    cached: bool = False
    cache_key: str = ""
    audio_source: str = "edge-tts"
    r2_key: str = ""
    _cancel: threading.Event = field(default_factory=threading.Event, repr=False)

    def as_dict(self) -> dict:
        return {
            "job_id": self.id,
            "book_id": self.book_id,
            "tier": self.tier,
            "style": self.style,
            "status": self.status,
            "progress": round(self.progress, 4),
            "detail": self.detail,
            "log": self.log[-12:],
            "error": self.error,
            "ready": self.status == "done" and (self.path is not None or bool(self.r2_key)),
            "cached": self.cached,
            "cache_key": self.cache_key,
            "audio_source": self.audio_source,
            "r2_key": self.r2_key,
        }


def get_job(job_id: str) -> PackJob | None:
    return PACK_JOBS.get(job_id)


def cancel_job(job_id: str) -> bool:
    job = get_job(job_id)
    if not job or job.status not in ("queued", "building"):
        return False
    job._cancel.set()
    job.status = "cancelled"
    job.detail = "cancelled"
    job.log.append("cancelled by client")
    return True


def start_pack_build(
    *,
    book_id: str,
    tier: str,
    style: str,
    playback: dict,
    voices: dict,
    resume: dict | None,
    packs_dir: Path,
    synth_line,
    external_audio: Any | None = None,
    force: bool = False,
    job_id: str | None = None,
) -> PackJob:
    if tier not in F.VALID_TIERS:
        raise ValueError(f"invalid tier: {tier}")
    packs_dir.mkdir(parents=True, exist_ok=True)

    audio_source = F.AUDIO_ENGINE_EXTERNAL if (
        external_audio is not None and external_audio.has_audio()
    ) else F.AUDIO_ENGINE_EDGE

    cache_key = compute_cache_key(
        book_id, tier, style, playback, voices, audio_source=audio_source,
    )
    job = PackJob(
        book_id=book_id, tier=tier, style=style,
        cache_key=cache_key, audio_source=audio_source,
    )
    if job_id:
        job.id = job_id
    PACK_JOBS[job.id] = job

    if not force:
        cached = get_cached_pack(packs_dir, cache_key)
        if cached:
            job.path = cached
            job.status = "done"
            job.progress = 1.0
            job.detail = "cache hit"
            job.cached = True
            job.log.append("served from cache")
            try:
                from .r2_store import sync_cache_to_r2
                job.r2_key = sync_cache_to_r2(cache_key, cached) or ""
            except Exception:
                pass
            return job
        try:
            from .cache import get_cached_pack_bytes
            remote = get_cached_pack_bytes(packs_dir, cache_key)
            if remote:
                fname = f"{book_id}.{style}.{tier}.{job.id}.vaepack"
                out = packs_dir / fname
                out.write_bytes(remote)
                job.path = out
                job.status = "done"
                job.progress = 1.0
                job.detail = "cache hit (r2)"
                job.cached = True
                job.r2_key = f"packs/cache/{cache_key}.vaepack"
                job.log.append("served from r2 cache")
                return job
        except Exception:
            pass

    threading.Thread(
        target=_run_pack_build,
        args=(job, playback, voices, resume, packs_dir, synth_line, external_audio, force),
        daemon=True,
    ).start()
    return job


def _run_pack_build(
    job: PackJob,
    playback: dict,
    voices: dict,
    resume,
    packs_dir: Path,
    synth_line,
    external_audio,
    force: bool,
):
    from .build import build_pack_bytes

    def on_progress(ratio: float, msg: str):
        if job._cancel.is_set():
            return
        job.progress = max(0.0, min(1.0, ratio))
        job.detail = msg
        if msg and (not job.log or job.log[-1] != msg):
            job.log.append(msg)

    async def build():
        return await build_pack_bytes(
            playback,
            tier=job.tier,
            style=job.style,
            voices=voices,
            resume=resume,
            synthesize_line=synth_line if job.tier == F.TIER_AUDIOBOOK else None,
            external_audio=external_audio,
            on_progress=on_progress,
            should_cancel=job._cancel.is_set,
        )

    try:
        if job._cancel.is_set():
            job.status = "cancelled"
            return
        job.status = "building"
        job.log.append(f"building {job.tier} pack ({job.audio_source})")
        payload = asyncio.run(build())
        if job._cancel.is_set():
            job.status = "cancelled"
            job.detail = "cancelled"
            return
        fname = f"{job.book_id}.{job.style}.{job.tier}.{job.id}.vaepack"
        out = packs_dir / fname
        out.write_bytes(payload)
        job.path = out
        job.status = "done"
        job.progress = 1.0
        job.detail = "ready"
        job.log.append("pack ready")
        store_cached_pack(
            packs_dir, job.cache_key, out,
            book_id=job.book_id, tier=job.tier, style=job.style,
            audio_source=job.audio_source,
        )
        try:
            from .r2_store import sync_job_to_r2, sync_cache_to_r2
            job.r2_key = sync_job_to_r2(job.id, out) or ""
            if job.cache_key:
                sync_cache_to_r2(job.cache_key, out)
        except Exception:
            pass
    except InterruptedError:
        job.status = "cancelled"
        job.detail = "cancelled"
        job.log.append("build interrupted")
    except Exception as e:  # pragma: no cover
        if job._cancel.is_set():
            job.status = "cancelled"
            job.detail = "cancelled"
        else:
            job.status = "error"
            job.error = str(e)
            job.detail = str(e)
            job.log.append(f"error: {e}")
