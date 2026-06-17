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


class ResumeRequest(BaseModel):
    line: int = 0
    sceneId: str = ""
    chapter: int = 0


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
                dry_run: bool = False):
    """Progressive ingest. Writes the analysis (lines become playable) BEFORE
    images, then streams images in via library.set_media, bumping progress so a
    book opened mid-processing fills with art live."""
    from .epub.parse import parse_epub
    from .analyze.gemini import analyze_book, GeminiUnavailable
    from .images.generate import generate_media, media_work_items
    from .playback import library as L

    bid = job.book_id

    def status(**kw):
        kw.setdefault("art_style", art_style)
        kw.setdefault("narrator_gender", narrator_gender)
        L.write_status(bid, **kw)

    try:
        job.status = "parsing"; job.log.append("parsing EPUB")
        status(status="processing", stage="parsing", progress=0.03, title=bid)
        book = parse_epub(epub_path, bid)
        status(status="processing", stage="parsing", progress=L.PARSE_END,
               title=book.title, author=book.author)

        job.status = "analyzing"; job.log.append("Gemini mega-pass")
        analysis = analyze_book(book.book_id, book.title, book.author,
                                book.body_text, reference_images=book.images)
        # persist analysis -> book is now PLAYABLE (gradient placeholders)
        L._write_json(L._path(bid, ".analysis.json"), analysis.model_dump())
        status(status="ready", stage="analyzing", progress=L.ANALYSIS_END,
               title=book.title, author=book.author)

        if dry_run:
            # Extract-only: playable now with gradient placeholders, no image
            # quota spent. Eyeball the script, then re-ingest (or a future
            # /generate-media) to add art.
            status(status="ready", stage="done", progress=1.0)
            job.status = "done"; job.log.append("done (dry run — no images)")
            return

        job.status = "imaging"; job.log.append("image generation")
        total = media_work_items(analysis)
        done = {"n": 0}

        def on_item(kind, key, url):
            L.set_media(bid, kind, key, url)
            done["n"] += 1
            status(status="ready", stage="imaging",
                   progress=L.imaging_progress(done["n"], total))

        out_dir = str(MEDIA_DIR / bid)
        generate_media(analysis, out_dir, book.images, art_style, on_item=on_item)

        status(status="ready", stage="done", progress=1.0)
        job.status = "done"; job.log.append("done")
    except GeminiUnavailable as e:
        job.status = "error"; job.detail = f"Gemini unavailable: {e}"
        L.write_status(bid, status="error", stage="analyzing",
                       error=f"Gemini unavailable: {e}")
    except Exception as e:  # pragma: no cover
        job.status = "error"; job.detail = str(e)
        L.write_status(bid, status="error", error=str(e))


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
        """Runtime speech via Edge neural voices — per-character voice/pitch."""
        from .audio.edge_tts import synthesize_edge_mp3
        try:
            audio = await synthesize_edge_mp3(req.text, req.voice,
                                              rate=req.rate, pitch=req.pitch)
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
        return JSONResponse(out)

    @app.get("/books/{book_id}/progress")
    def get_progress(book_id: str):
        return L.read_resume(book_id) or {"line": 0, "sceneId": "", "chapter": 0}

    @app.post("/books/{book_id}/progress")
    def set_progress(book_id: str, req: ResumeRequest):
        return L.write_resume(book_id, req.line, req.sceneId, req.chapter)

    # ---------- Ingest (background job; poll for status) ----------
    @app.post("/ingest")
    async def ingest(file: UploadFile = File(...),
                     art_style: str = Form("semi-real"),
                     narrator_gender: str = Form("male"),
                     dry_run: bool = Form(False)):
        book_id = Path(file.filename or "book").stem
        tmp = DATA_DIR / "uploads"; tmp.mkdir(parents=True, exist_ok=True)
        dest = tmp / f"{book_id}.epub"
        dest.write_bytes(await file.read())
        job = Job(book_id); JOBS[job.id] = job
        L.write_status(book_id, status="processing", stage="queued",
                       progress=0.0, title=book_id)
        threading.Thread(target=_run_ingest,
                         args=(job, str(dest), art_style, narrator_gender, dry_run),
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
                "detail": job.detail, "log": job.log[-12:]}

    # ---------- media + built client (optional co-host) ----------
    if MEDIA_DIR.is_dir():
        app.mount("/media", StaticFiles(directory=str(MEDIA_DIR)), name="media")
    dist = os.environ.get("SERVE_WEB_DIST")
    if dist and Path(dist).is_dir():
        app.mount("/", StaticFiles(directory=dist, html=True), name="web")
    return app


app = create_app()
