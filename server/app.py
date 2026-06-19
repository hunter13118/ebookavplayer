"""FastAPI app for the Visual Audiobook Engine.

Thin shell. /tts + /voices/edge are copied to a tee from the Gyōkan parallel-
reader (browsers can't set Edge WS headers, so synthesis is server-side). The
rest serves the library catalog + compiled playback JSON and runs ingest.

Run:  uvicorn server.app:app --host 0.0.0.0 --port 8600
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

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

DATA_DIR = Path(os.environ.get("DATA_DIR", "./data"))
BOOKS_DIR = DATA_DIR / "books"
MEDIA_DIR = DATA_DIR / "media"


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
    source: str = "edge"   # edge | uploaded (uploaded = future)
    voice: str = ""


class VoiceOverridesRequest(BaseModel):
    narrator: VoiceOverride | None = None
    characters: dict[str, VoiceOverride] = Field(default_factory=dict)


class ReplaceMediaRequest(BaseModel):
    scope: str = "all"           # all | cover | characters | backgrounds | selected
    mode: str = "generate"       # generate only (upload uses separate endpoint)
    character_ids: list[str] | None = None
    scene_ids: list[str] | None = None
    include_cover: bool = False
    force_all: bool = True
    art_style: str | None = None


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


JOBS: dict[str, Job] = {}


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
               illustration_count=len(book.images))

        job.status = "analyzing"; job.log.append("text extraction mega-pass")
        from .images.notify import push_analysis_event
        L.write_status(bid, banners=[])
        analysis = extract_book(
            book.book_id, book.title, book.author,
            book.body_text, reference_images=book.images,
            on_event=lambda ev, **kw: push_analysis_event(bid, ev, **kw),
        )
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


def _run_generate_media(job: Job, book_id: str, opts: dict | None = None):
    """Generate or replace art (Gemini cascade → local War Council SD)."""
    from .images.generate import generate_media, media_work_items
    from .playback import library as L

    opts = opts or {}
    scope = opts.get("scope", "all")
    force_all = opts.get("force_all", True)
    character_ids = opts.get("character_ids")
    scene_ids = opts.get("scene_ids")
    include_cover = opts.get("include_cover", False)

    try:
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
        job.status = "imaging"
        job.log.append(f"replacing art ({scope}, style={art_style})")
        from .images.notify import ImagingBannerSink
        L.begin_style_generation(book_id, art_style)
        L.write_status(book_id, status="ready", stage="imaging",
                       progress=L.ANALYSIS_END, banners=[])
        banner_sink = ImagingBannerSink(book_id)
        from .epub.illustrations import load_image_index
        from .playback import styles as St
        pre_done = 0
        st = L.read_status(book_id) or {}
        if st.get("illustration_mode") == "direct-use":
            urls = load_image_index(MEDIA_DIR, book_id)
            if urls:
                from .playback.illustrations import apply_direct_illustrations
                counts = apply_direct_illustrations(
                    book_id, analysis, urls, style=art_style, set_media=L.set_media,
                )
                pre_done = counts["cover"] + counts["characters"] + counts["backgrounds"]
        flat_existing = St.flat_media_from_slot(
            L.read_media(book_id).get("styles", {}).get(art_style, {}),
        )
        total = media_work_items(analysis, force_all=force_all, scope=scope,
                                 character_ids=character_ids, scene_ids=scene_ids,
                                 include_cover=include_cover)
        done = {"n": pre_done}

        def on_item(kind, key, url):
            L.set_media(book_id, kind, key, url, style=art_style)
            done["n"] += 1
            L.write_status(book_id, status="ready", stage="imaging",
                           progress=L.imaging_progress(done["n"], total))

        out_dir = str(MEDIA_DIR / book_id)
        pins = L.read_image_pins(book_id, style=art_style)
        result = generate_media(analysis, out_dir, None, art_style, on_item=on_item,
                                force_all=force_all, scope=scope,
                                character_ids=character_ids, scene_ids=scene_ids,
                                include_cover=include_cover,
                                on_event=banner_sink, image_pins=pins,
                                existing_media=flat_existing)
        L.merge_image_pins(book_id, result.get("image_pins") or {}, style=art_style)
        L.finish_style_generation(book_id, art_style)
        from .playback import styles as St
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
        L.write_status(book_id, status="error", stage="imaging", error=str(e),
                       generating_style=None)


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
        try:
            audio = await synthesize_edge_mp3(
                req.text, req.voice,
                rate=req.rate or ssml.get("rate"),
                pitch=req.pitch or ssml.get("pitch"),
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
            raise HTTPException(
                400,
                "Use PATCH /active-style with mode=filter for instant pixel filter, "
                "or POST to generate real pixel-art assets.",
            )
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
        if kind not in ("cover", "characters", "backgrounds"):
            raise HTTPException(400, "kind must be cover, characters, or backgrounds")
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
                "banners": list(st.get("banners") or [])[-12:]}

    # ---------- media + built client (optional co-host) ----------
    if MEDIA_DIR.is_dir():
        app.mount("/media", StaticFiles(directory=str(MEDIA_DIR)), name="media")
    dist = os.environ.get("SERVE_WEB_DIST")
    if dist and Path(dist).is_dir():
        app.mount("/", StaticFiles(directory=dist, html=True), name="web")
    return app


app = create_app()
