"""Per-character Edge voice assignment + collision de-duplication.

The parallel-reader routed voices by *language*; the Visual Audiobook Engine
routes by *character*. Each character in the analysis gets a stable Edge voice
plus a subtle pitch offset so two characters that land on the same base
voice still sound distinct (Brief step 4: deeper male / higher child).
"""
from __future__ import annotations

from dataclasses import dataclass

from .edge_voice_catalog import pool_for_gender

NARRATOR_DEFAULT = {
    "male": "en-US-AndrewMultilingualNeural",
    "female": "en-US-AvaMultilingualNeural",
}


@dataclass
class VoiceAssignment:
    character_id: str
    voice: str
    pitch: str = "+0Hz"   # edge-tts pitch string; used for collision shifting
    rate: str = "+0%"

    def as_dict(self) -> dict:
        return {
            "character_id": self.character_id,
            "voice": self.voice,
            "pitch": self.pitch,
            "rate": self.rate,
        }


def _bucket(gender: str | None, age: str | None) -> str:
    g = (gender or "").lower()
    if g.startswith("m"):
        return "male"
    if g.startswith("f"):
        return "female"
    return "neutral"


def _pitch_offset(bucket: str, idx: int, age: str | None) -> int:
    """Small offsets only — large shifts sound robotic on Edge."""
    hz = 0
    if idx >= 1:
        hz += -10 if bucket == "male" else 8
    age_l = (age or "").lower()
    if age in ("child", "young"):
        hz += 6
    elif age in ("old", "elderly"):
        hz -= 6
    return max(-18, min(18, hz))


def assign_voices(characters: list[dict]) -> dict[str, dict]:
    """Map character_id -> voice assignment dict.

    `characters` come from the Gemini analysis; each has id, gender, age tier,
    importance. Primary characters get first pick of the pool; collisions on the
    same base voice are nudged by pitch (children up, gruff/old down).
    """
    assignments: dict[str, dict] = {}
    used: dict[str, int] = {"male": 0, "female": 0, "neutral": 0}
    order = sorted(
        characters,
        key=lambda c: {"primary": 0, "secondary": 1, "background": 2}.get(
            c.get("importance", "secondary"), 1),
    )
    for c in order:
        cid = c.get("id") or c.get("name")
        if not cid:
            continue
        bucket = _bucket(c.get("gender"), c.get("age"))
        pool = pool_for_gender(c.get("gender"))
        idx = used[bucket]
        used[bucket] += 1
        voice = pool[idx % len(pool)]
        pitch_hz = _pitch_offset(bucket, idx, c.get("age"))
        pitch = f"{pitch_hz:+d}Hz" if pitch_hz else "+0Hz"
        assignments[cid] = VoiceAssignment(cid, voice, pitch=pitch).as_dict()
    return assignments


def narrator_voice(gender: str = "male") -> str:
    return NARRATOR_DEFAULT.get(gender, NARRATOR_DEFAULT["male"])
