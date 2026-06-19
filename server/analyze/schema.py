"""Structured output schema for the single Gemini mega-pass + playback format.

Two layers:
  * Analysis*  — what Gemini returns (one pass per book): characters, scenes,
    line allocation, importance tiers, appearance/time-skip + scene-reuse flags.
  * Playback*  — the lightweight format the backend compiles and the dumb
    client consumes (resolved voices + media refs + ordered lines).
"""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

Importance = Literal["primary", "secondary", "background"]
Gender = Literal["male", "female", "unknown"]


# ---------- Analysis layer (Gemini output) ----------

class AnalysisCharacter(BaseModel):
    id: str = Field(..., description="stable slug, e.g. 'elara'")
    name: str
    aliases: list[str] = []
    gender: Gender = "unknown"
    age: str = "adult"            # child | young | adult | old
    importance: Importance = "secondary"
    description: str = ""         # visual description for image gen
    appearance_changes: list[str] = []  # notable look changes warranting new art
    illustration_ref: Optional[int] = None  # index into EPUB extracted images


class AnalysisLine(BaseModel):
    character_id: str = Field(..., description="'narrator' for narration")
    text: str
    kind: Literal["dialogue", "narration", "thought"] = "dialogue"
    expression: str = "normal"       # whisper|yell|sad|angry|normal (loose ok)
    environment: str = "open"        # open|indoor|hall|cave
    intensity: float = 1.0           # 0..1
    illustration_ref: Optional[int] = None  # flash EPUB insert at this line


class AnalysisScene(BaseModel):
    id: str
    chapter: int
    title: str = ""
    location: str = ""
    background_desc: str = ""     # for image gen
    reuse_background_of: Optional[str] = None  # scene id whose bg to reuse
    time_skip_before: bool = False
    present_character_ids: list[str] = []
    lines: list[AnalysisLine] = []
    illustration_ref: Optional[int] = None  # index into EPUB extracted images


class BookAnalysis(BaseModel):
    book_id: str
    title: str = ""
    author: str = ""
    characters: list[AnalysisCharacter] = []
    scenes: list[AnalysisScene] = []


# ---------- Playback layer (client consumes) ----------

class PlaybackLine(BaseModel):
    idx: int
    character_id: str
    speaker_name: str
    text: str
    kind: str = "dialogue"
    voice: str                       # resolved Edge voice id
    pitch: str = "+0Hz"
    rate: str = "+0%"
    expression: str = "normal"
    environment: str = "open"
    intensity: float = 1.0
    illustration_ref: Optional[int] = None
    illustration_url: Optional[str] = None


class PlaybackScene(BaseModel):
    id: str
    chapter: int
    title: str = ""
    background: str                  # media url or css-gradient token
    art_style: str = "semi-real"     # semi-real | pixel | anime | cartoon
    present: list[dict] = []         # [{character_id, name, sprite, importance}]
    lines: list[PlaybackLine] = []


class PlaybackBook(BaseModel):
    book_id: str
    title: str = ""
    author: str = ""
    characters: dict[str, dict] = {}   # id -> {name, sprite, voice, pitch, ...}
    scenes: list[PlaybackScene] = []
