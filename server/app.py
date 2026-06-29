"""FastAPI app for the Visual Audiobook Engine.

Thin shell. /tts + /voices/edge are copied to a tee from the Gyōkan parallel-
reader (browsers can't set Edge WS headers, so synthesis is server-side). The
rest serves the library catalog + compiled playback JSON and runs ingest.

Run:  uvicorn server.app:app --host 0.0.0.0 --port 8600 --reload --reload-dir server

With --reload, limit watch to `server/` only — imaging writes under data/ must
not trigger reload mid-request (that races POST /generate-media and causes
client AbortSignal timeouts).
Cloudflare note (Brief): the Gemini mega-pass can exceed a ~10s Worker CPU
budget — /ingest runs it in a background job and the client polls, so the
request itself returns immediately. Portable to local Node/uvicorn as-is.
"""
from __future__ import annotations

import os
import threading
import uuid
from pathlib import Path

# Load .env from project root when present (LOCAL_IMAGE_URL, GEMINI_API_KEY, …).
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
except ImportError:
    pass

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

DATA_DIR = Path(os.environ.get("DATA_DIR", "./data"))
BOOKS_DIR = DATA_DIR / "books"
MEDIA_DIR = DATA_DIR / "media"
PACKS_DIR = DATA_DIR / "packs"
AUDIO_DIR = DATA_DIR / "audio"


class TtsRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=8000)
    voice: str = "en-US-AndrewMultilingualNeural"
    pitch: str | None = None
    rate: str | None = None
    volume: str | None = None
    character: str | None = None
    expression: str | None = None
    environment: str | None = None
    intensity: float | None = None


class ResumeRequest(BaseModel):
    line: int = 0
    sceneId: str = ""
    chapter: int = 0


class VoiceOverride(BaseModel):
    source: str = "default"   # default | edge | uploaded
    voice: str = ""
    pitch: str | None = None
    rate: str | None = None
    volume: str | None = None


class VoiceOverridesRequest(BaseModel):
    narrator: VoiceOverride | None = None
    characters: dict[str, VoiceOverride] = Field(default_factory=dict)


class ReplaceMediaRequest(BaseModel):
    scope: str = "all"           # all | cover | characters | backgrounds | inserts | selected
    mode: str = "generate"       # generate only (upload uses separate endpoint)
    character_ids: list[str] | None = None
    scene_ids: list[str] | None = None
    insert_line_indices: list[int] | None = None
    include_cover: bool = False
    force_all: bool = True
    art_style: str | None = None
    ignore_pins: bool = False    # skip provider pin on regen (try full fallback chain)
    compare: bool = False          # backup prev assets for before/after UI
    diversify: bool = False        # fresh seed + prompt — visibly different from prior art


class GenerateMomentRequest(BaseModel):
    line_idx: int
    tweak_script: bool = True      # optional LLM polish of moment_prompt / line text
    diversify: bool = False


class RevertMediaRequest(BaseModel):
    kind: str
    key: str
    style: str | None = None


class CommitMediaRequest(BaseModel):
    kind: str
    key: str
    style: str | None = None


class PipelinePatchRequest(BaseModel):
    lanes: dict[str, dict[str, list[str]]] = Field(default_factory=dict)


class PackBuildRequest(BaseModel):
    tier: str = "audiobook"
    style: str | None = None
    force: bool = False


class PackQueueBuildRequest(BaseModel):
    job_id: str
    book_id: str
    tier: str = "audiobook"
    style: str | None = None
    force: bool = False


class ActiveStyleRequest(BaseModel):
    style: str
    mode: str | None = None      # "filter" → instant pixel filter over source style


# ---- in-memory ingest jobs (swap for a queue when porting to Workers) ----
class Job:
    def __init__(self, book_id: str):
        self.id = uuid.uuid4().hex[:12]
        self.book_id = book_id
        self.status = "queued"
        self.detail = ""
        self.log: list[str] = []
        self.comparisons: list[dict] = []


JOBS: dict[str, Job] = {}


def _existing_media_for_regen(
    scope: str,
    force_all: bool,
    flat_existing: dict,
    *,
    character_ids: list[str] | None,
    scene_ids: list[str] | None,
    insert_line_indices: list[int] | None,
    include_cover: bool,
) -> dict:
    """Assets with URLs in this dict are skipped during generation."""
    empty = {"characters": {}, "backgrounds": {}, "inserts": {}, "cover": None}
    if scope == "all" and force_all:
        return empty
    if scope == "inserts":
        regen_ins = {str(i) for i in (insert_line_indices or [])}
        if regen_ins:
            inserts = {
                k: v for k, v in (flat_existing.get("inserts") or {}).items()
                if k not in regen_ins
            }
            return {**flat_existing, "inserts": inserts}
        return empty
    if scope != "selected":
        return flat_existing
    regen_chars = set(character_ids or [])
    regen_bgs = set(scene_ids or [])
    regen_ins = {str(i) for i in (insert_line_indices or [])}
    chars = {
        k: v for k, v in (flat_existing.get("characters") or {}).items()
        if k not in regen_chars
    }
    bgs = {
        k: v for k, v in (flat_existing.get("backgrounds") or {}).items()
        if k not in regen_bgs
    }
    inserts = {
        k: v for k, v in (flat_existing.get("inserts") or {}).items()
        if k not in regen_ins
    }
    cover = None if include_cover else flat_existing.get("cover")
    return {"characters": chars, "backgrounds": bgs, "inserts": inserts, "cover": cover}


def _load_style_reference_bytes(book_id: str, source_style: str, limit: int = 6) -> list[bytes]:
    """Load existing style PNGs as reference for style-conversion generation."""
    style_dir = MEDIA_DIR / book_id / source_style
    if not style_dir.is_dir():
        return []
    blobs: list[bytes] = []
    for pattern in ("char_*.png", "char_*.jpg", "bg_*.png", "cover.png"):
        for path in sorted(style_dir.glob(pattern)):
            try:
                blobs.append(path.read_bytes())
            except OSError:
                continue
            if len(blobs) >= limit:
                return blobs
    return blobs


