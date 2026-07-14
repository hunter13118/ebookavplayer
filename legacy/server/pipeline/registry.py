"""Central registry for AI pipeline stages — order, enable/disable, availability."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from ..images.freemium import BACKGROUND_CHAIN, CHARACTER_CHAIN
from ..images.model_lists import GEMINI_IMAGE_MODELS, GEMINI_TEXT_MODELS

DATA_DIR = Path(os.environ.get("DATA_DIR", "./data"))


def _config_path() -> Path:
    return Path(os.environ.get("DATA_DIR", "./data")) / "pipeline.json"

# ---- stage metadata (icon is a display glyph; frontend may map to SVG later) ----
STAGE_META: dict[str, dict[str, Any]] = {
    # extract providers
    "gemini": {
        "label": "Gemini",
        "icon": "✦",
        "tier": "primary",
        "lane": "extract",
        "requires": ["GEMINI_API_KEY"],
    },
    "cerebras": {
        "label": "Cerebras",
        "icon": "⚡",
        "tier": "freemium",
        "lane": "extract",
        "requires": ["CEREBRAS_API_KEY"],
        "model_env": "CEREBRAS_EXTRACT_MODEL",
        "default_model": "gpt-oss-120b",
    },
    "groq": {
        "label": "Groq",
        "icon": "🦙",
        "tier": "freemium",
        "lane": "extract",
        "requires": ["GROQ_API_KEY"],
        "default_model": "llama-3.3-70b-versatile",
    },
    "mistral": {
        "label": "Mistral",
        "icon": "🌬",
        "tier": "freemium",
        "lane": "extract",
        "requires": ["MISTRAL_API_KEY"],
        "default_model": "mistral-small-latest",
    },
    "openrouter": {
        "label": "OpenRouter",
        "icon": "🔀",
        "tier": "freemium",
        "lane": "extract",
        "requires": ["OPENROUTER_API_KEY"],
        "default_model": "meta-llama/llama-3.3-70b-instruct:free",
    },
    "cloudflare": {
        "label": "Workers AI",
        "icon": "☁",
        "tier": "freemium",
        "lane": "extract",
        "requires": ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
        "model_env": "CLOUDFLARE_EXTRACT_MODEL",
        "default_model": "@cf/meta/llama-3.1-8b-instruct",
        "note": "Late-chain fallback — shares 10k neurons/day with image FLUX",
    },
    # image tiers
    "gemini_image": {
        "label": "Gemini Image",
        "icon": "✦",
        "tier": "primary",
        "lane": "image",
        "requires": ["GEMINI_API_KEY"],
    },
    "freemium_image": {
        "label": "Freemium APIs",
        "icon": "🆓",
        "tier": "freemium",
        "lane": "image",
        "requires": [],
    },
    "local_sd": {
        "label": "Local SD",
        "icon": "🖥",
        "tier": "local",
        "lane": "image",
        "requires": [],
        "optional_env": ["LOCAL_IMAGE_URL"],
    },
    # freemium image providers
    "cloudflare": {
        "label": "Cloudflare",
        "icon": "☁",
        "tier": "freemium",
        "lane": "image_freemium",
        "requires": ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
    },
    "pollinations-anon": {
        "label": "Pollinations (free)",
        "icon": "🌸",
        "tier": "freemium",
        "lane": "image_freemium",
        "requires": [],
    },
    "pollinations-seed": {
        "label": "Pollinations (seed)",
        "icon": "🌺",
        "tier": "freemium",
        "lane": "image_freemium",
        "requires": ["POLLINATIONS_TOKEN"],
    },
    "huggingface": {
        "label": "Hugging Face",
        "icon": "🤗",
        "tier": "freemium",
        "lane": "image_freemium",
        "requires": ["HF_TOKEN"],
        "model_env": "HF_IMAGE_MODEL",
        "default_model": "black-forest-labs/FLUX.1-schnell",
    },
}


def _lane_default(lane: str) -> dict[str, list[str]]:
    defaults: dict[str, list[str]] = {
        "extract": ["gemini", "cerebras", "groq", "mistral", "openrouter", "cloudflare"],
        "image": ["gemini_image", "freemium_image", "local_sd"],
        "image_freemium_character": list(CHARACTER_CHAIN),
        "image_freemium_background": list(BACKGROUND_CHAIN),
        "gemini_text": list(GEMINI_TEXT_MODELS),
        "gemini_image_models": list(GEMINI_IMAGE_MODELS),
    }
    order = defaults.get(lane, [])
    return {"order": order, "disabled": []}


def default_config() -> dict[str, dict[str, list[str]]]:
    return {
        "extract": _lane_default("extract"),
        "image": _lane_default("image"),
        "image_freemium_character": _lane_default("image_freemium_character"),
        "image_freemium_background": _lane_default("image_freemium_background"),
        "gemini_text": _lane_default("gemini_text"),
        "gemini_image_models": _lane_default("gemini_image_models"),
    }


def _merge_lane(base: dict, override: dict | None) -> dict[str, list[str]]:
    if not override:
        return base
    out = dict(base)
    if isinstance(override.get("order"), list):
        # Keep unknown ids at end; drop duplicates.
        seen: set[str] = set()
        merged: list[str] = []
        for sid in override["order"]:
            if sid in seen:
                continue
            if sid in base["order"]:
                seen.add(sid)
                merged.append(sid)
        for sid in base["order"]:
            if sid not in seen:
                merged.append(sid)
        out["order"] = merged
    if isinstance(override.get("disabled"), list):
        out["disabled"] = [x for x in override["disabled"] if isinstance(x, str)]
    return out


def load_config() -> dict[str, dict[str, list[str]]]:
    base = default_config()
    if not _config_path().is_file():
        return base
    try:
        raw = json.loads(_config_path().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return base
    if not isinstance(raw, dict):
        return base
    for lane, lane_def in base.items():
        base[lane] = _merge_lane(lane_def, raw.get(lane))
    return base


def save_config(patch: dict[str, Any]) -> dict[str, dict[str, list[str]]]:
    cfg = load_config()
    for lane, body in (patch or {}).items():
        if lane not in cfg or not isinstance(body, dict):
            continue
        cfg[lane] = _merge_lane(cfg[lane], body)
    _config_path().parent.mkdir(parents=True, exist_ok=True)
    _config_path().write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    return cfg


def _env_present(key: str) -> bool:
    return bool((os.environ.get(key) or "").strip())


def stage_available(stage_id: str) -> bool:
    meta = STAGE_META.get(stage_id)
    if not meta:
        # gemini model ids (e.g. gemini-2.5-flash) need only GEMINI_API_KEY
        if stage_id.startswith("gemini"):
            return _env_present("GEMINI_API_KEY")
        return True
    for req in meta.get("requires") or []:
        if not _env_present(req):
            return False
    if stage_id == "freemium_image":
        if os.environ.get("DISABLE_FREEMIUM_IMAGE", "").lower() in ("1", "true", "yes"):
            return False
    return True


def resolved_order(lane: str, *, prefer: str | None = None) -> list[str]:
    """Enabled stage ids for a lane, in configured order."""
    cfg = load_config()
    lane_def = cfg.get(lane) or {"order": [], "disabled": []}
    disabled = set(lane_def.get("disabled") or [])
    order = [sid for sid in (lane_def.get("order") or []) if sid not in disabled]
    if prefer and prefer in order:
        return [prefer] + [p for p in order if p != prefer]
    return order


def resolved_gemini_text_models() -> list[str]:
    return resolved_order("gemini_text")


def resolved_gemini_image_models() -> list[str]:
    return resolved_order("gemini_image_models")


def resolved_extract_providers() -> list[str]:
    return resolved_order("extract")


def resolved_image_tiers() -> list[str]:
    return resolved_order("image")


def resolved_freemium_chain(subject_type: str, *, prefer_provider: str | None = None) -> list[str]:
    lane = "image_freemium_background" if subject_type == "background" else "image_freemium_character"
    return resolved_order(lane, prefer=prefer_provider)


def image_tier_allowed(tier_id: str) -> bool:
    return tier_id in resolved_image_tiers() and stage_available(tier_id)


def public_view() -> dict[str, Any]:
    """Full pipeline state for the settings UI."""
    cfg = load_config()
    lanes: dict[str, Any] = {}
    for lane, lane_def in cfg.items():
        items = []
        for sid in lane_def.get("order") or []:
            meta = dict(STAGE_META.get(sid) or {})
            if not meta:
                meta = {
                    "label": sid,
                    "icon": "◇",
                    "tier": "model",
                    "lane": lane,
                }
            model = None
            if meta.get("model_env"):
                model = os.environ.get(meta["model_env"]) or meta.get("default_model")
            elif meta.get("default_model"):
                model = meta["default_model"]
            items.append({
                "id": sid,
                "label": meta.get("label", sid),
                "icon": meta.get("icon", "◇"),
                "tier": meta.get("tier", "model"),
                "enabled": sid not in set(lane_def.get("disabled") or []),
                "available": stage_available(sid),
                "model": model,
            })
        lanes[lane] = {
            "title": _lane_title(lane),
            "items": items,
        }
    return {"lanes": lanes, "config": cfg}


def _lane_title(lane: str) -> str:
    titles = {
        "extract": "Text extraction",
        "image": "Image generation tiers",
        "image_freemium_character": "Character sprites (freemium)",
        "image_freemium_background": "Backgrounds (freemium)",
        "gemini_text": "Gemini text models",
        "gemini_image_models": "Gemini image models",
    }
    return titles.get(lane, lane)
