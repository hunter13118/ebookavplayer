"""Free card-free image API cascade (port of IMAGE AND VOICE HANDOFF/freemiumImageGen.js).

Provider order is subject-aware; do not reorder without reading HANDOFF/DESIGN.
"""
from __future__ import annotations

import base64
import logging
import os
from typing import Any

import requests

log = logging.getLogger(__name__)

PER_PROVIDER_TIMEOUT_SEC = 30

SUBJECT_FRAMING = {
    "character": {
        "pre": (
            "Full-body character sprite, single character, centered composition, "
            "clean readable silhouette, front-facing or 3/4 view,"
        ),
        "post": (
            "isolated on a plain flat background, even lighting, no scenery, "
            "consistent line weight, game-asset ready."
        ),
    },
    "background": {
        "pre": (
            "Wide establishing background scene, environment art, no characters, "
            "no people, strong sense of depth and atmosphere,"
        ),
        "post": (
            "full scene fills the frame, layered foreground/midground/background, "
            "usable as a game backdrop layer."
        ),
    },
}

STYLE_TEMPLATES = {
    "realistic": (
        "photorealistic, highly detailed, realistic proportions, "
        "natural lighting and shading, lifelike textures"
    ),
    "anime": (
        "anime art style, cel-shaded, clean bold outlines, vibrant flat colors, "
        "expressive features, in the style of modern Japanese animation"
    ),
    "pixel": (
        "pixel art, crisp pixel grid, limited palette, dithered shading, "
        "retro 16-bit game aesthetic, sharp edges (no anti-aliasing)"
    ),
    "comic": (
        "comic book / cartoon style, bold inked outlines, flat cel coloring, "
        "dynamic stylized shapes, halftone-friendly shading"
    ),
    "neutral": "clean digital illustration, balanced colors, clear detail",
}

CHARACTER_CHAIN = [
    "cloudflare",
    "pollinations-seed",
    "huggingface",
    "pollinations-anon",
]
BACKGROUND_CHAIN = [
    "cloudflare",
    "pollinations-seed",
    "pollinations-anon",
    "huggingface",
]


def art_style_to_freemium(art_style: str) -> str:
    """Map app upload styles → freemium style keys."""
    s = (art_style or "").lower()
    if s in ("semi-real", "semi_real", "realistic", "real"):
        return "realistic"
    if s == "anime":
        return "anime"
    if s == "pixel":
        return "pixel"
    if s in ("cartoon", "comic"):
        return "comic"
    return "neutral"


def normalize_style(style: str | None) -> str:
    if not isinstance(style, str):
        return "neutral"
    s = style.lower()
    if "real" in s or "photo" in s:
        return "realistic"
    if "anime" in s or "cel" in s:
        return "anime"
    if "pixel" in s:
        return "pixel"
    if "comic" in s or "cartoon" in s:
        return "comic"
    return "neutral"


def normalize_subject(subject_type: str | None) -> str:
    return "background" if subject_type == "background" else "character"


def compose_prompt(description: str, *, subject_type: str = "character",
                   style: str = "neutral") -> str:
    subj = normalize_subject(subject_type)
    style_key = normalize_style(style)
    framing = SUBJECT_FRAMING[subj]
    style_desc = STYLE_TEMPLATES[style_key]
    desc = " ".join(description.strip().split())
    return (
        f"{framing['pre']} {desc} {framing['post']} Art style: {style_desc}."
    )


def build_chain(subject_type: str, prefer_provider: str | None = None) -> list[str]:
    base = BACKGROUND_CHAIN if subject_type == "background" else CHARACTER_CHAIN
    if prefer_provider and prefer_provider in _PROVIDER_IDS:
        return [prefer_provider] + [p for p in base if p != prefer_provider]
    return list(base)


def _cfg() -> dict[str, str | None]:
    return {
        "cloudflare_account_id": os.environ.get("CLOUDFLARE_ACCOUNT_ID"),
        "cloudflare_token": os.environ.get("CLOUDFLARE_API_TOKEN"),
        "pollinations_token": os.environ.get("POLLINATIONS_TOKEN"),
        "hf_token": os.environ.get("HF_TOKEN"),
    }


def _try_cloudflare(prompt: str, seed: int | None, cfg: dict) -> dict[str, Any]:
    acct, token = cfg.get("cloudflare_account_id"), cfg.get("cloudflare_token")
    if not acct or not token:
        raise RuntimeError("Cloudflare: missing account id or token (skipped)")
    model = "@cf/black-forest-labs/flux-1-schnell"
    url = f"https://api.cloudflare.com/client/v4/accounts/{acct}/ai/run/{model}"
    body: dict[str, Any] = {"prompt": prompt}
    if isinstance(seed, int):
        body["seed"] = seed
    r = requests.post(
        url,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json=body,
        timeout=PER_PROVIDER_TIMEOUT_SEC,
    )
    if not r.ok:
        raise RuntimeError(f"Cloudflare: HTTP {r.status_code} {r.text[:200]}")
    data = r.json()
    b64 = (data.get("result") or {}).get("image")
    if not b64:
        raise RuntimeError("Cloudflare: no image field in response")
    return {
        "provider": "cloudflare",
        "model": "flux-1-schnell",
        "bytes": base64.b64decode(b64),
        "content_type": "image/jpeg",
    }


