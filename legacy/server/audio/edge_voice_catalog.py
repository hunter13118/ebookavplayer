"""Curated Edge *Neural voices (en-*) by perceived gender from the Edge API Gender field."""
from __future__ import annotations

# Male — Guy, Davis, Jason, Ryan, Andrew, Brian, etc.
NATURAL_MALE: list[str] = [
    "en-US-AndrewMultilingualNeural",
    "en-US-BrianMultilingualNeural",
    "en-US-ChristopherNeural",
    "en-US-DavisNeural",
    "en-US-EricNeural",
    "en-US-GuyNeural",
    "en-US-JasonNeural",
    "en-US-RogerNeural",
    "en-US-SteffanNeural",
    "en-US-TonyNeural",
    "en-GB-RyanNeural",
    "en-GB-ThomasNeural",
    "en-AU-WilliamMultilingualNeural",
]

# Female — Jenny, Aria, Emma, Sonia, etc.
NATURAL_FEMALE: list[str] = [
    "en-US-AvaMultilingualNeural",
    "en-US-AriaNeural",
    "en-US-EmmaMultilingualNeural",
    "en-US-JennyNeural",
    "en-US-MichelleNeural",
    "en-US-MonicaNeural",
    "en-US-NancyNeural",
    "en-US-SaraNeural",
    "en-GB-LibbyNeural",
    "en-GB-MaisieNeural",
    "en-GB-SoniaNeural",
    "en-AU-NatashaNeural",
]

NATURAL_NEUTRAL: list[str] = [
    "en-US-AndrewMultilingualNeural",
    "en-US-AvaMultilingualNeural",
]


def pool_for_gender(gender: str | None) -> list[str]:
    g = (gender or "").lower()
    if g.startswith("m"):
        return NATURAL_MALE
    if g.startswith("f"):
        return NATURAL_FEMALE
    return NATURAL_NEUTRAL


def is_neural_voice(voice_id: str) -> bool:
    return "Neural" in (voice_id or "")
