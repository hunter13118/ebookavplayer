"""User-visible banner notifications for the image pipeline."""
from __future__ import annotations

import time
import uuid

from ..playback import library as L

# Dedupe window: same code won't spam within this many seconds.
_DEDUPE_SEC = 45
_MAX_BANNERS = 40


def push_banner(book_id: str, level: str, code: str, message: str) -> None:
    """Append a banner to the book status (info | warn | error)."""
    status = L.read_status(book_id) or {}
    banners: list[dict] = list(status.get("banners") or [])
    now = time.time()
    for b in banners[-8:]:
        if b.get("code") == code and now - float(b.get("ts", 0)) < _DEDUPE_SEC:
            return
    banners.append({
        "id": uuid.uuid4().hex[:12],
        "level": level,
        "code": code,
        "message": message,
        "ts": now,
    })
    L.write_status(book_id, banners=banners[-_MAX_BANNERS:])


def read_banners(book_id: str) -> list[dict]:
    status = L.read_status(book_id) or {}
    return list(status.get("banners") or [])


def clear_banners(book_id: str) -> None:
    L.write_status(book_id, banners=[])


def push_analysis_event(book_id: str, event: str, **data) -> None:
    """User-facing banners for the Gemini text mega-pass."""
    if event == "gemini_text_retry":
        wait = float(data.get("wait_sec", 3))
        push_banner(
            book_id, "info", "gemini_text_retry",
            f"Gemini rate limited — retrying in {wait:.0f}s…",
        )
    elif event == "gemini_text_fallback":
        frm = data.get("from_model", "model")
        to = data.get("to_model", "next model")
        push_banner(
            book_id, "info", "gemini_text_fallback",
            f"Gemini text model {frm} unavailable — trying {to}.",
        )
    elif event == "gemini_text_exhausted":
        if data.get("quota"):
            push_banner(
                book_id, "error", "gemini_text_exhausted",
                "Gemini text quota exhausted. Enable billing in AI Studio, wait for "
                "reset, or use Extract-only to preview without analysis quota.",
            )
        elif data.get("rate_limit"):
            push_banner(
                book_id, "error", "gemini_text_rate_limited",
                "Gemini text rate limit hit on all models. Wait a minute and retry, "
                "or use Extract-only while limits cool down.",
            )
        else:
            push_banner(
                book_id, "error", "gemini_text_failed",
                "Gemini text analysis failed on all models. Check GEMINI_API_KEY and "
                "model names, or use Extract-only.",
            )
    elif event == "freemium_extract_start":
        push_banner(
            book_id, "info", "freemium_extract",
            "Gemini unavailable — trying free LLM APIs for text extraction "
            "(Cerebras / Groq / Mistral / OpenRouter).",
        )
    elif event == "extract_pin_locked":
        prov = data.get("provider", "provider")
        push_banner(
            book_id, "info", "extract_pin_locked",
            f"Locked this book to {prov} for consistent extraction across chunks.",
        )
    elif event == "freemium_extract_exhausted":
        push_banner(
            book_id, "error", "freemium_extract_exhausted",
            "All free extract APIs failed. Add API keys (see .env.example) or retry "
            "after Gemini quota resets.",
        )


class ImagingBannerSink:
    """Collect backend events into a small set of user-facing banners."""

    def __init__(self, book_id: str):
        self.book_id = book_id
        self._local_announced = False
        self._gemini_exhausted = False
        self.failed_images = 0

    def __call__(self, event: str, **data) -> None:
        bid = self.book_id
        if event == "gemini_fallback":
            frm = data.get("from_model", "model")
            to = data.get("to_model", "next model")
            push_banner(
                bid, "info", "gemini_image_fallback",
                f"Gemini image model {frm} unavailable — trying {to}.",
            )
        elif event == "gemini_exhausted" and not self._gemini_exhausted:
            self._gemini_exhausted = True
            push_banner(
                bid, "warn", "gemini_image_exhausted",
                "Gemini image quota/rate limit hit — trying free APIs "
                "(Cloudflare / Pollinations).",
            )
        elif event == "freemium_start" and not getattr(self, "_freemium_announced", False):
            self._freemium_announced = True
            push_banner(
                bid, "info", "freemium_image",
                "Generating art via free image APIs (Cloudflare / Pollinations / Hugging Face).",
            )
        elif event == "freemium_ok":
            prov = data.get("provider", "free API")
            push_banner(
                bid, "info", "freemium_image_ok",
                f"Art generated via {prov}.",
            )
        elif event == "freemium_exhausted":
            push_banner(
                bid, "warn", "freemium_image_exhausted",
                "Free image APIs unavailable — trying local SD (War Council).",
            )
        elif event == "local_sd_start" and not self._local_announced:
            self._local_announced = True
            push_banner(
                bid, "info", "local_sd",
                "Generating art via local SD on your PC (War Council).",
            )
        elif event == "image_failed":
            self.failed_images += 1
        elif event == "imaging_complete_fail":
            n = int(data.get("failed", self.failed_images))
            push_banner(
                bid, "error", "imaging_failed",
                f"Image generation failed for {n} asset(s). "
                "Upload your own art or check Gemini quota / War Council.",
            )
        elif event == "imaging_zero":
            push_banner(
                bid, "error", "imaging_zero",
                "No images were generated. Upload art manually, enable billing for "
                "Gemini images, or start War Council local SD.",
            )
