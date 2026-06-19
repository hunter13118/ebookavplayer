"""Library + progressive-processing state.

Sidecar files per book:

  data/books/{id}.analysis.json   BookAnalysis dump
  data/books/{id}.media.json      style-namespaced media manifest (see styles.py)
  data/books/{id}.status.json     status, stage, progress, art_style, generating_style
  data/media/{id}/{style}/        generated assets per art style
"""
from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path

from . import styles as S

DATA_DIR = Path(os.environ.get("DATA_DIR", "./data"))
BOOKS_DIR = DATA_DIR / "books"
MEDIA_DIR = DATA_DIR / "media"

# Progress weighting across stages (Brief pipeline): parse is quick, the mega-
# pass is the big unlock (text becomes playable), images fill the rest.
PARSE_END = 0.10
ANALYSIS_END = 0.40   # at this point lines are playable
# imaging spans ANALYSIS_END .. 1.0


def _read_json(p: Path, default=None):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def _write_json(p: Path, data) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(p.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, p)              # atomic
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _path(book_id: str, suffix: str) -> Path:
    return BOOKS_DIR / f"{book_id}{suffix}"


# ---------------- pure helpers (unit-tested) ----------------

def imaging_progress(done: int, total: int) -> float:
    """Map images-completed to the ANALYSIS_END..1.0 band."""
    if total <= 0:
        return 1.0
    frac = max(0.0, min(1.0, done / total))
    return round(ANALYSIS_END + (1.0 - ANALYSIS_END) * frac, 4)


def select_cover(media: dict | None, scenes: list | None = None) -> str | None:
    """Pick a thumbnail: explicit cover, else first generated background,
    else None (client shows a spinner / gradient)."""
    media = media or {}
    if media.get("cover"):
        return media["cover"]
    backgrounds = media.get("backgrounds") or {}
    if scenes:
        for s in scenes:
            sid = s.get("id") if isinstance(s, dict) else s
            if sid in backgrounds:
                return backgrounds[sid]
    if backgrounds:
        return next(iter(backgrounds.values()))
    return None


def _count_lines(scenes: list | None) -> int:
    if not scenes:
        return 0
    return sum(len(s.get("lines", [])) for s in scenes if isinstance(s, dict))


def analysis_from_playback(data: dict):
    """Rebuild BookAnalysis from a pre-compiled playback JSON (legacy/sample books)."""
    from ..analyze.schema import (
        BookAnalysis, AnalysisCharacter, AnalysisScene, AnalysisLine,
    )
    chars = []
    for cid, c in (data.get("characters") or {}).items():
        if cid == "narrator":
            continue
        chars.append(AnalysisCharacter(
            id=cid,
            name=c.get("name", cid),
            gender=c.get("gender", "unknown"),
            importance=c.get("importance", "secondary"),
            description=c.get("description", ""),
        ))
    scenes = []
    for s in data.get("scenes") or []:
        present = [p["character_id"] for p in s.get("present", [])
                   if isinstance(p, dict) and p.get("character_id")]
        lines = [
            AnalysisLine(
                character_id=ln.get("character_id", "narrator"),
                text=ln.get("text", ""),
                kind=ln.get("kind", "dialogue"),
            )
            for ln in s.get("lines", [])
        ]
        scenes.append(AnalysisScene(
            id=s["id"],
            chapter=int(s.get("chapter", 1)),
            title=s.get("title", ""),
            location=s.get("location") or s.get("title", ""),
            background_desc=s.get("background_desc") or s.get("title", ""),
            present_character_ids=present,
            lines=lines,
        ))
    return BookAnalysis(
        book_id=data.get("book_id", ""),
        title=data.get("title", ""),
        author=data.get("author", ""),
        characters=chars,
        scenes=scenes,
    )


def load_analysis(book_id: str):
    """Analysis sidecar, or derive from legacy pre-compiled playback JSON."""
    from ..analyze.gemini import analysis_from_json
    analysis_p = _path(book_id, ".analysis.json")
    if analysis_p.exists():
        return analysis_from_json(_read_json(analysis_p, {}))
    playback = _read_json(_path(book_id, ".json"))
    if playback:
        return analysis_from_playback(playback)
    return None


def catalog_entry(book_id: str, status: dict | None, media: dict | None,
                  scenes_count: int, scenes: list | None = None,
                  resume: dict | None = None) -> dict:
    status = status or {}
    return {
        "book_id": book_id,
        "title": status.get("title") or book_id,
        "author": status.get("author", ""),
        "status": status.get("status", "ready"),
        "stage": status.get("stage", "done"),
        "progress": float(status.get("progress", 1.0)),
        "cover": select_cover(media, scenes),
        "scenes": scenes_count,
        "lines": _count_lines(scenes),
        "error": status.get("error", ""),
        "updated": status.get("updated", 0),
        "resume": resume,
        "banners": list(status.get("banners") or []),
    }


