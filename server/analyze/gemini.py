"""Gemini client for the mega-pass analysis + (in images/) image generation.

Free-tier friendly: ONE generate_content call per book. Falls back across
models. Network/keys are host-side; this module is import-safe without a key
so tests and the sample path work offline.
"""
from __future__ import annotations

import json
import os

from .prompt import build_prompt
from .schema import BookAnalysis


class GeminiUnavailable(RuntimeError):
    pass


def _strip_code_fence(s: str) -> str:
    s = s.strip()
    if s.startswith("```"):
        s = s.split("\n", 1)[1] if "\n" in s else s
        if s.endswith("```"):
            s = s.rsplit("```", 1)[0]
        # drop a leading 'json' tag
        if s.lstrip().startswith("json"):
            s = s.lstrip()[4:]
    return s.strip()


def _coerce_analysis(raw: str, book_id: str) -> "BookAnalysis":
    """Parse + validate the model's text into a BookAnalysis (raises on bad)."""
    data = json.loads(raw)
    data.setdefault("book_id", book_id)
    return BookAnalysis.model_validate(data)


REPAIR_INSTRUCTION = (
    "Your previous response could not be parsed into the required schema. "
    "Return ONLY a single corrected JSON object matching the schema exactly — "
    "no prose, no code fences. Fix the specific problem described below."
)


def analyze_book(book_id: str, title: str, author: str, body_text: str,
                 reference_images: list[bytes] | None = None,
                 model: str | None = None) -> BookAnalysis:
    """Run the single mega-pass. Raises GeminiUnavailable if no key/SDK."""
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise GeminiUnavailable("GEMINI_API_KEY not set")
    try:
        from google import genai
        from google.genai import types
    except ImportError as e:  # pragma: no cover - host has the SDK
        raise GeminiUnavailable(f"google-genai not installed: {e}") from e

    # Text model (2026): Gemini 3.5 is current; gemini-2.5-flash stays valid and
    # is reliable for JSON mode. Override via GEMINI_MODEL.
    model = model or os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
    client = genai.Client(api_key=api_key)
    # Simplest-form guard: cap the text sent in one mega-pass so a big book
    # doesn't exceed context / free-tier limits. Raise GEMINI_MAX_CHARS (or set
    # 0 for no cap) once you move past the minimal path.
    max_chars = int(os.environ.get("GEMINI_MAX_CHARS", "120000"))
    if max_chars and len(body_text) > max_chars:
        body_text = body_text[:max_chars]
    prompt = build_prompt(book_id, title, author, body_text,
                          has_reference_images=bool(reference_images))
    parts: list = [prompt]
    for img in (reference_images or [])[:8]:   # cap reference images
        parts.append(types.Part.from_bytes(data=img, mime_type="image/jpeg"))

    resp = client.models.generate_content(
        model=model,
        contents=parts,
        config=types.GenerateContentConfig(
            system_instruction="Output only a single JSON object.",
            response_mime_type="application/json",
            temperature=0.4,
        ),
    )
    raw = _strip_code_fence(resp.text or "")
    try:
        return _coerce_analysis(raw, book_id)
    except Exception as first_err:
        # One repair re-ask: hand the model its bad output + the error and ask
        # it to fix. Models occasionally emit a stray field or truncate; this
        # recovers most without a full re-run.
        repair = (f"{REPAIR_INSTRUCTION}\n\nError:\n{first_err}\n\n"
                  f"Your previous output:\n{raw[:20000]}")
        resp2 = client.models.generate_content(
            model=model,
            contents=[repair],
            config=types.GenerateContentConfig(
                system_instruction="Output only a single JSON object.",
                response_mime_type="application/json",
                temperature=0.1,
            ),
        )
        raw2 = _strip_code_fence(resp2.text or "")
        return _coerce_analysis(raw2, book_id)  # let it raise if still invalid


def analysis_from_json(data: dict) -> BookAnalysis:
    """Validate a pre-computed analysis dict (used by tests + cached runs)."""
    return BookAnalysis.model_validate(data)
