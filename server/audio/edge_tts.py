"""Edge Neural TTS — copied to a tee from the Gyōkan parallel-reader project.

This is the exact, proven pattern: browsers cannot set the WS headers Edge's
read-aloud endpoint requires, so the client calls POST /tts on this API and we
synthesize server-side with the `edge-tts` package's Communicate.stream().

Works for any Edge neural locale. The Visual Audiobook Engine assigns a
distinct Edge voice *per character* (see voices.py); this module is voice-
agnostic — give it text + a voice id and it returns MP3 bytes.
"""
from __future__ import annotations

import asyncio
import os

# Sensible defaults; per-character voices are resolved upstream (voices.py).
DEFAULT_VOICE = os.environ.get("EDGE_TTS_VOICE", "en-US-AndrewMultilingualNeural")
NARRATOR_VOICE_M = os.environ.get("EDGE_TTS_NARRATOR_M", "en-US-AndrewMultilingualNeural")
NARRATOR_VOICE_F = os.environ.get("EDGE_TTS_NARRATOR_F", "en-US-AvaMultilingualNeural")


async def list_edge_voices(locale: str | None = None) -> list[dict]:
    """Return Edge voices, optionally filtered by locale prefix (e.g. en-US)."""
    import edge_tts

    voices = await edge_tts.list_voices()
    rows = []
    for v in voices:
        loc = v.get("Locale", "")
        if locale and not loc.startswith(locale):
            continue
        short = v.get("ShortName", "")
        friendly = v.get("FriendlyName") or v.get("Name") or short
        rows.append({
            "id": short,
            "label": friendly,
            "locale": loc,
            "gender": v.get("Gender", ""),
        })
    return rows


async def synthesize_edge_mp3(
    text: str,
    voice: str | None = None,
    *,
    rate: str | None = None,
    pitch: str | None = None,
    volume: str | None = None,
) -> bytes:
    """Return MP3 bytes for `text` using an Edge neural voice.

    `rate`/`pitch` use edge-tts' string form, e.g. rate="+0%", pitch="-30Hz".
    Pitch shifting is how we de-collide voices when two characters share a base
    voice (deeper male / higher child) — Brief §Core Pipeline step 4.
    """
    text = (text or "").strip()
    if not text:
        return b""
    import edge_tts

    voice = voice or DEFAULT_VOICE
    kwargs = {}
    if rate:
        kwargs["rate"] = rate
    if pitch:
        kwargs["pitch"] = pitch
    if volume:
        kwargs["volume"] = volume
    chunks: list[bytes] = []
    communicate = edge_tts.Communicate(text, voice, **kwargs)
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            chunks.append(chunk["data"])
    return b"".join(chunks)


def synthesize_edge_mp3_sync(text: str, voice: str | None = None, **kw) -> bytes:
    return asyncio.run(synthesize_edge_mp3(text, voice, **kw))
