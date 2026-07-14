"""Unified book extraction: Gemini mega-pass → freemium LLM cascade.

Each book pins to the provider that served its first successful chunk so
characters/scenes stay consistent across chunks and re-ingests.
"""
from __future__ import annotations

import os
from typing import Any, Callable

from ..playback import library as L
from .freemium_extract import (
    MAX_CHUNK_TOKENS,
    chunk_text,
    freemium_extract,
    merge_analysis_dicts,
)
from .gemini import GeminiUnavailable, analyze_book, analysis_from_json
from .repair import repair_analysis
from .prompt import SYSTEM_INSTRUCTION, RULES, ILLUSTRATION_RULES, SCHEMA_HINT
from .schema import BookAnalysis

OnEvent = Callable[..., None]


class ExtractUnavailable(RuntimeError):
    """Raised when neither Gemini nor freemium extraction can complete."""

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


def _freemium_disabled() -> bool:
    return os.environ.get("DISABLE_FREEMIUM_EXTRACT", "").lower() in ("1", "true", "yes")


def build_system_prompt(*, has_reference_images: bool) -> str:
    ref = (
        "\nReference images may be attached in a separate Gemini pass; when absent, "
        "omit illustration_ref (null).\n" + ILLUSTRATION_RULES
        if has_reference_images
        else "\nNo reference images — omit illustration_ref (null).\n"
    )
    import json
    return (
        f"{SYSTEM_INSTRUCTION}\n\n"
        f"Return JSON exactly matching this shape (types shown):\n"
        f"{json.dumps(SCHEMA_HINT, indent=2)}\n"
        f"{RULES}{ref}\n"
        "Output a single valid JSON object only — no markdown, no commentary."
    )


def build_user_prompt(book_id: str, title: str, author: str, body_text: str,
                      *, chunk_index: int | None = None, chunk_total: int | None = None) -> str:
    chunk_note = ""
    if chunk_index is not None and chunk_total is not None and chunk_total > 1:
        chunk_note = (
            f"\nNOTE: This is chunk {chunk_index + 1} of {chunk_total}. "
            "Extract only what appears in this chunk; use stable character ids.\n"
        )
    return (
        f"book_id = {book_id!r}; title = {title!r}; author = {author!r}.{chunk_note}\n\n"
        f"BOOK TEXT START\n{body_text}\nBOOK TEXT END\n"
    )


def _freemium_extract_book(
    book_id: str,
    title: str,
    author: str,
    body_text: str,
    *,
    prefer_provider: str | None = None,
    has_reference_images: bool = False,
    on_event: OnEvent | None = None,
) -> tuple[BookAnalysis, dict[str, str]]:
    system = build_system_prompt(has_reference_images=has_reference_images)
    chunks = chunk_text(body_text)
    if not chunks:
        raise ExtractUnavailable("empty book text", code="empty_text")

    pin = prefer_provider
    partials: list[dict] = []
    used_model = ""

    for i, chunk in enumerate(chunks):
        user = build_user_prompt(
            book_id, title, author, chunk,
            chunk_index=i, chunk_total=len(chunks),
        )
        result = freemium_extract(
            user,
            system_prompt=system,
            prefer_provider=pin,
            on_event=on_event,
        )
        if not pin:
            pin = result["provider"]
            used_model = result["model"]
            _emit(on_event, "extract_pin_locked", provider=pin, model=used_model)
        elif not used_model:
            used_model = result["model"]
        partials.append(result["data"])

    merged = merge_analysis_dicts(partials)
    merged.setdefault("book_id", book_id)
    merged.setdefault("title", title)
    merged.setdefault("author", author)
    analysis = analysis_from_json(merged)
    return analysis, {"provider": pin or "unknown", "model": used_model}


def extract_book(
    book_id: str,
    title: str,
    author: str,
    body_text: str,
    reference_images: list[bytes] | None = None,
    model: str | None = None,
    on_event: OnEvent | None = None,
    *,
    prefer_provider: str | None = None,
) -> BookAnalysis:
    """Gemini mega-pass when possible; freemium cascade on quota failure.

    Reads/writes per-book extract_pin via library helpers so re-ingests and
  multi-chunk books stay on one provider.
    """
    stored = L.read_extract_pin(book_id)
    pin_provider = prefer_provider or (stored or {}).get("provider")
    pin_model = (stored or {}).get("model")

    # Non-Gemini pin → skip Gemini and go straight to freemium.
    use_gemini = (
        not _freemium_disabled()
        and pin_provider in (None, "gemini")
        and os.environ.get("EXTRACT_FORCE_FREEMIUM", "").lower() not in ("1", "true", "yes")
    )

    if use_gemini:
        try:
            analysis = analyze_book(
                book_id, title, author, body_text,
                reference_images=reference_images,
                model=model or pin_model,
                on_event=on_event,
            )
            used = model or pin_model or os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
            L.write_extract_pin(book_id, "gemini", used)
            return repair_analysis(analysis)
        except GeminiUnavailable as e:
            _emit(on_event, "gemini_text_exhausted",
                  quota=e.code == "quota_exhausted",
                  rate_limit=e.code == "rate_limited")
            if _freemium_disabled():
                raise ExtractUnavailable(str(e), code=e.code, cause=e) from e
            _emit(on_event, "freemium_extract_start")

    if _freemium_disabled():
        raise ExtractUnavailable(
            "Freemium extract disabled and Gemini unavailable",
            code="no_extract_backend",
        )

    try:
        analysis, pin = _freemium_extract_book(
            book_id, title, author, body_text,
            prefer_provider=pin_provider if pin_provider != "gemini" else None,
            has_reference_images=bool(reference_images),
            on_event=on_event,
        )
        L.write_extract_pin(book_id, pin["provider"], pin["model"])
        return repair_analysis(analysis)
    except Exception as e:
        raise ExtractUnavailable(
            f"all extract providers failed: {e}",
            code="all_providers_failed",
            cause=e,
        ) from e