def _run_ingest(job: Job, epub_path: str, art_style: str, narrator_gender: str,
                dry_run: bool = False, generate_art: bool = True,
                illustration_mode: str | None = None):
    """Progressive ingest. Writes the analysis (lines become playable) BEFORE
    images, then streams images in via library.set_media, bumping progress so a
    book opened mid-processing fills with art live."""
    from .epub.parse import parse_epub
    from .epub.illustrations import persist_extracted_images
    from .analyze.extract import extract_book, ExtractUnavailable
    from .images.generate import generate_media, media_work_items
    from .playback import library as L
    from .playback.illustrations import (
        apply_direct_illustrations,
        normalize_illustration_mode,
    )

    bid = job.book_id

    def status(**kw):
        kw.setdefault("art_style", art_style)
        kw.setdefault("narrator_gender", narrator_gender)
        L.write_status(bid, **kw)

    try:
        job.status = "parsing"; job.log.append("parsing EPUB")
        status(status="processing", stage="parsing", progress=0.03, title=bid)
        book = parse_epub(epub_path, bid)
        image_urls = persist_extracted_images(bid, book.images, MEDIA_DIR)
        illus_mode = normalize_illustration_mode(
            illustration_mode, art_style, len(book.images),
        )
        status(status="processing", stage="parsing", progress=L.PARSE_END,
               title=book.title, author=book.author,
               illustration_mode=illus_mode,
               illustration_count=len(book.images),
               illustration_markers={
                   str(k): [[i, t] for i, t in v]
                   for k, v in book.illustration_markers.items()
               })

        job.status = "analyzing"; job.log.append("text extraction mega-pass")
        from .images.notify import push_analysis_event
        L.write_status(bid, banners=[])
        analysis = extract_book(
            book.book_id, book.title, book.author,
            book.body_text, reference_images=book.images,
            on_event=lambda ev, **kw: push_analysis_event(bid, ev, **kw),
        )
        from .epub.placements import (
            apply_illustration_placements,
            apply_single_illustration_fallback,
        )
        if book.illustration_markers:
            analysis = apply_illustration_placements(analysis, book.illustration_markers)
        elif book.images:
            analysis = apply_single_illustration_fallback(analysis, len(book.images))
        # persist analysis -> book is now PLAYABLE (gradient placeholders)
        L._write_json(L._path(bid, ".analysis.json"), analysis.model_dump())
        from .playback import styles as St
        L.write_media(bid, St.mark_style_generating(
            St.ensure_manifest({}, default_active=art_style), art_style,
        ))
        status(status="ready", stage="analyzing", progress=L.ANALYSIS_END,
               title=book.title, author=book.author, art_style=art_style)

        if dry_run or not generate_art:
            # Script-only / manual art: playable with gradients; user uploads later.
            status(status="ready", stage="done", progress=1.0)
            note = "done (dry run — no images)" if dry_run else "done (manual art — upload or replace later)"
            job.status = "done"; job.log.append(note)
            return

        job.status = "imaging"; job.log.append("image generation")
        from .images.notify import ImagingBannerSink
        from .playback import styles as St
        L.write_status(bid, banners=[])
        banner_sink = ImagingBannerSink(bid)
        pre_done = 0
        if illus_mode == "direct-use" and image_urls:
            counts = apply_direct_illustrations(
                bid, analysis, image_urls, style=art_style, set_media=L.set_media,
            )
            pre_done = counts["cover"] + counts["characters"] + counts["backgrounds"]
            job.log.append(
                f"direct-use illustrations: {counts['characters']} chars, "
                f"{counts['backgrounds']} backgrounds",
            )
        elif illus_mode == "moment" and image_urls:
            job.log.append(
                f"moment mode: {len(image_urls)} EPUB inserts for line flashes + sprite refs",
            )
        flat_existing = St.flat_media_from_slot(
            L.read_media(bid).get("styles", {}).get(art_style, {}),
        )
        total = media_work_items(analysis)
        done = {"n": pre_done}

        def on_item(kind, key, url):
            L.set_media(bid, kind, key, url, style=art_style)
            done["n"] += 1
            status(status="ready", stage="imaging",
                   progress=L.imaging_progress(done["n"], total))

        out_dir = str(MEDIA_DIR / bid)
        pins = L.read_image_pins(bid, style=art_style)
        result = generate_media(analysis, out_dir, book.images, art_style, on_item=on_item,
                                on_event=banner_sink, image_pins=pins,
                                existing_media=flat_existing)
        L.merge_image_pins(bid, result.get("image_pins") or {}, style=art_style)
        L.finish_style_generation(bid, art_style)

        from .playback import styles as St
        flat, _, _ = St.resolve_compile_media(L.read_media(bid), fallback_active=art_style)
        generated = sum([
            1 if flat.get("cover") else 0,
            len(flat.get("characters") or {}),
            len(flat.get("backgrounds") or {}),
        ])
        if generated == 0:
            job.log.append("warning: no images generated (Gemini quota/key?)")
            banner_sink("imaging_zero")
        elif banner_sink.failed_images > 0:
            banner_sink("imaging_complete_fail", failed=banner_sink.failed_images)
        status(status="ready", stage="done", progress=1.0)
        job.status = "done"; job.log.append("done")
    except ExtractUnavailable as e:
        from .images.notify import push_analysis_event
        if e.code in ("quota_exhausted", "rate_limited", "all_models_failed", "all_providers_failed"):
            push_analysis_event(
                bid, "gemini_text_exhausted",
                quota=e.code == "quota_exhausted",
                rate_limit=e.code == "rate_limited",
            )
            push_analysis_event(bid, "freemium_extract_exhausted")
        job.status = "error"
        job.detail = str(e)
        L.write_status(bid, status="error", stage="analyzing", error=str(e))
    except Exception as e:  # pragma: no cover
        job.status = "error"; job.detail = str(e)
        L.write_status(bid, status="error", error=str(e))