# ---------------- status / media / resume io ----------------

def write_status(book_id: str, **fields) -> dict:
    p = _path(book_id, ".status.json")
    cur = _read_json(p, {}) or {}
    cur.update(fields)
    cur["updated"] = time.time()
    _write_json(p, cur)
    return cur


def read_status(book_id: str) -> dict | None:
    return _read_json(_path(book_id, ".status.json"))


def read_extract_pin(book_id: str) -> dict | None:
    """Per-book extract provider pin {provider, model} for analysis consistency."""
    status = read_status(book_id) or {}
    pin = status.get("extract_pin")
    if isinstance(pin, dict) and pin.get("provider"):
        return {"provider": pin["provider"], "model": pin.get("model", "")}
    return None


def write_extract_pin(book_id: str, provider: str, model: str) -> dict:
    return write_status(book_id, extract_pin={"provider": provider, "model": model})


def read_media(book_id: str) -> dict:
    raw = _read_json(_path(book_id, ".media.json"), {})
    status = read_status(book_id) or {}
    return S.ensure_manifest(raw, default_active=status.get("art_style", "semi-real"))


def write_media(book_id: str, media: dict) -> dict:
    _write_json(_path(book_id, ".media.json"), media)
    return media


def read_image_pins(book_id: str, style: str | None = None) -> dict:
    m = read_media(book_id)
    st = style or S.active_style(m)
    return S.read_pins_for_style(m, st)


def set_image_pin(book_id: str, character_id: str, provider: str,
                  seed: int | None, *, style: str | None = None) -> dict:
    m = read_media(book_id)
    st = style or S.active_style(m)
    slot = S._style_slot(m, st)
    pins = dict(slot.get("image_pins") or {})
    pins[character_id] = {"provider": provider, "seed": seed}
    slot["image_pins"] = pins
    write_media(book_id, m)
    return pins


def merge_image_pins(book_id: str, pins: dict, *, style: str | None = None) -> dict:
    if not pins:
        return read_image_pins(book_id, style)
    m = read_media(book_id)
    st = style or S.active_style(m)
    return S.merge_pins_for_style(m, st, pins)


def set_media(book_id: str, kind: str, key: str, url: str,
              *, style: str | None = None) -> dict:
    """kind: 'characters' | 'backgrounds' | 'cover'."""
    m = read_media(book_id)
    st = style or S.active_style(m)
    slot = S._style_slot(m, st)
    if kind == "cover":
        slot["cover"] = url
    else:
        slot.setdefault(kind, {})[key] = url
    write_media(book_id, m)
    return m


def patch_active_style(book_id: str, style: str) -> dict:
    m = read_media(book_id)
    status = read_status(book_id) or {}
    style = S.normalize_style_id(style)
    if not S.can_activate(m, style, generating=status.get("generating_style")):
        raise ValueError(f"style {style!r} is not ready")
    if style == "pixel" and S.style_status(m, "pixel") == "filter":
        m = S.enable_pixel_filter(m)
    else:
        m = S.set_active_style(m, style)
    write_media(book_id, m)
    write_status(book_id, art_style=style)
    return m


def activate_pixel_filter(book_id: str, source_style: str | None = None) -> dict:
    m = read_media(book_id)
    m = S.enable_pixel_filter(m, source_style=source_style)
    write_media(book_id, m)
    write_status(book_id, art_style="pixel")
    return m


def begin_style_generation(book_id: str, style: str) -> dict:
    m = read_media(book_id)
    m = S.mark_style_generating(m, style)
    write_media(book_id, m)
    write_status(book_id, generating_style=style, stage="imaging", status="ready")
    return m


def finish_style_generation(book_id: str, style: str) -> dict:
    m = read_media(book_id)
    m = S.mark_style_complete(m, style)
    write_media(book_id, m)
    write_status(book_id, generating_style=None)
    return m


def discard_style(book_id: str, style: str) -> dict:
    m = read_media(book_id)
    style = S.normalize_style_id(style)
    if S.generated_style_count(m) <= 1 and S.style_has_assets(m.get("styles", {}).get(style)):
        raise ValueError("cannot delete the only generated art style")
    S.remove_style_files(MEDIA_DIR, book_id, style)
    m = S.delete_style(m, style)
    write_media(book_id, m)
    write_status(book_id, art_style=S.active_style(m))
    return m