def _try_pollinations_seed(prompt: str, seed: int | None, cfg: dict) -> dict[str, Any]:
    token = cfg.get("pollinations_token")
    if not token:
        raise RuntimeError("Pollinations(Seed): missing token (skipped)")
    url = (
        f"https://gen.pollinations.ai/image/{requests.utils.quote(prompt)}"
        f"?model=flux&token={requests.utils.quote(token)}"
    )
    if isinstance(seed, int):
        url += f"&seed={seed}"
    r = requests.get(url, timeout=PER_PROVIDER_TIMEOUT_SEC)
    if not r.ok:
        raise RuntimeError(f"Pollinations(Seed): HTTP {r.status_code} {r.text[:200]}")
    ct = r.headers.get("content-type", "image/jpeg")
    if not ct.startswith("image/"):
        raise RuntimeError(f"Pollinations(Seed): unexpected content-type {ct}")
    return {
        "provider": "pollinations-seed",
        "model": "flux",
        "bytes": r.content,
        "content_type": ct,
    }


def _try_pollinations_anon(prompt: str, seed: int | None, _cfg: dict) -> dict[str, Any]:
    url = f"https://gen.pollinations.ai/image/{requests.utils.quote(prompt)}?model=flux"
    if isinstance(seed, int):
        url += f"&seed={seed}"
    r = requests.get(url, timeout=PER_PROVIDER_TIMEOUT_SEC)
    if not r.ok:
        raise RuntimeError(f"Pollinations(Anon): HTTP {r.status_code} {r.text[:200]}")
    ct = r.headers.get("content-type", "image/jpeg")
    if not ct.startswith("image/"):
        raise RuntimeError(f"Pollinations(Anon): unexpected content-type {ct}")
    return {
        "provider": "pollinations-anon",
        "model": "flux",
        "bytes": r.content,
        "content_type": ct,
    }


def _try_huggingface(prompt: str, seed: int | None, cfg: dict) -> dict[str, Any]:
    token = cfg.get("hf_token")
    if not token:
        raise RuntimeError("HuggingFace: missing token (skipped)")
    model = "black-forest-labs/FLUX.1-dev"
    url = f"https://router.huggingface.co/hf-inference/models/{model}"
    payload: dict[str, Any] = {"inputs": prompt}
    if isinstance(seed, int):
        payload["parameters"] = {"seed": seed}
    r = requests.post(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "image/png",
        },
        json=payload,
        timeout=PER_PROVIDER_TIMEOUT_SEC,
    )
    if not r.ok:
        raise RuntimeError(f"HuggingFace: HTTP {r.status_code} {r.text[:200]}")
    ct = r.headers.get("content-type", "image/png")
    if not ct.startswith("image/"):
        raise RuntimeError(f"HuggingFace: unexpected content-type {ct}")
    return {
        "provider": "huggingface",
        "model": "FLUX.1-dev",
        "bytes": r.content,
        "content_type": ct,
    }


_PROVIDER_FUNCS = {
    "cloudflare": _try_cloudflare,
    "pollinations-seed": _try_pollinations_seed,
    "pollinations-anon": _try_pollinations_anon,
    "huggingface": _try_huggingface,
}
_PROVIDER_IDS = set(_PROVIDER_FUNCS)


def freemium_image_gen(
    description: str,
    *,
    subject_type: str = "character",
    style: str = "neutral",
    seed: int | None = None,
    prefer_provider: str | None = None,
) -> dict[str, Any]:
    """Try free providers in subject-appropriate order; return first success."""
    if not (description or "").strip():
        raise ValueError("freemium_image_gen: description must be non-empty")
    subj = normalize_subject(subject_type)
    style_key = normalize_style(style)
    prompt = compose_prompt(description, subject_type=subj, style=style_key)
    chain = build_chain(subj, prefer_provider)
    cfg = _cfg()
    failures: list[Exception] = []
    for pid in chain:
        fn = _PROVIDER_FUNCS[pid]
        try:
            result = fn(prompt, seed, cfg)
            log.info(
                "freemium image via %s (%s) subject=%s style=%s seed=%s",
                result["provider"], result["model"], subj, style_key, seed,
            )
            return {
                **result,
                "prompt": prompt,
                "subject_type": subj,
                "style": style_key,
                "seed": seed,
            }
        except Exception as e:
            log.warning("freemium %s: %s", pid, e)
            failures.append(e)
    raise RuntimeError(
        f"freemium_image_gen: all providers failed ({len(failures)} errors)"
    ) from (failures[0] if failures else None)