def _find_epub_path(book_id: str) -> Path | None:
    uploads = DATA_DIR / "uploads"
    direct = uploads / f"{book_id}.epub"
    if direct.is_file():
        return direct
    if uploads.is_dir():
        for p in uploads.glob("*.epub"):
            if p.stem == book_id:
                return p
    return None


def _run_re_extract(job: Job, book_id: str, *, force_provider: bool = False):
    """Re-run text extraction from stored EPUB; keeps existing art/media."""
    from .epub.parse import parse_epub
    from .analyze.extract import extract_book, ExtractUnavailable
    from .epub.placements import (
        apply_illustration_placements,
        apply_single_illustration_fallback,
    )
    from .images.notify import push_analysis_event
    from .playback import library as L

    try:
        epub_path = _find_epub_path(book_id)
        if not epub_path:
            job.status = "error"
            job.detail = "EPUB not found in uploads — re-upload the book to re-extract"
            L.write_status(book_id, status="error", stage="analyzing", error=job.detail)
            return

        status = L.read_status(book_id) or {}
        job.status = "analyzing"
        job.log.append("re-extracting script from EPUB")
        L.write_status(
            book_id, status="processing", stage="analyzing",
            progress=0.15, banners=[],
        )

        book = parse_epub(str(epub_path), book_id)
        pin = None if force_provider else (L.read_extract_pin(book_id) or {}).get("provider")

        analysis = extract_book(
            book.book_id, book.title, book.author,
            book.body_text, reference_images=book.images,
            prefer_provider=pin,
            on_event=lambda ev, **kw: push_analysis_event(book_id, ev, **kw),
        )
        if book.illustration_markers:
            analysis = apply_illustration_placements(analysis, book.illustration_markers)
        elif book.images:
            analysis = apply_single_illustration_fallback(analysis, len(book.images))

        L._write_json(L._path(book_id, ".analysis.json"), analysis.model_dump())
        L.write_status(
            book_id,
            status="ready",
            stage="done",
            progress=1.0,
            title=book.title,
            author=book.author,
            illustration_count=len(book.images),
            illustration_markers={
                str(k): [[i, t] for i, t in v]
                for k, v in book.illustration_markers.items()
            },
            banners=[],
        )
        job.status = "done"
        job.log.append("re-extract done")
    except ExtractUnavailable as e:
        job.status = "error"
        job.detail = str(e)
        L.write_status(book_id, status="error", stage="analyzing", error=str(e))
    except Exception as e:  # pragma: no cover
        job.status = "error"
        job.detail = str(e)
        L.write_status(book_id, status="error", error=str(e))


def _run_generate_media(job: Job, book_id: str, opts: dict | None = None):
    """Generate or replace art (Gemini cascade → local War Council SD)."""
    from .images.generate import generate_media, media_work_items, regen_targets
    from .playback import library as L

    opts = opts or {}
    scope = opts.get("scope", "all")
    force_all = opts.get("force_all", True)
    character_ids = opts.get("character_ids")
    scene_ids = opts.get("scene_ids")
    insert_line_indices = opts.get("insert_line_indices")
    include_cover = opts.get("include_cover", False)
    ignore_pins = bool(opts.get("ignore_pins"))
    compare = bool(opts.get("compare"))
    diversify = bool(opts.get("diversify"))

    try:
        # Yield so POST /generate-media can flush before we write data/ (reload race).
        import time
        time.sleep(0.15)

        analysis = L.load_analysis(book_id)
        if analysis is None:
            job.status = "error"
            job.detail = "no book data to generate from"
            return
        # Persist analysis so future compiles pick up new media.
        analysis_p = L._path(book_id, ".analysis.json")
        if not analysis_p.exists():
            L._write_json(analysis_p, analysis.model_dump())
        status = L.read_status(book_id) or {}
        art_style = opts.get("art_style") or status.get("art_style", "semi-real")
        from .playback import styles as St
        media_manifest = L.read_media(book_id)
        gen_style = St.generation_target_style(media_manifest, art_style)
        job.status = "imaging"
        job.log.append(f"replacing art ({scope}, style={gen_style})")
        from .images.notify import ImagingBannerSink
        L.begin_style_generation(book_id, gen_style)
        L.write_status(book_id, status="ready", stage="imaging",
                       progress=L.ANALYSIS_END, banners=[])
        banner_sink = ImagingBannerSink(book_id)
        from .epub.illustrations import load_image_index
        pre_done = 0
        st = L.read_status(book_id) or {}
        if st.get("illustration_mode") == "direct-use":
            urls = load_image_index(MEDIA_DIR, book_id)
            if urls:
                from .playback.illustrations import apply_direct_illustrations
                counts = apply_direct_illustrations(
                    book_id, analysis, urls, style=gen_style, set_media=L.set_media,
                )
                pre_done = counts["cover"] + counts["characters"] + counts["backgrounds"]
        flat_existing = St.flat_media_from_slot(
            L.read_media(book_id).get("styles", {}).get(gen_style, {}),
        )
        existing_for_gen = _existing_media_for_regen(
            scope, force_all, flat_existing,
            character_ids=character_ids,
            scene_ids=scene_ids,
            insert_line_indices=insert_line_indices,
            include_cover=include_cover,
        )
        total = media_work_items(analysis, force_all=force_all, scope=scope,
                                 character_ids=character_ids, scene_ids=scene_ids,
                                 insert_line_indices=insert_line_indices,
                                 include_cover=include_cover)
        done = {"n": pre_done}

        from .images.versions import backup_media_asset, public_url as media_public_url, prev_public_url, cache_bust_url
        import time

        if compare:
            for kind, key in regen_targets(
                analysis, force_all=force_all, scope=scope,
                character_ids=character_ids, scene_ids=scene_ids,
                insert_line_indices=insert_line_indices,
                include_cover=include_cover,
            ):
                backup_media_asset(MEDIA_DIR, book_id, gen_style, kind, key)

        def on_item(kind, key, url):
            fn = url.rsplit("/", 1)[-1].split("?")[0]
            ts = int(time.time() * 1000)
            live_url = cache_bust_url(media_public_url(book_id, gen_style, fn), ts)
            L.set_media(book_id, kind, key, live_url, style=gen_style)
            done["n"] += 1
            L.write_status(book_id, status="ready", stage="imaging",
                           progress=L.imaging_progress(done["n"], total))
            if compare:
                before_url = prev_public_url(book_id, gen_style, kind, key)
                job.comparisons.append({
                    "kind": kind,
                    "key": key,
                    "before_url": before_url,
                    "after_url": live_url,
                })

        out_dir = str(MEDIA_DIR / book_id)
        pins = L.read_image_pins(book_id, style=gen_style)
        ref_images = opts.get("reference_images")
        if ref_images is None:
            ref_source = St.first_ready_style(media_manifest, exclude=(gen_style,))
            if ref_source:
                ref_images = _load_style_reference_bytes(book_id, ref_source)
        result = generate_media(analysis, out_dir, ref_images, gen_style, on_item=on_item,
                                force_all=force_all, scope=scope,
                                character_ids=character_ids, scene_ids=scene_ids,
                                insert_line_indices=insert_line_indices,
                                include_cover=include_cover,
                                on_event=banner_sink, image_pins=pins,
                                existing_media=existing_for_gen,
                                ignore_pins=ignore_pins,
                                diversify=diversify)
        L.merge_image_pins(book_id, result.get("image_pins") or {}, style=gen_style)
        L.finish_style_generation(book_id, gen_style)
        if scope == "selected":
            regen_chars = set(character_ids or [])
            regen_bgs = set(scene_ids or [])
            regen_ins = {str(i) for i in (insert_line_indices or [])}
            for key, url in (flat_existing.get("characters") or {}).items():
                if key in regen_chars:
                    continue
                if url:
                    L.set_media(book_id, "characters", key, url, style=gen_style)
            for key, url in (flat_existing.get("backgrounds") or {}).items():
                if key in regen_bgs:
                    continue
                if url:
                    L.set_media(book_id, "backgrounds", key, url, style=gen_style)
            for key, url in (flat_existing.get("inserts") or {}).items():
                if key in regen_ins:
                    continue
                if url:
                    L.set_media(book_id, "inserts", key, url, style=gen_style)
            if flat_existing.get("cover") and not include_cover:
                L.set_media(book_id, "cover", "cover", flat_existing["cover"], style=gen_style)

        flat, _, _ = St.resolve_compile_media(L.read_media(book_id), fallback_active=art_style)
        generated = sum([
            1 if flat.get("cover") else 0,
            len(flat.get("characters") or {}),
            len(flat.get("backgrounds") or {}),
        ])
        if generated == 0:
            job.log.append("warning: no images generated (Gemini quota/key?)")
            job.detail = "no images generated — check Gemini image quota in AI Studio"
            banner_sink("imaging_zero")
        elif banner_sink.failed_images > 0:
            banner_sink("imaging_complete_fail", failed=banner_sink.failed_images)
        L.write_status(book_id, status="ready", stage="done", progress=1.0)
        job.status = "done"
        job.log.append("done")
    except Exception as e:  # pragma: no cover
        job.status = "error"
        job.detail = str(e)
        try:
            L.release_imaging_lock(book_id)
        except Exception:
            L.write_status(book_id, generating_style=None, stage="done", progress=1.0)
        L.write_status(book_id, status="error", error=str(e))