def write_resume(book_id: str, line: int, scene_id: str = "",
                 chapter: int = 0) -> dict:
    data = {"line": int(line), "sceneId": scene_id, "chapter": int(chapter),
            "updated": time.time()}
    _write_json(_path(book_id, ".progress.json"), data)
    return data


def read_resume(book_id: str) -> dict | None:
    return _read_json(_path(book_id, ".progress.json"))


def read_voice_overrides(book_id: str) -> dict:
    return _read_json(_path(book_id, ".voices.json"), {}) or {}


def write_voice_overrides(book_id: str, data: dict) -> dict:
    _write_json(_path(book_id, ".voices.json"), data)
    return data


# ---------------- catalog + detail ----------------

def list_catalog() -> list[dict]:
    BOOKS_DIR.mkdir(parents=True, exist_ok=True)
    seen: dict[str, dict] = {}
    # books with a status sidecar (processing or freshly ingested)
    for sp in sorted(BOOKS_DIR.glob("*.status.json")):
        book_id = sp.name[: -len(".status.json")]
        status = _read_json(sp, {}) or {}
        status = _read_json(sp, {}) or {}
        media = read_media(book_id)
        analysis = _read_json(_path(book_id, ".analysis.json"), {}) or {}
        flat, _, _ = S.resolve_compile_media(
            media, fallback_active=status.get("art_style", "semi-real"),
        )
        scenes = analysis.get("scenes", [])
        seen[book_id] = catalog_entry(book_id, status, flat, len(scenes), scenes,
                                      resume=read_resume(book_id))
    # legacy / sample pre-compiled books
    for cp in sorted(BOOKS_DIR.glob("*.json")):
        name = cp.name
        if name.endswith((".status.json", ".media.json", ".analysis.json",
                          ".progress.json")):
            continue
        book_id = cp.stem
        if book_id in seen:
            continue
        d = _read_json(cp, {}) or {}
        seen[book_id] = {
            "book_id": book_id, "title": d.get("title", book_id),
            "author": d.get("author", ""), "status": "ready", "stage": "done",
            "progress": 1.0, "cover": select_cover(None, d.get("scenes", [])),
            "scenes": len(d.get("scenes", [])), "lines": _count_lines(d.get("scenes", [])),
            "error": "", "updated": 0,
        }
    return sorted(seen.values(), key=lambda e: e["title"].lower())


def load_playback(book_id: str) -> dict | None:
    """Compile from analysis + media when possible; else legacy static JSON."""
    status = read_status(book_id) or {}
    from .epub.illustrations import load_image_index
    from .playback.illustrations import catalog_from_urls
    illus_catalog = catalog_from_urls(load_image_index(MEDIA_DIR, book_id))
    analysis = load_analysis(book_id)
    if analysis is not None:
        from .compile import compile_book
        media = read_media(book_id)
        fallback = status.get("art_style", "semi-real")
        flat_media, display_style, art_filter = S.resolve_compile_media(
            media, fallback_active=fallback,
        )
        book = compile_book(analysis, art_style=display_style,
                            narrator_gender=status.get("narrator_gender", "male"),
                            media=flat_media,
                            illustrations=illus_catalog)
        out = book.model_dump()
        out["active_style"] = S.active_style(media, fallback=fallback)
        out["styles"] = S.list_style_entries(
            media, generating=status.get("generating_style"),
        )
        out["art_filter"] = art_filter
    else:
        out = _read_json(_path(book_id, ".json"))
        if out is None:
            return None
        legacy_style = (out.get("scenes") or [{}])[0].get("art_style", "semi-real")
        out["active_style"] = legacy_style
        out["styles"] = S.list_style_entries(
            S.ensure_manifest({}, default_active=legacy_style),
        )
        out["art_filter"] = None
    out["status"] = status.get("status", "ready")
    out["stage"] = status.get("stage", "done")
    out["progress"] = float(status.get("progress", 1.0))
    media = read_media(book_id)
    fallback = status.get("art_style", "semi-real")
    active = S.active_style(media, fallback=fallback)
    out["cover"] = select_cover(
        S.flat_media_from_slot(media.get("styles", {}).get(active)),
        out.get("scenes", []),
    )
    out["voice_overrides"] = read_voice_overrides(book_id)
    out["banners"] = list(status.get("banners") or [])
    out["illustration_mode"] = status.get("illustration_mode", "reference")
    out["illustration_count"] = int(status.get("illustration_count") or 0)
    out["illustrations"] = illus_catalog
    return out
