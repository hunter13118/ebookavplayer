"""Per-character Edge voice assignment + collision de-duplication.

The parallel-reader routed voices by *language*; the Visual Audiobook Engine
routes by *character*. Each character in the analysis gets a stable Edge voice
plus an optional pitch offset so two characters that land on the same base
voice still sound distinct (Brief step 4: deeper male / higher child).
"""
from __future__ import annotations

from dataclasses import dataclass, field

# Curated multilingual + expressive Edge neural voices, grouped by perceived
# register. Multilingual voices handle non-English names/loanwords gracefully.
VOICE_POOL = {
    "male": [
        "en-US-AndrewMultilingualNeural",
        "en-US-BrianMultilingualNeural",
        "en-GB-RyanNeural",
        "en-US-RogerNeural",
        "en-AU-WilliamMultilingualNeural",
    ],
    "female": [
        "en-US-AvaMultilingualNeural",
        "en-US-EmmaMultilingualNeural",
        "en-GB-SoniaNeural",
        "en-US-JennyNeural",
        "en-US-AriaNeural",
    ],
    "neutral": [
        "en-US-AndrewMultilingualNeural",
        "en-US-AvaMultilingualNeural",
    ],
}

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


def assign_voices(characters: list[dict]) -> dict[str, dict]:
    """Map character_id -> voice assignment dict.

    `characters` come from the Gemini analysis; each has id, gender, age tier,
    importance. Primary characters get first pick of the pool; collisions on the
    same base voice are nudged by pitch (children up, gruff/old down).
    """
    assignments: dict[str, dict] = {}
    used: dict[str, int] = {"male": 0, "female": 0, "neutral": 0}
    # Primary first so the most-heard characters get unique base voices.
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
        pool = VOICE_POOL[bucket]
        idx = used[bucket]
        used[bucket] += 1
        voice = pool[idx % len(pool)]
        # Collision shifting once we wrap the pool, plus age-based nudges.
        pitch_hz = 0
        if idx >= len(pool):
            pitch_hz += -30 if bucket == "male" else 25  # second lap → shift
        age = (c.get("age") or "").lower()
        if age in ("child", "young"):
            pitch_hz += 35
        elif age in ("old", "elderly"):
            pitch_hz += -20
        pitch = f"{pitch_hz:+d}Hz"
        assignments[cid] = VoiceAssignment(cid, voice, pitch=pitch).as_dict()
    return assignments


def narrator_voice(gender: str = "male") -> str:
    return NARRATOR_DEFAULT.get(gender, NARRATOR_DEFAULT["male"])
