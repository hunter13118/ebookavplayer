"""Library + progressive-processing state.

The library landing needs, per book: a status (processing|ready), a 0..1
processing progress, a cover thumbnail (or none -> spinner), and the title.
Because the Gemini mega-pass is atomic, *lines* become playable as soon as
analysis finishes; *images* then stream in. We model that as sidecar files so
a book can be opened and upgraded live without rewriting the whole playback
JSON:

  data/books/{id}.analysis.json   BookAnalysis dump (written once after mega-pass)
  data/books/{id}.media.json      {characters:{}, backgrounds:{}, cover}  (grows)
  data/books/{id}.status.json     {status, stage, progress, title, author, ...}
  data/books/{id}.json            legacy/sample: a pre-compiled PlaybackBook
  data/books/{id}.progress.json   resume position {line, sceneId, chapter, updated}

Book detail is compiled on the fly from analysis + current media, so newly
generated art appears on the next poll with no recompile-and-rewrite.
"""
from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR", "./data"))
BOOKS_DIR = DATA_DIR / "books"

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


def catalog_entry(book_id: str, status: dict | None, media: dict | None,
                  scenes_count: int, scenes: list | None = None) -> dict:
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


def read_media(book_id: str) -> dict:
    return _read_json(_path(book_id, ".media.json"),
                      {"characters": {}, "backgrounds": {}, "cover": None})


def set_media(book_id: str, kind: str, key: str, url: str) -> dict:
    """kind: 'characters' | 'backgrounds' | 'cover'."""
    p = _path(book_id, ".media.json")
    m = read_media(book_id)
    if kind == "cover":
        m["cover"] = url
    else:
        m.setdefault(kind, {})[key] = url
    _write_json(p, m)
    return m


def write_resume(book_id: str, line: int, scene_id: str = "",
                 chapter: int = 0) -> dict:
    data = {"line": int(line), "sceneId": scene_id, "chapter": int(chapter),
            "updated": time.time()}
    _write_json(_path(book_id, ".progress.json"), data)
    return data


def read_resume(book_id: str) -> dict | None:
    return _read_json(_path(book_id, ".progress.json"))


# ---------------- catalog + detail ----------------

def list_catalog() -> list[dict]:
    BOOKS_DIR.mkdir(parents=True, exist_ok=True)
    seen: dict[str, dict] = {}
    # books with a status sidecar (processing or freshly ingested)
    for sp in sorted(BOOKS_DIR.glob("*.status.json")):
        book_id = sp.name[: -len(".status.json")]
        status = _read_json(sp, {}) or {}
        media = read_media(book_id)
        analysis = _read_json(_path(book_id, ".analysis.json"), {}) or {}
        scenes = analysis.get("scenes", [])
        seen[book_id] = catalog_entry(book_id, status, media, len(scenes), scenes)
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
    """Compile the playback book from analysis + current media (progressive),
    or load a legacy/sample pre-compiled book. Attaches status/progress."""
    analysis_p = _path(book_id, ".analysis.json")
    status = read_status(book_id) or {}
    if analysis_p.exists():
        from ..analyze.gemini import analysis_from_json
        from .compile import compile_book
        analysis = analysis_from_json(_read_json(analysis_p, {}))
        media = read_media(book_id)
        art_style = status.get("art_style", "semi-real")
        narrator_gender = status.get("narrator_gender", "male")
        book = compile_book(analysis, art_style=art_style,
                            narrator_gender=narrator_gender, media=media)
        out = book.model_dump()
    else:
        out = _read_json(_path(book_id, ".json"))
        if out is None:
            return None
    out["status"] = status.get("status", "ready")
    out["stage"] = status.get("stage", "done")
    out["progress"] = float(status.get("progress", 1.0))
    out["cover"] = select_cover(read_media(book_id), out.get("scenes", []))
    return out
