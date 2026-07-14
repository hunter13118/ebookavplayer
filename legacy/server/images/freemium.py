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

# Hugging Face Inference Providers (hf-inference router).
HF_IMAGE_MODEL = os.environ.get(
    "HF_IMAGE_MODEL", "black-forest-labs/FLUX.1-schnell"
)

# Pollinations: authed sk_ spends pollen; unauthenticated `flux` is the 0-pollen tier
# (rate-limited). zimage/flux with Bearer cost ~0.002/0.0018 pollen per image.
POLLINATIONS_IMAGE_MODEL = os.environ.get("POLLINATIONS_IMAGE_MODEL", "flux")
POLLINATIONS_FREE_MODEL = os.environ.get("POLLINATIONS_FREE_MODEL", "flux")

SUBJECT_FRAMING = {
    "character": {
        "pre": (
            "Portrait bust character sprite, head and shoulders, large readable face, "
            "centered composition, expressive eyes and hair, front-facing or 3/4 view,"
        ),
        "post_transparent": (
            "character cutout on a fully transparent background (alpha channel), "
            "no backdrop, no floor shadow, no scenery, even lighting, "
            "face and hair fill most of the frame, thumbnail-friendly, "
            "visual novel dialogue portrait ready."
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
        "blatant low-budget isekai anime screenshot, trash-tier harem anime aesthetic, "
        "oversized sparkly eyes, exaggerated cel-shading, cheap TV anime coloring, "
        "fan-service adjacent character design, obvious Japanese animation tropes"
    ),
    "pixel": (
        "Stardew Valley style pixel art RPG portrait, chunky readable pixels, "
        "warm limited palette, cozy farm-sim character sprite, distinct silhouette, "
        "16-bit game portrait, sharp pixel grid (no anti-aliasing)"
    ),
    "comic": (
        "Adventure Time style cheap cartoon, thin noodly limbs, flat bold colors, "
        "minimal detail, goofy simplified shapes, thick black outlines, "
        "low-budget TV animation aesthetic"
    ),
    "neutral": "clean digital illustration, balanced colors, clear detail",
}

CHARACTER_CHAIN = [
    "pollinations-anon",
    "pollinations-seed",
    "huggingface",
    "cloudflare",
]
BACKGROUND_CHAIN = [
    "pollinations-anon",
    "pollinations-seed",
    "huggingface",
    "cloudflare",
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
                   style: str = "neutral",
                   sprite_background: str | None = None) -> str:
    subj = normalize_subject(subject_type)
    style_key = normalize_style(style)
    framing = SUBJECT_FRAMING[subj]
    style_desc = STYLE_TEMPLATES[style_key]
    desc = " ".join(description.strip().split())
    if subj == "character":
        if sprite_background and sprite_background.strip():
            post = (
                f"isolated on {sprite_background.strip()}, even lighting, no scenery, "
                "consistent line weight, game-asset ready."
            )
        else:
            post = framing["post_transparent"]
    else:
        post = framing["post"]
    return (
        f"{framing['pre']} {desc} {post} Art style: {style_desc}."
    )


def build_chain(subject_type: str, prefer_provider: str | None = None) -> list[str]:
    try:
        from ..pipeline.registry import resolved_freemium_chain
        base = resolved_freemium_chain(subject_type)
        if prefer_provider:
            if prefer_provider in base:
                return [prefer_provider] + [p for p in base if p != prefer_provider]
            return [prefer_provider] + [p for p in base if p != prefer_provider]
        if base:
            return base
    except Exception:
        pass
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


def _pollinations_url(
    prompt: str,
    seed: int | None,
    model: str,
    *,
    image_format: str | None = None,
) -> str:
    url = (
        f"https://gen.pollinations.ai/image/{requests.utils.quote(prompt)}"
        f"?model={requests.utils.quote(model)}"
    )
    if isinstance(seed, int):
        url += f"&seed={seed}"
    if image_format:
        url += f"&format={requests.utils.quote(image_format)}"
    return url


def _pollinations_get(
    prompt: str,
    seed: int | None,
    *,
    model: str,
    token: str | None,
    image_format: str | None = None,
) -> requests.Response:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return requests.get(
        _pollinations_url(prompt, seed, model, image_format=image_format),
        headers=headers,
        timeout=PER_PROVIDER_TIMEOUT_SEC,
    )


def _parse_pollinations_response(
    r: requests.Response,
    *,
    provider: str,
    model: str,
    label: str,
) -> dict[str, Any]:
    if not r.ok:
        raise RuntimeError(f"Pollinations({label}): HTTP {r.status_code} {r.text[:200]}")
    ct = r.headers.get("content-type", "image/jpeg")
    if not ct.startswith("image/"):
        raise RuntimeError(f"Pollinations({label}): unexpected content-type {ct}")
    return {
        "provider": provider,
        "model": model,
        "bytes": r.content,
        "content_type": ct,
    }


def _pollinations_with_free_fallback(
    prompt: str,
    seed: int | None,
    cfg: dict,
    *,
    provider_id: str,
    label: str,
    start_authed: bool,
) -> dict[str, Any]:
    """Prefer 0-pollen unauthenticated flux; authed sk_ spends pollen unless balance is 0."""
    token = cfg.get("pollinations_token")
    image_format = cfg.get("pollinations_format")

    if start_authed:
        if not token:
            raise RuntimeError(f"Pollinations({label}): missing API key (skipped)")
        r = _pollinations_get(
            prompt, seed, model=POLLINATIONS_IMAGE_MODEL, token=token,
            image_format=image_format,
        )
        if r.ok:
            return _parse_pollinations_response(
                r, provider=provider_id, model=POLLINATIONS_IMAGE_MODEL, label=label,
            )
        if r.status_code != 402:
            raise RuntimeError(f"Pollinations({label}): HTTP {r.status_code} {r.text[:200]}")
        log.info(
            "Pollinations(%s): zero pollen on %s — using free %s (no auth)",
            label, POLLINATIONS_IMAGE_MODEL, POLLINATIONS_FREE_MODEL,
        )

    r = _pollinations_get(
        prompt, seed, model=POLLINATIONS_FREE_MODEL, token=None,
        image_format=image_format,
    )
    if r.ok:
        return _parse_pollinations_response(
            r,
            provider=provider_id,
            model=f"{POLLINATIONS_FREE_MODEL}-free",
            label=label,
        )

    # Some endpoints reject no-auth (401); retry authed path if we have a key.
    if r.status_code == 401 and token and not start_authed:
        return _pollinations_with_free_fallback(
            prompt, seed, cfg,
            provider_id=provider_id,
            label=label,
            start_authed=True,
        )

    return _parse_pollinations_response(
        r,
        provider=provider_id,
        model=f"{POLLINATIONS_FREE_MODEL}-free",
        label=label,
    )


def _try_pollinations_seed(prompt: str, seed: int | None, cfg: dict) -> dict[str, Any]:
    return _pollinations_with_free_fallback(
        prompt, seed, cfg,
        provider_id="pollinations-seed",
        label="Seed",
        start_authed=True,
    )


def _try_pollinations_anon(prompt: str, seed: int | None, cfg: dict) -> dict[str, Any]:
    return _pollinations_with_free_fallback(
        prompt, seed, cfg,
        provider_id="pollinations-anon",
        label="Anon",
        start_authed=False,
    )


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


def _try_huggingface(prompt: str, seed: int | None, cfg: dict) -> dict[str, Any]:
    token = cfg.get("hf_token")
    if not token:
        raise RuntimeError("HuggingFace: missing token (skipped)")
    model = HF_IMAGE_MODEL
    url = f"https://router.huggingface.co/hf-inference/models/{model}"
    payload: dict[str, Any] = {
        "inputs": prompt,
        "parameters": {"num_inference_steps": 4},
    }
    if isinstance(seed, int):
        payload["parameters"]["seed"] = seed
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
        "model": model,
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


def _maybe_purge_sprite_background(result: dict[str, Any]) -> dict[str, Any]:
    """Post-process character sprites: edge-detected backdrop → alpha PNG."""
    from .white_key import maybe_purge_sprite_background

    tol = int(os.environ.get("SPRITE_BG_PURGE_TOLERANCE", "22"))
    soft = int(os.environ.get("SPRITE_BG_PURGE_SOFTNESS", "12"))
    min_dom = float(os.environ.get("SPRITE_BG_PURGE_MIN_EDGE_DOMINANCE", "0.35"))
    try:
        purged = maybe_purge_sprite_background(
            result["bytes"],
            result.get("content_type"),
            tolerance=tol,
            softness=soft,
            min_edge_dominance=min_dom,
        )
        if purged is None:
            return result
        png_bytes, meta = purged
        return {
            **result,
            "bytes": png_bytes,
            "content_type": "image/png",
            "background_purged": True,
            "background_purge": meta,
        }
    except Exception as e:
        log.warning("background purge failed (%s); keeping original bytes", e)
        return result


def freemium_image_gen(
    description: str,
    *,
    subject_type: str = "character",
    style: str = "neutral",
    seed: int | None = None,
    prefer_provider: str | None = None,
    sprite_background: str | None = None,
) -> dict[str, Any]:
    """Try free providers in subject-appropriate order; return first success."""
    if not (description or "").strip():
        raise ValueError("freemium_image_gen: description must be non-empty")
    subj = normalize_subject(subject_type)
    style_key = normalize_style(style)
    prompt = compose_prompt(
        description,
        subject_type=subj,
        style=style_key,
        sprite_background=sprite_background,
    )
    chain = build_chain(subj, prefer_provider)
    cfg = _cfg()
    if subj == "character" and not (sprite_background and sprite_background.strip()):
        cfg = {**cfg, "pollinations_format": "png"}
    want_bg_purge = subj == "character" and not (sprite_background and sprite_background.strip())
    failures: list[Exception] = []
    for pid in chain:
        fn = _PROVIDER_FUNCS[pid]
        try:
            result = fn(prompt, seed, cfg)
            if want_bg_purge:
                result = _maybe_purge_sprite_background(result)
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