def _run_generate_moment(job: Job, book_id: str, line_idx: int, *,
                         tweak_script: bool = True, diversify: bool = False):
    """Generate one full-frame moment illustration for a script line."""
    import random
    import time
    from .images.generate import (
        _gen_one, _media_public_url, _stable_seed, _style_out_dir,
    )
    from .images.moment_inserts import (
        line_at_index, moment_description, patch_analysis_line,
        reference_bytes_for_moment, tweak_moment_line,
    )
    from .playback import library as L
    from .playback import styles as St

    try:
        time.sleep(0.15)
        analysis = L.load_analysis(book_id)
        if analysis is None:
            job.status = "error"
            job.detail = "no book data to generate from"
            return
        loc = line_at_index(analysis, line_idx)
        if not loc:
            job.status = "error"
            job.detail = f"no line at index {line_idx}"
            return
        scene, _li, line = loc
        line = tweak_moment_line(analysis, scene, line, use_llm=tweak_script)
        analysis = patch_analysis_line(analysis, line_idx, line)
        L._write_json(L._path(book_id, ".analysis.json"), analysis.model_dump())

        status = L.read_status(book_id) or {}
        art_style = status.get("art_style", "semi-real")
        media_manifest = L.read_media(book_id)
        gen_style = St.generation_target_style(media_manifest, art_style)
        job.status = "imaging"
        job.log.append(f"moment insert line {line_idx} (style={gen_style})")
        L.begin_style_generation(book_id, gen_style)
        L.write_status(book_id, status="ready", stage="imaging",
                       progress=L.ANALYSIS_END, banners=[])

        from .images.notify import ImagingBannerSink
        banner_sink = ImagingBannerSink(book_id)
        out_dir = str(MEDIA_DIR / book_id)
        style_dir = _style_out_dir(out_dir, gen_style)
        desc = moment_description(analysis, scene, line, line_idx=line_idx)
        refs = reference_bytes_for_moment(
            analysis, line.character_id, Path(style_dir), None,
        )
        key = str(line_idx)
        fname = f"insert_{key}.png"
        out_path = os.path.join(style_dir, fname)
        from .images.versions import backup_media_asset, public_url as media_public_url, prev_public_url
        compare = Path(out_path).is_file()
        if compare:
            backup_media_asset(MEDIA_DIR, book_id, gen_style, "inserts", key)
        seed = random.randint(1, 2**31 - 1) if diversify else _stable_seed(f"insert:{key}")
        ipath, _ = _gen_one(
            desc, refs, out_path,
            subject_type="character", art_style=gen_style, kind="character",
            allow_gemini=True, allow_freemium=True, allow_local=True,
            seed=seed, on_event=banner_sink, diversify=diversify,
        )
        if not ipath:
            job.status = "error"
            job.detail = "moment image generation failed"
            L.release_imaging_lock(book_id)
            L.write_status(book_id, status="error", error=job.detail)
            return
        url = _media_public_url(book_id, gen_style, fname)
        from .images.versions import cache_bust_url
        live_url = cache_bust_url(url, int(time.time() * 1000))
        L.set_media(book_id, "inserts", key, live_url, style=gen_style)
        if compare and ipath:
            ts = int(time.time() * 1000)
            job.comparisons.append({
                "kind": "inserts",
                "key": key,
                "before_url": prev_public_url(book_id, gen_style, "inserts", key),
                "after_url": live_url,
            })
        L.finish_style_generation(book_id, gen_style)
        L.write_status(book_id, status="ready", stage="done", progress=1.0)
        job.status = "done"
        job.log.append("moment insert done")
    except Exception as e:  # pragma: no cover
        job.status = "error"
        job.detail = str(e)
        try:
            L.release_imaging_lock(book_id)
        except Exception:
            L.write_status(book_id, generating_style=None, stage="done", progress=1.0)
        L.write_status(book_id, status="error", error=str(e))


