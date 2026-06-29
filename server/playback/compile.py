"""Compile a BookAnalysis into the lightweight PlaybackBook the client consumes.

Backend does the heavy lifting (Brief 'Backend vs Gemini split'): resolve
per-character voices, flatten lines with stable indices, resolve background
reuse, and attach media refs (real generated media or css-gradient tokens so
the client renders something even before image gen runs).
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path

from ..analyze.schema import (
    BookAnalysis, PlaybackBook, PlaybackScene, PlaybackLine,
)
from ..audio.voices import assign_voices, narrator_voice
from ..audio.voice_expression import (
    infer_expression_from_text, normalize_environment, normalize_expression,
)
from .illustrations import resolve_line_illustration
from .sprites import resolve_line_sprite


def _gradient_token(seed: str) -> str:
    """Deterministic css-gradient placeholder token from a seed string."""
    h = hashlib.sha1(seed.encode()).hexdigest()
    a = int(h[0:2], 16) * 360 // 255
    b = (a + 40 + int(h[2:4], 16) % 120) % 360
    return f"gradient:{a},{b}"


def _media_path_from_url(url: str) -> Path | None:
    """Map a /media/... URL (optional ?v= query) to a file under DATA_DIR/media."""
    if not url or not url.startswith("/media/"):
        return None
    path_part = url.split("?", 1)[0].removeprefix("/media/")
    root = Path(os.environ.get("DATA_DIR", "./data")) / "media"
    return root / path_part


def _media_file_exists(url: str) -> bool:
    """True when a /media/... URL points at a real file on disk."""
    p = _media_path_from_url(url)
    return p.is_file() if p else False


def _sprite_for(character_id: str, media: dict | None) -> str:
    if media and character_id in media.get("characters", {}):
        url = media["characters"][character_id]
        if url.startswith("/media/") and not _media_file_exists(url):
            return f"sprite:{_gradient_token(character_id)}"
        return url
    return f"sprite:{_gradient_token(character_id)}"


def compile_book(analysis: BookAnalysis, *, art_style: str = "semi-real",
                 narrator_gender: str = "male",
                 media: dict | None = None,
                 illustrations: list[str] | None = None) -> PlaybackBook:
    """media (optional): {'characters': {id: url}, 'backgrounds': {scene_id: url}}"""
    char_dicts = [c.model_dump() for c in analysis.characters]
    voice_map = assign_voices(char_dicts)
    nvoice = narrator_voice(narrator_gender)

    characters_out: dict[str, dict] = {}
    for c in analysis.characters:
        va = voice_map.get(c.id, {"voice": nvoice, "pitch": "+0Hz", "rate": "+0%"})
        characters_out[c.id] = {
            "name": c.name,
            "importance": c.importance,
            "gender": c.gender,
            "sprite": _sprite_for(c.id, media),
            "voice": va["voice"],
            "pitch": va.get("pitch", "+0Hz"),
            "rate": va.get("rate", "+0%"),
            "description": c.description,
        }
    # narrator pseudo-character
    characters_out["narrator"] = {
        "name": "Narrator", "importance": "primary", "gender": narrator_gender,
        "sprite": "sprite:narrator", "voice": nvoice, "pitch": "+0Hz",
        "rate": "+0%", "description": "",
    }

    # resolve background reuse
    bg_by_scene: dict[str, str] = {}
    scenes_out: list[PlaybackScene] = []
    idx = 0
    for s in analysis.scenes:
        if s.reuse_background_of and s.reuse_background_of in bg_by_scene:
            bg = bg_by_scene[s.reuse_background_of]
        elif media and s.id in media.get("backgrounds", {}):
            bg = media["backgrounds"][s.id]
            if bg.startswith("/media/") and not _media_file_exists(bg):
                bg = _gradient_token(s.location or s.background_desc or s.id)
        else:
            bg = _gradient_token(s.location or s.background_desc or s.id)
        bg_by_scene[s.id] = bg

        present = []
        for cid in s.present_character_ids:
            info = characters_out.get(cid)
            if not info:
                continue
            present.append({
                "character_id": cid, "name": info["name"],
                "sprite": info["sprite"], "importance": info["importance"],
            })

        lines_out = []
        scene_env = normalize_environment(s.location or s.background_desc or "open")
        scene_illus = getattr(s, "illustration_ref", None)
        for li, ln in enumerate(s.lines):
            cid = ln.character_id
            info = characters_out.get(cid) or characters_out["narrator"]
            raw_expr = getattr(ln, "expression", None)
            intensity = float(getattr(ln, "intensity", 1.0) or 1.0)
            if raw_expr and str(raw_expr).strip().lower() not in ("", "normal"):
                expr = normalize_expression(raw_expr)
            else:
                expr, inferred_i = infer_expression_from_text(ln.text, ln.kind)
                if intensity == 1.0:
                    intensity = inferred_i
            raw_env = getattr(ln, "environment", None)
            env = normalize_environment(raw_env) if raw_env else scene_env
            line_illus = getattr(ln, "illustration_ref", None)
            ill_ref, ill_url = resolve_line_illustration(
                line_illus, scene_illus,
                is_first_line_in_scene=(li == 0),
                catalog=illustrations or [],
            )
            insert_url = None
            if media:
                insert_url = (media.get("inserts") or {}).get(str(idx))
                if insert_url and insert_url.startswith("/media/") and not _media_file_exists(insert_url):
                    insert_url = None
            if insert_url:
                ill_url = insert_url
            caption = None
            if ill_url:
                caption = (ln.text or "")[:72].strip()
                if len((ln.text or "")) > 72:
                    caption += "…"
            sprite_url = resolve_line_sprite(
                cid, expr or "normal", media, info["sprite"],
            )
            lines_out.append(PlaybackLine(
                idx=idx, character_id=cid, speaker_name=info["name"],
                text=ln.text, kind=ln.kind, voice=info["voice"],
                pitch=info["pitch"], rate=info["rate"],
                expression=expr or "normal",
                environment=env if env else "open",
                intensity=intensity,
                illustration_ref=ill_ref,
                illustration_url=ill_url,
                illustration_caption=caption,
                sprite_url=sprite_url,
                line_weight=getattr(ln, "line_weight", None) or "normal",
                delivery_verb=getattr(ln, "delivery_verb", None),
            ))
            idx += 1

        scenes_out.append(PlaybackScene(
            id=s.id, chapter=s.chapter, title=s.title, background=bg,
            art_style=art_style, present=present, lines=lines_out,
        ))

    return PlaybackBook(
        book_id=analysis.book_id, title=analysis.title, author=analysis.author,
        characters=characters_out, scenes=scenes_out,
    )
