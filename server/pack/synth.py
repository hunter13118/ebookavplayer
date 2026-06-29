"""Synthesize playback lines for offline audiobook packs."""
from __future__ import annotations

from ..audio.edge_tts import synthesize_edge_mp3
from ..audio.expression_dsp import apply_dsp_plan
from ..audio.voice_expression import build_expression_plan, infer_expression_from_text


def _apply_voice_override(line: dict, overrides: dict | None) -> dict:
    if not overrides:
        return line
    cid = line.get("character_id") or "narrator"
    ov = overrides.get("narrator") if cid == "narrator" else (overrides.get("characters") or {}).get(cid)
    if not ov:
        return line
    out = dict(line)
    if ov.get("source") == "edge" and ov.get("voice"):
        out["voice"] = ov["voice"]
    if ov.get("pitch"):
        out["pitch"] = ov["pitch"]
    if ov.get("rate"):
        out["rate"] = ov["rate"]
    if ov.get("volume"):
        out["volume"] = ov["volume"]
    return out


async def synthesize_line_mp3(line: dict, overrides: dict | None = None) -> bytes | None:
    """Edge TTS for one playback line (matches POST /tts semantics)."""
    resolved = _apply_voice_override(line, overrides)
    text = (resolved.get("text") or "").strip()
    if not text:
        return None
    voice = resolved.get("voice") or "en-US-AndrewMultilingualNeural"
    expr = resolved.get("expression")
    intensity = resolved.get("intensity")
    if not expr:
        expr, inferred_i = infer_expression_from_text(text)
        if intensity is None:
            intensity = inferred_i
    tag = {
        "text": text,
        "character": resolved.get("character_id"),
        "expression": expr or "normal",
        "environment": resolved.get("environment") or "open",
        "intensity": intensity if intensity is not None else 1.0,
    }
    plan = build_expression_plan(tag, "edge")
    ssml = plan["ssml"]
    expr = tag.get("expression") or "normal"
    use_expr_pitch = expr not in ("normal",) and not resolved.get("pitch")
    try:
        audio = await synthesize_edge_mp3(
            text,
            voice,
            rate=resolved.get("rate") or ssml.get("rate"),
            pitch=resolved.get("pitch") if resolved.get("pitch") else (
                ssml.get("pitch") if use_expr_pitch else "+0Hz"
            ),
            volume=resolved.get("volume") or ssml.get("volume"),
        )
        if not audio:
            return None
        return apply_dsp_plan(audio, plan.get("dsp") or [])
    except Exception:
        return None