def create_app() -> FastAPI:
    app = FastAPI(title="Visual Audiobook Engine", version="0.1.0")
    app.add_middleware(CORSMiddleware, allow_origins=["*"],
                       allow_methods=["*"], allow_headers=["*"])
    BOOKS_DIR.mkdir(parents=True, exist_ok=True)
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)

    from .playback import library as L

    # ---------- TTS (copied to a tee from Gyōkan) ----------
    @app.post("/tts")
    async def tts(req: TtsRequest):
        """Runtime speech via Edge neural voices + expression DSP."""
        from .audio.edge_tts import synthesize_edge_mp3
        from .audio.voice_expression import build_expression_plan, infer_expression_from_text
        from .audio.expression_dsp import apply_dsp_plan

        expr = req.expression
        intensity = req.intensity
        if not expr:
            expr, inferred_i = infer_expression_from_text(req.text)
            if intensity is None:
                intensity = inferred_i
        tag = {
            "text": req.text,
            "character": req.character,
            "expression": expr or "normal",
            "environment": req.environment or "open",
            "intensity": intensity if intensity is not None else 1.0,
        }
        plan = build_expression_plan(tag, "edge")
        ssml = plan["ssml"]
        expr = tag.get("expression") or "normal"
        # Character pitch wins; expression prosody only fills gaps (keeps voices natural).
        use_expr_pitch = expr not in ("normal",) and not req.pitch
        try:
            audio = await synthesize_edge_mp3(
                req.text, req.voice,
                rate=req.rate or ssml.get("rate"),
                pitch=req.pitch if req.pitch else (ssml.get("pitch") if use_expr_pitch else "+0Hz"),
                volume=req.volume or ssml.get("volume"),
            )
            audio = apply_dsp_plan(audio, plan.get("dsp") or [])
        except Exception as e:
            raise HTTPException(502, f"edge tts failed: {e}") from e
        if not audio:
            return Response(status_code=204)
        return Response(content=audio, media_type="audio/mpeg")

    @app.get("/voices/edge")
    async def edge_voices(locale: str | None = None):
        from .audio.edge_tts import list_edge_voices
        try:
            return await list_edge_voices(locale)
        except Exception as e:
            raise HTTPException(502, f"edge voice list failed: {e}") from e

    # ---------- Library / books (client consumes) ----------
    @app.get("/books")
    def books():
        """Library catalog: per book status, processing progress, cover, title."""
        return L.list_catalog()

    @app.get("/books/{book_id}")
    def book(book_id: str):
        """Playback book compiled with whatever media exists so far, plus the
        resume position so the client can pick up where the user left off."""
        out = L.load_playback(book_id)
        if out is None:
            raise HTTPException(404, "no such book")
        out["resume"] = L.read_resume(book_id)
        out["voice_overrides"] = L.read_voice_overrides(book_id)
        return JSONResponse(out)

    @app.get("/books/{book_id}/progress")
    def get_progress(book_id: str):
        return L.read_resume(book_id) or {"line": 0, "sceneId": "", "chapter": 0}

    @app.post("/books/{book_id}/progress")
    def set_progress(book_id: str, req: ResumeRequest):
        return L.write_resume(book_id, req.line, req.sceneId, req.chapter)

    @app.post("/books/{book_id}/re-extract")
    def re_extract_route(book_id: str, force: bool = False):
        """Background job: re-run dialogue/narration extraction from stored EPUB."""
        if not L._path(book_id, ".analysis.json").exists():
            raise HTTPException(404, "no such book")
        if _find_epub_path(book_id) is None:
            raise HTTPException(404, "EPUB not found — re-upload the book first")
        job = Job(book_id)
        JOBS[job.id] = job
        threading.Thread(
            target=_run_re_extract,
            args=(job, book_id),
            kwargs={"force_provider": force},
            daemon=True,
        ).start()
        return {"job_id": job.id, "book_id": book_id, "status": job.status}

    @app.post("/books/{book_id}/imaging/unlock")
    def unlock_imaging_route(book_id: str):
        """Release a stuck imaging / generating lock after a lost or crashed job."""
        if not L._path(book_id, ".analysis.json").exists():
            raise HTTPException(404, "no such book")
        out = L.release_imaging_lock(book_id)
        return {"ok": True, "book_id": book_id, "status": out}

    @app.post("/books/{book_id}/moments/generate")
    def generate_moment_route(book_id: str, req: GenerateMomentRequest):
        """Background job: generate one on-the-fly moment illustration for a line."""
        if not L._path(book_id, ".analysis.json").exists():
            raise HTTPException(404, "no such book")
        job = Job(book_id)
        JOBS[job.id] = job
        threading.Thread(
            target=_run_generate_moment,
            args=(job, book_id, req.line_idx),
            kwargs={"tweak_script": req.tweak_script, "diversify": req.diversify},
            daemon=True,
        ).start()
        return {"job_id": job.id, "book_id": book_id, "status": job.status,
                "line_idx": req.line_idx}

    @app.post("/books/{book_id}/generate-media")
    def generate_media_route(book_id: str, req: ReplaceMediaRequest = ReplaceMediaRequest()):
        """Background job: replace cover, character art, and/or backgrounds."""
        analysis_p = L._path(book_id, ".analysis.json")
        if not analysis_p.exists() and not L._path(book_id, ".json").exists():
            raise HTTPException(404, "no such book")
        opts = req.model_dump()
        job = Job(book_id)
        JOBS[job.id] = job
        threading.Thread(target=_run_generate_media,
                         args=(job, book_id, opts), daemon=True).start()
        return {"job_id": job.id, "book_id": book_id, "status": job.status}

    @app.post("/books/{book_id}/media/revert")
    def revert_media_route(book_id: str, req: RevertMediaRequest):
        """Restore the `.prev` backup for one art asset."""
        from .images.versions import revert_media_asset, commit_media_asset, cache_bust_url, asset_filename, public_url
        from .playback import styles as St

        if not L._path(book_id, ".analysis.json").exists():
            raise HTTPException(404, "no such book")
        media = L.read_media(book_id)
        style = req.style or St.active_style(media)
        gen_style = St.generation_target_style(media, style)
        ok = revert_media_asset(MEDIA_DIR, book_id, gen_style, req.kind, req.key)
        if not ok:
            raise HTTPException(404, "no previous version to restore")
        fn = asset_filename(req.kind, req.key)
        url = cache_bust_url(public_url(book_id, gen_style, fn)) if fn else None
        if url:
            L.set_media(book_id, req.kind, req.key, url, style=gen_style)
        return {"ok": True, "url": url}

    @app.post("/books/{book_id}/media/commit")
    def commit_media_route(book_id: str, req: CommitMediaRequest):
        """Confirm the live asset after compare (drop .prev, cache-bust manifest URL)."""
        from .images.versions import commit_media_asset
        from .playback import styles as St

        if not L._path(book_id, ".analysis.json").exists():
            raise HTTPException(404, "no such book")
        media = L.read_media(book_id)
        style = req.style or St.active_style(media)
        gen_style = St.generation_target_style(media, style)
        url = commit_media_asset(MEDIA_DIR, book_id, gen_style, req.kind, req.key)
        if not url:
            raise HTTPException(404, "no asset to commit")
        L.set_media(book_id, req.kind, req.key, url, style=gen_style)
        return {"ok": True, "url": url}

    @app.get("/pipeline")
    def get_pipeline():
        from .pipeline.registry import public_view
        return public_view()

    @app.patch("/pipeline")
    def patch_pipeline(req: PipelinePatchRequest):
        from .pipeline.registry import save_config, public_view
        save_config(req.lanes)
        return public_view()

    @app.patch("/books/{book_id}/active-style")
    def patch_active_style_route(book_id: str, req: ActiveStyleRequest):
        """Instant swap among ready styles or enable pixel filter mode."""
        from .playback import styles as St
        if not L._path(book_id, ".analysis.json").exists() and not L._path(book_id, ".json").exists():
            raise HTTPException(404, "no such book")
        style = St.normalize_style_id(req.style)
        try:
            if style == "pixel" and req.mode == "filter":
                L.activate_pixel_filter(book_id)
            else:
                L.patch_active_style(book_id, style)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        media = L.read_media(book_id)
        status = L.read_status(book_id) or {}
        return {
            "active_style": St.active_style(media),
            "styles": St.list_style_entries(media, generating=status.get("generating_style")),
        }

    @app.post("/books/{book_id}/styles/{style}")
    def generate_style_route(book_id: str, style: str):
        """Background job: generate a new art style for an existing book."""
        from .playback import styles as St
        if not L._path(book_id, ".analysis.json").exists():
            raise HTTPException(404, "no such book")
        style = St.normalize_style_id(style)
        media = L.read_media(book_id)
        st = St.style_status(media, style, generating=None)
        if st == "ready":
            return {"status": "already_ready", "style": style}
        if style == "pixel":
            pass  # allow full Stardew-style pixel generation (not filter-only)
        from .images.generate import media_work_items
        analysis = L.load_analysis(book_id)
        if analysis is None:
            raise HTTPException(404, "no analysis")
        n = media_work_items(analysis, force_all=True, scope="all")
        job = Job(book_id)
        JOBS[job.id] = job
        opts = {"scope": "all", "force_all": True, "art_style": style}
        threading.Thread(target=_run_generate_media, args=(job, book_id, opts), daemon=True).start()
        return {
            "job_id": job.id,
            "book_id": book_id,
            "style": style,
            "status": job.status,
            "estimated_images": n,
        }

    @app.delete("/books/{book_id}/styles/{style}")
    def delete_style_route(book_id: str, style: str):
        from .playback import styles as St
        if not L._path(book_id, ".analysis.json").exists():
            raise HTTPException(404, "no such book")
        style = St.normalize_style_id(style)
        try:
            L.discard_style(book_id, style)
        except ValueError as e:
            raise HTTPException(409, str(e)) from e
        media = L.read_media(book_id)
        status = L.read_status(book_id) or {}
        return {
            "deleted": style,
            "active_style": St.active_style(media),
            "styles": St.list_style_entries(media, generating=status.get("generating_style")),
        }

    @app.post("/books/{book_id}/media/upload")
    async def upload_media(book_id: str, kind: str = Form(...), key: str = Form(...),
                           file: UploadFile = File(...)):
        """Store a user-uploaded cover, character sprite, or background."""
        if not L._path(book_id, ".analysis.json").exists() and not L._path(book_id, ".json").exists():
            raise HTTPException(404, "no such book")
        if kind not in ("cover", "characters", "backgrounds", "inserts"):
            raise HTTPException(400, "kind must be cover, characters, backgrounds, or inserts")
        ext = Path(file.filename or "img.png").suffix.lower() or ".png"
        if ext not in (".png", ".jpg", ".jpeg", ".webp"):
            ext = ".png"
        from .playback import styles as St
        media = L.read_media(book_id)
        active = St.active_style(media)
        book_media_dir = MEDIA_DIR / book_id / active
        book_media_dir.mkdir(parents=True, exist_ok=True)
        if kind == "cover":
            fname = f"cover{ext}"
            media_key = "cover"
        elif kind == "characters":
            fname = f"char_{key}{ext}"
            media_key = key
        elif kind == "inserts":
            fname = f"insert_{key}{ext}"
            media_key = key
        else:
            fname = f"bg_{key}{ext}"
            media_key = key
        dest = book_media_dir / fname
        dest.write_bytes(await file.read())
        url = f"/media/{book_id}/{active}/{fname}"
        L.set_media(book_id, kind, media_key, url, style=active)
        return {"kind": kind, "key": key, "url": url}

    @app.get("/books/{book_id}/voices")
    def get_voices(book_id: str):
        if not L._path(book_id, ".analysis.json").exists() and not L._path(book_id, ".json").exists():
            raise HTTPException(404, "no such book")
        return L.read_voice_overrides(book_id)

    @app.post("/books/{book_id}/voices")
    def set_voices(book_id: str, req: VoiceOverridesRequest):
        if not L._path(book_id, ".analysis.json").exists() and not L._path(book_id, ".json").exists():
            raise HTTPException(404, "no such book")
        existing = L.read_voice_overrides(book_id)
        if req.narrator is not None:
            existing["narrator"] = req.narrator.model_dump()
        if req.characters:
            existing.setdefault("characters", {}).update(
                {k: v.model_dump() for k, v in req.characters.items()})
        return L.write_voice_overrides(book_id, existing)

    # ---------- Offline packs (vae-offline-pack v1) ----------
    def _pack_build_context(book_id: str, tier: str, style: str | None):
        from .pack import format as PF
        from .playback import styles as St

        if tier not in PF.VALID_TIERS:
            raise HTTPException(400, f"invalid tier; use {sorted(PF.VALID_TIERS)}")
        out = L.load_playback(book_id)
        if out is None:
            raise HTTPException(404, "no such book")
        if float(out.get("progress", 1.0)) < 1.0:
            raise HTTPException(409, "book still processing — wait until imaging completes")
        media = L.read_media(book_id)
        status = L.read_status(book_id) or {}
        fallback = status.get("art_style", "semi-real")
        pack_style = style or St.active_style(media, fallback=fallback)
        voices = L.read_voice_overrides(book_id)
        resume = L.read_resume(book_id)
        return out, pack_style, voices, resume

    @app.get("/books/{book_id}/pack")
    async def download_offline_pack(book_id: str, tier: str = "visual", style: str | None = None):
        """Download a vae-offline-pack ZIP synchronously (best for visual tier)."""
        from .pack import format as PF
        from .pack.build import build_pack_bytes
        from .pack.external_audio import ExternalAudioPack
        from .pack.synth import synthesize_line_mp3

        out, pack_style, voices, resume = _pack_build_context(book_id, tier, style)
        external = ExternalAudioPack.load(book_id, AUDIO_DIR) if tier == PF.TIER_AUDIOBOOK else None

        async def synth(line, voice_overrides):
            return await synthesize_line_mp3(line, voice_overrides)

        try:
            payload = await build_pack_bytes(
                out,
                tier=tier,
                style=pack_style,
                voices=voices,
                resume=resume,
                synthesize_line=synth if tier == PF.TIER_AUDIOBOOK else None,
                external_audio=external,
            )
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        fname = f"{book_id}.{pack_style}.{tier}.vaepack"
        return StreamingResponse(
            iter([payload]),
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{fname}"'},
        )

    @app.post("/books/{book_id}/pack/build")
    async def start_offline_pack_build(book_id: str, req: PackBuildRequest = PackBuildRequest()):
        """Start a background pack build. Recommended for audiobook tier (TTS for every line)."""
        from .pack import format as PF
        from .pack.external_audio import ExternalAudioPack
        from .pack.jobs import start_pack_build
        from .pack.synth import synthesize_line_mp3

        out, pack_style, voices, resume = _pack_build_context(book_id, req.tier, req.style)
        external = ExternalAudioPack.load(book_id, AUDIO_DIR)

        async def synth(line, voice_overrides):
            return await synthesize_line_mp3(line, voice_overrides)

        job = start_pack_build(
            book_id=book_id,
            tier=req.tier,
            style=pack_style,
            playback=out,
            voices=voices,
            resume=resume,
            packs_dir=PACKS_DIR,
            synth_line=synth if req.tier == PF.TIER_AUDIOBOOK else None,
            external_audio=external,
            force=req.force,
        )
        return job.as_dict()

    @app.post("/books/{book_id}/pack/build/{job_id}/cancel")
    def cancel_offline_pack_build(book_id: str, job_id: str):
        from .pack.jobs import cancel_job, get_job

        job = get_job(job_id)
        if not job or job.book_id != book_id:
            raise HTTPException(404, "no such pack job")
        if not cancel_job(job_id):
            raise HTTPException(409, "job cannot be cancelled")
        return job.as_dict()

    @app.get("/books/{book_id}/audio/manifest")
    def external_audio_manifest(book_id: str):
        from .pack.external_audio import ExternalAudioPack

        if not L._path(book_id, ".analysis.json").exists() and not L._path(book_id, ".json").exists():
            raise HTTPException(404, "no such book")
        pack = ExternalAudioPack.load(book_id, AUDIO_DIR)
        if not pack:
            return {"book_id": book_id, "available": False, "line_count": 0}
        return {"book_id": book_id, "available": True, **pack.as_dict()}

    @app.post("/books/{book_id}/audio/import")
    async def import_external_audio(book_id: str, file: UploadFile = File(...)):
        """Import line-indexed audio (zip with vae/audio/* or flat lines/*.mp3)."""
        from .pack.external_audio import import_external_zip

        if not L._path(book_id, ".analysis.json").exists() and not L._path(book_id, ".json").exists():
            raise HTTPException(404, "no such book")
        raw = await file.read()
        try:
            pack = import_external_zip(book_id, raw, AUDIO_DIR)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        return {"ok": True, "book_id": book_id, **pack.as_dict()}

    @app.delete("/books/{book_id}/audio")
    def delete_external_audio_route(book_id: str):
        from .pack.external_audio import delete_external_audio

        if delete_external_audio(book_id, AUDIO_DIR):
            return {"ok": True, "book_id": book_id}
        raise HTTPException(404, "no external audio for book")

    @app.get("/books/{book_id}/pack/build/{job_id}")
    def offline_pack_build_status(book_id: str, job_id: str):
        from .pack.jobs import get_job

        job = get_job(job_id)
        if not job or job.book_id != book_id:
            raise HTTPException(404, "no such pack job")
        return job.as_dict()

    @app.get("/books/{book_id}/pack/build/{job_id}/file")
    def download_offline_pack_build(book_id: str, job_id: str):
        from .pack.jobs import get_job

        job = get_job(job_id)
        if not job or job.book_id != book_id:
            raise HTTPException(404, "no such pack job")
        if job.status != "done":
            raise HTTPException(409, "pack not ready")
        data = None
        if job.path and job.path.is_file():
            data = job.path.read_bytes()
        if not data:
            from .pack.r2_store import fetch_job_from_r2
            data = fetch_job_from_r2(job_id)
        if not data:
            raise HTTPException(409, "pack not ready")
        fname = f"{book_id}.{job.style}.{job.tier}.vaepack"
        return StreamingResponse(
            iter([data]),
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{fname}"'},
        )

    @app.post("/internal/queue/pack-build")
    async def internal_queue_pack_build(req: PackQueueBuildRequest, request: Request):
        """Cloudflare Queue consumer webhook — runs a pack build with a pre-assigned job id."""
        expected = os.environ.get("QUEUE_WEBHOOK_SECRET", "")
        secret = request.headers.get("X-Queue-Secret", "")
        if not expected or secret != expected:
            raise HTTPException(401, "unauthorized")
        from .pack import format as PF
        from .pack.external_audio import ExternalAudioPack
        from .pack.jobs import get_job, start_pack_build
        from .pack.synth import synthesize_line_mp3

        if get_job(req.job_id):
            return get_job(req.job_id).as_dict()
        out, pack_style, voices, resume = _pack_build_context(req.book_id, req.tier, req.style)
        external = ExternalAudioPack.load(req.book_id, AUDIO_DIR)

        async def synth(line, voice_overrides):
            return await synthesize_line_mp3(line, voice_overrides)

        job = start_pack_build(
            book_id=req.book_id,
            tier=req.tier,
            style=pack_style,
            playback=out,
            voices=voices,
            resume=resume,
            packs_dir=PACKS_DIR,
            synth_line=synth if req.tier == PF.TIER_AUDIOBOOK else None,
            external_audio=external,
            force=req.force,
            job_id=req.job_id,
        )
        return job.as_dict()

    @app.get("/internal/health")
    def internal_health():
        from .storage.r2 import r2_configured
        return {
            "ok": True,
            "r2": r2_configured(),
            "queue_secret": bool(os.environ.get("QUEUE_WEBHOOK_SECRET")),
        }

    @app.post("/books/{book_id}/pack/import")
    async def import_offline_pack(book_id: str, file: UploadFile = File(...)):
        """Upload a vae-offline-pack ZIP into server storage (sync / backup)."""
        from .pack.build import import_pack_to_server, read_pack_manifest

        raw = await file.read()
        try:
            manifest = read_pack_manifest(raw)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        if manifest.get("book_id") != book_id:
            raise HTTPException(400, "pack book_id mismatch")
        try:
            out = import_pack_to_server(raw, media_root=MEDIA_DIR, books_dir=BOOKS_DIR)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        return out

    # ---------- Ingest (background job; poll for status) ----------
    @app.post("/ingest")
    async def ingest(file: UploadFile = File(...),
                     art_style: str = Form("semi-real"),
                     narrator_gender: str = Form("male"),
                     dry_run: bool = Form(False),
                     generate_art: bool = Form(True),
                     illustration_mode: str = Form("auto")):
        book_id = Path(file.filename or "book").stem
        tmp = DATA_DIR / "uploads"; tmp.mkdir(parents=True, exist_ok=True)
        dest = tmp / f"{book_id}.epub"
        dest.write_bytes(await file.read())
        job = Job(book_id); JOBS[job.id] = job
        L.write_status(book_id, status="processing", stage="queued",
                       progress=0.0, title=book_id)
        threading.Thread(target=_run_ingest,
                         args=(job, str(dest), art_style, narrator_gender,
                               dry_run, generate_art, illustration_mode),
                         daemon=True).start()
        return {"job_id": job.id, "book_id": book_id, "status": job.status}

    @app.get("/ingest/{job_id}")
    def ingest_status(job_id: str):
        job = JOBS.get(job_id)
        if not job:
            raise HTTPException(404, "no such job")
        st = L.read_status(job.book_id) or {}
        return {"job_id": job.id, "book_id": job.book_id, "status": job.status,
                "stage": st.get("stage", job.status),
                "progress": st.get("progress", 0.0),
                "detail": job.detail, "log": job.log[-12:],
                "banners": list(st.get("banners") or [])[-12:],
                "comparisons": list(job.comparisons or [])}

    # ---------- media + built client (optional co-host) ----------
    if MEDIA_DIR.is_dir():
        app.mount("/media", StaticFiles(directory=str(MEDIA_DIR)), name="media")
    dist = os.environ.get("SERVE_WEB_DIST")
    if dist and Path(dist).is_dir():
        app.mount("/", StaticFiles(directory=dist, html=True), name="web")
    return app


app = create_app()
