"""Image generation: Gemini cascade → freemium APIs → local War Council SD."""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Callable

from ..analyze.gemini_errors import call_with_rate_limit_retry, is_rate_limit_error
from .freemium import art_style_to_freemium, compose_prompt, freemium_image_gen
from ..pipeline.registry import resolved_gemini_image_models, image_tier_allowed

log = logging.getLogger(__name__)

OnEvent = Callable[..., None]


def _emit(on_event: OnEvent | None, event: str, **data: Any) -> None:
    if not on_event:
        return
    try:
        on_event(event, **data)
    except TypeError:
        on_event(event)  # type: ignore[misc]


def _save_gemini_response(resp, out_path: str) -> bool:
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    parts = resp.candidates[0].content.parts if resp.candidates else []
    for part in parts:
        inline = getattr(part, "inline_data", None)
        if inline and getattr(inline, "data", None):
            Path(out_path).write_bytes(inline.data)
            return True
        as_img = getattr(part, "as_image", None)
        if callable(as_img):
            img = as_img()
            if img is not None:
                img.save(out_path)
                return True
    return False


def _try_gemini(
    prompt: str,
    reference_images: list[bytes] | None,
    out_path: str,
    *,
    on_event: OnEvent | None = None,
) -> bool:
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return False
    try:
        from google import genai
        from google.genai import types
    except ImportError:
        return False

    client = genai.Client(api_key=api_key)
    parts: list = [prompt]
    for img in (reference_images or [])[:3]:
        parts.append(types.Part.from_bytes(data=img, mime_type="image/jpeg"))

    models = resolved_gemini_image_models()
    for i, model in enumerate(models):
        try:
            def _call(m=model):
                return client.models.generate_content(model=m, contents=parts)

            resp = call_with_rate_limit_retry(_call)
            if _save_gemini_response(resp, out_path):
                log.info("image via Gemini %s → %s", model, out_path)
                return True
            log.warning("Gemini image %s returned no image bytes", model)
        except Exception as e:
            log.warning("Gemini image %s failed: %s", model, e)
            if is_rate_limit_error(e) and i < len(models) - 1:
                _emit(on_event, "gemini_fallback", from_model=model, to_model=models[i + 1])
                continue
        if i < len(models) - 1:
            _emit(on_event, "gemini_fallback", from_model=model, to_model=models[i + 1])

    _emit(on_event, "gemini_exhausted")
    return False


def _try_freemium(
    description: str,
    out_path: str,
    *,
    subject_type: str,
    art_style: str,
    seed: int | None = None,
    prefer_provider: str | None = None,
    on_event: OnEvent | None = None,
) -> dict[str, Any] | None:
    if os.environ.get("DISABLE_FREEMIUM_IMAGE", "").lower() in ("1", "true", "yes"):
        return None
    _emit(on_event, "freemium_start")
    style = art_style_to_freemium(art_style)
    try:
        result = freemium_image_gen(
            description,
            subject_type=subject_type,
            style=style,
            seed=seed,
            prefer_provider=prefer_provider,
        )
    except Exception as e:
        log.warning("freemium chain failed: %s", e)
        _emit(on_event, "freemium_exhausted")
        return None

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    Path(out_path).write_bytes(result["bytes"])
    log.info("image via freemium %s → %s", result["provider"], out_path)
    _emit(on_event, "freemium_ok", provider=result["provider"])
    return {
        "provider": result["provider"],
        "model": result["model"],
        "seed": result.get("seed"),
        "prompt": result.get("prompt"),
    }


def _try_local_http(
    prompt: str,
    out_path: str,
    *,
    kind: str = "character",
    on_event: OnEvent | None = None,
) -> bool:
    url = os.environ.get("LOCAL_IMAGE_URL", "http://127.0.0.1:3737/images/generate")
    if not url:
        return False
    _emit(on_event, "local_sd_start")
    try:
        import requests
    except ImportError:
        return False

    w, h = (1024, 576) if kind == "background" else (512, 768)
    if kind == "cover":
        w, h = 512, 768
    try:
        r = requests.post(
            url,
            json={"prompt": prompt, "width": w, "height": h, "out_hint": out_path},
            timeout=(
                int(os.environ.get("LOCAL_IMAGE_CONNECT_TIMEOUT", "8")),
                int(os.environ.get("LOCAL_IMAGE_TIMEOUT", "120")),
            ),
        )
        if r.status_code != 200:
            log.warning("local image HTTP %s: %s", r.status_code, r.text[:200])
            return False
        ct = r.headers.get("content-type", "")
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        if "image" in ct or r.content[:4] == b"\x89PNG":
            Path(out_path).write_bytes(r.content)
            log.info("image via local HTTP → %s", out_path)
            return True
        data = r.json()
        if data.get("path") and Path(data["path"]).is_file():
            Path(out_path).write_bytes(Path(data["path"]).read_bytes())
            return True
    except Exception as e:
        log.warning("local image HTTP failed: %s", e)
    return False


def generate_image(
    description: str,
    out_path: str,
    *,
    reference_images: list[bytes] | None = None,
    subject_type: str = "character",
    art_style: str = "semi-real",
    kind: str = "character",
    allow_gemini: bool = True,
    allow_freemium: bool = True,
    allow_local: bool = True,
    seed: int | None = None,
    prefer_provider: str | None = None,
    on_event: OnEvent | None = None,
) -> tuple[bool, dict[str, Any]]:
    """Returns (success, metadata) — metadata may include provider/seed for pinning."""
    meta: dict[str, Any] = {}
    style_key = art_style_to_freemium(art_style)
    composed = compose_prompt(description, subject_type=subject_type, style=style_key)

    for tier in _image_tier_order():
        if tier == "gemini_image" and allow_gemini and image_tier_allowed("gemini_image"):
            if _try_gemini(composed, reference_images, out_path, on_event=on_event):
                meta["backend"] = "gemini"
                return True, meta
        elif tier == "freemium_image" and allow_freemium and image_tier_allowed("freemium_image"):
            fm = _try_freemium(
                description, out_path,
                subject_type=subject_type,
                art_style=art_style,
                seed=seed,
                prefer_provider=prefer_provider,
                on_event=on_event,
            )
            if fm:
                meta.update(fm)
                meta["backend"] = "freemium"
                return True, meta
        elif tier == "local_sd" and allow_local and image_tier_allowed("local_sd"):
            if _try_local_http(composed, out_path, kind=kind, on_event=on_event):
                meta["backend"] = "local_sd"
                return True, meta

    _emit(on_event, "image_failed", kind=kind)
    return False, meta


def _image_tier_order() -> list[str]:
    try:
        from ..pipeline.registry import resolved_image_tiers
        order = resolved_image_tiers()
        if order:
            return order
    except Exception:
        pass
    return ["gemini_image", "freemium_image", "local_sd"]
