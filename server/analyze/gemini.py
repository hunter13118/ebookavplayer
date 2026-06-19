"""Gemini client for the mega-pass analysis + (in images/) image generation.

Free-tier friendly: ONE generate_content call per book. Falls back across
models on failure. On 429 / quota errors, retries with backoff before advancing
the model chain. Network/keys are host-side; this module is import-safe without
a key so tests and the sample path work offline.
"""
from __future__ import annotations

import json
import os
from typing import Any, Callable

from ..images.model_lists import GEMINI_TEXT_MODELS
from .gemini_errors import (
    call_with_rate_limit_retry,
    is_quota_exhausted,
    is_rate_limit_error,
)
from .prompt import build_prompt
from .schema import BookAnalysis

OnEvent = Callable[..., None]


class GeminiUnavailable(RuntimeError):
    """Raised when the text mega-pass cannot complete."""

    def __init__(self, message: str, *, code: str = "unknown", cause: Exception | None = None):
        super().__init__(message)
        self.code = code
        self.cause = cause


def _emit(on_event: OnEvent | None, event: str, **data: Any) -> None:
    if not on_event:
        return
    try:
        on_event(event, **data)
    except TypeError:
        on_event(event)  # type: ignore[misc]


def _strip_code_fence(s: str) -> str:
    s = s.strip()
    if s.startswith("```"):
        s = s.split("\n", 1)[1] if "\n" in s else s
        if s.endswith("```"):
            s = s.rsplit("```", 1)[0]
        if s.lstrip().startswith("json"):
            s = s.lstrip()[4:]
    return s.strip()


def _coerce_analysis(raw: str, book_id: str) -> BookAnalysis:
    data = json.loads(raw)
    data.setdefault("book_id", book_id)
    return BookAnalysis.model_validate(data)


REPAIR_INSTRUCTION = (
    "Your previous response could not be parsed into the required schema. "
    "Return ONLY a single corrected JSON object matching the schema exactly — "
    "no prose, no code fences. Fix the specific problem described below."
)


def _generate_json(client, model_name: str, parts: list, cfg, *, on_event: OnEvent | None):
    def _call():
        return client.models.generate_content(model=model_name, contents=parts, config=cfg)

    def _on_retry(attempt: int, wait: float, err: BaseException):
        _emit(on_event, "gemini_text_retry", model=model_name, attempt=attempt, wait_sec=wait, error=str(err))

    return call_with_rate_limit_retry(_call, on_retry=_on_retry)


def _analyze_with_model(client, model_name: str, parts: list, cfg, book_id: str,
                        *, on_event: OnEvent | None) -> BookAnalysis:
    resp = _generate_json(client, model_name, parts, cfg, on_event=on_event)
    raw = _strip_code_fence(resp.text or "")
    try:
        return _coerce_analysis(raw, book_id)
    except Exception as first_err:
        repair = (f"{REPAIR_INSTRUCTION}\n\nError:\n{first_err}\n\n"
                  f"Your previous output:\n{raw[:20000]}")
        from google.genai import types
        resp2 = _generate_json(
            client, model_name, [repair],
            types.GenerateContentConfig(
                system_instruction="Output only a single JSON object.",
                response_mime_type="application/json",
                temperature=0.1,
            ),
            on_event=on_event,
        )
        raw2 = _strip_code_fence(resp2.text or "")
        return _coerce_analysis(raw2, book_id)


def analyze_book(book_id: str, title: str, author: str, body_text: str,
                 reference_images: list[bytes] | None = None,
                 model: str | None = None,
                 on_event: OnEvent | None = None) -> BookAnalysis:
    """Run the single mega-pass. Raises GeminiUnavailable if no key/SDK."""
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise GeminiUnavailable("GEMINI_API_KEY not set", code="no_key")
    try:
        from google import genai
        from google.genai import types
    except ImportError as e:  # pragma: no cover
        raise GeminiUnavailable(f"google-genai not installed: {e}", code="no_sdk") from e

    models = [model] if model else []
    models += [m for m in GEMINI_TEXT_MODELS if m not in models]
    client = genai.Client(api_key=api_key)
    max_chars = int(os.environ.get("GEMINI_MAX_CHARS", "120000"))
    if max_chars and len(body_text) > max_chars:
        body_text = body_text[:max_chars]
    prompt = build_prompt(book_id, title, author, body_text,
                          has_reference_images=bool(reference_images))
    parts: list = [prompt]
    for img in (reference_images or [])[:8]:
        parts.append(types.Part.from_bytes(data=img, mime_type="image/jpeg"))

    cfg = types.GenerateContentConfig(
        system_instruction="Output only a single JSON object.",
        response_mime_type="application/json",
        temperature=0.4,
    )
    last_err: Exception | None = None
    saw_rate_limit = False
    saw_quota = False
    for i, model_name in enumerate(models):
        try:
            return _analyze_with_model(
                client, model_name, parts, cfg, book_id, on_event=on_event,
            )
        except Exception as e:
            last_err = e
            if is_rate_limit_error(e):
                saw_rate_limit = True
            if is_quota_exhausted(e):
                saw_quota = True
            if i < len(models) - 1:
                _emit(
                    on_event, "gemini_text_fallback",
                    from_model=model_name, to_model=models[i + 1], error=str(e),
                )
                continue
    _emit(on_event, "gemini_text_exhausted", quota=saw_quota, rate_limit=saw_rate_limit)
    if saw_quota:
        code = "quota_exhausted"
        msg = (
            "Gemini text quota exhausted on all models. Enable billing in AI Studio, "
            "wait for the daily reset, or ingest with Extract-only (dry run) and add art later."
        )
    elif saw_rate_limit:
        code = "rate_limited"
        msg = (
            "Gemini text rate limit hit on all models. Wait a minute and retry, "
            "or use Extract-only to preview without spending quota."
        )
    else:
        code = "all_models_failed"
        msg = f"all text models failed: {last_err}"
    raise GeminiUnavailable(msg, code=code, cause=last_err) from last_err


def analysis_from_json(data: dict) -> BookAnalysis:
    """Validate a pre-computed analysis dict (used by tests + cached runs)."""
    return BookAnalysis.model_validate(data)
