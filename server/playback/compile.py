"""Compile a BookAnalysis into the lightweight PlaybackBook the client consumes.

Backend does the heavy lifting (Brief 'Backend vs Gemini split'): resolve
per-character voices, flatten lines with stable indices, resolve background
reuse, and attach media refs (real generated media or css-gradient tokens so
the client renders something even before image gen runs).
"""
from __future__ import annotations

import hashlib

from ..analyze.schema import (
    BookAnalysis, PlaybackBook, PlaybackScene, PlaybackLine,
)
from ..audio.voices import assign_voices, narrator_voice


def _gradient_token(seed: str) -> str:
    """Deterministic css-gradient placeholder token from a seed string."""
    h = hashlib.sha1(seed.encode()).hexdigest()
    a = int(h[0:2], 16) * 360 // 255
    b = (a + 40 + int(h[2:4], 16) % 120) % 360
    return f"gradient:{a},{b}"


def _sprite_for(character_id: str, media: dict | None) -> str:
    if media and character_id in media.get("characters", {}):
        return media["characters"][character_id]
    return f"sprite:{_gradient_token(character_id)}"


def compile_book(analysis: BookAnalysis, *, art_style: str = "semi-real",
                 narrator_gender: str = "male",
                 media: dict | None = None) -> PlaybackBook:
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
        for ln in s.lines:
            cid = ln.character_id
            info = characters_out.get(cid) or characters_out["narrator"]
            lines_out.append(PlaybackLine(
                idx=idx, character_id=cid, speaker_name=info["name"],
                text=ln.text, kind=ln.kind, voice=info["voice"],
                pitch=info["pitch"], rate=info["rate"],
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
