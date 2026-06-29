"""Multi art-style media manifest (ART_STYLES.md P1–P5)."""
from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

KNOWN_ART_STYLES = ("semi-real", "anime", "cartoon", "pixel")

_STYLE_LABELS = {
    "semi-real": "Semi-realistic",
    "anime": "Anime",
    "cartoon": "Cartoon",
    "pixel": "Pixel-art",
}


def normalize_style_id(style: str) -> str:
    s = (style or "semi-real").lower().strip()
    if s in KNOWN_ART_STYLES:
        return s
    if s in ("semi_real", "semireal", "realistic"):
        return "semi-real"
    if s == "comic":
        return "cartoon"
    return s


def _empty_style_slot() -> dict[str, Any]:
    return {
        "characters": {},
        "backgrounds": {},
        "cover": None,
        "complete": False,
        "image_pins": {},
    }


def ensure_manifest(media: dict | None, *, default_active: str = "semi-real") -> dict:
    """Migrate flat legacy media.json → style-namespaced manifest."""
    media = dict(media or {})
    if "styles" in media:
        media.setdefault("active", normalize_style_id(media.get("active") or default_active))
        media.setdefault("styles", {})
        return media

    active = normalize_style_id(default_active)
    chars = dict(media.get("characters") or {})
    bgs = dict(media.get("backgrounds") or {})
    cover = media.get("cover")
    pins = dict(media.get("image_pins") or {})
    has_assets = bool(chars or bgs or cover)
    return {
        "active": active,
        "styles": {
            active: {
                "characters": chars,
                "backgrounds": bgs,
                "cover": cover,
                "complete": has_assets,
                "image_pins": pins,
            },
        },
    }


def active_style(media: dict | None, *, fallback: str = "semi-real") -> str:
    m = ensure_manifest(media, default_active=fallback)
    return normalize_style_id(m.get("active") or fallback)


def _style_slot(media: dict, style: str) -> dict[str, Any]:
    m = ensure_manifest(media)
    style = normalize_style_id(style)
    slot = m.setdefault("styles", {}).setdefault(style, _empty_style_slot())
    slot.setdefault("characters", {})
    slot.setdefault("backgrounds", {})
    slot.setdefault("image_pins", {})
    return slot


def is_filter_style(slot: dict | None) -> bool:
    return bool(slot and slot.get("mode") == "filter")


def style_has_assets(slot: dict | None) -> bool:
    if not slot or is_filter_style(slot):
        return False
    return bool(slot.get("characters") or slot.get("backgrounds") or slot.get("cover"))


def first_ready_style(media: dict, *, exclude: tuple[str, ...] = ()) -> str | None:
    m = ensure_manifest(media)
    for sid in KNOWN_ART_STYLES:
        if sid in exclude:
            continue
        if style_has_assets(m["styles"].get(sid)):
            return sid
    return None


def flat_media_from_slot(slot: dict | None) -> dict:
    if not slot or is_filter_style(slot):
        return {"characters": {}, "backgrounds": {}, "cover": None}
    return {
        "characters": dict(slot.get("characters") or {}),
        "backgrounds": dict(slot.get("backgrounds") or {}),
        "expressions": dict(slot.get("expressions") or {}),
        "inserts": dict(slot.get("inserts") or {}),
        "cover": slot.get("cover"),
    }


def resolve_compile_media(
    media: dict | None,
    *,
    fallback_active: str = "semi-real",
) -> tuple[dict, str, str | None]:
    """Return (flat_media, display_art_style, art_filter).

    When pixel filter mode is active, flat_media comes from filter_source and
    art_filter is 'pixel'.
    """
    m = ensure_manifest(media, default_active=fallback_active)
    active = active_style(m, fallback=fallback_active)
    slot = m.get("styles", {}).get(active) or {}

    if active == "pixel" and is_filter_style(slot):
        source = normalize_style_id(
            slot.get("filter_source") or first_ready_style(m, exclude=("pixel",)) or "semi-real",
        )
        return flat_media_from_slot(m["styles"].get(source)), "pixel", "pixel"

    if active == "pixel" and style_has_assets(slot):
        return flat_media_from_slot(slot), "pixel", None

    return flat_media_from_slot(slot), active, None


def style_status(media: dict, style: str, *, generating: str | None = None) -> str:
    """ready | generating | filter | empty"""
    style = normalize_style_id(style)
    if generating == style:
        return "generating"
    slot = ensure_manifest(media).get("styles", {}).get(style)
    if style == "pixel":
        if is_filter_style(slot):
            return "filter"
        if style_has_assets(slot) or (slot and slot.get("complete")):
            return "ready"
        if first_ready_style(media, exclude=("pixel",)):
            return "filter"
        return "empty"
    if style_has_assets(slot) or (slot and slot.get("complete")):
        return "ready"
    return "empty"


def list_style_entries(
    media: dict | None,
    *,
    generating: str | None = None,
) -> list[dict[str, Any]]:
    m = ensure_manifest(media)
    out = []
    for sid in KNOWN_ART_STYLES:
        st = style_status(m, sid, generating=generating)
        entry: dict[str, Any] = {
            "id": sid,
            "label": _STYLE_LABELS.get(sid, sid),
            "status": st,
        }
        slot = m.get("styles", {}).get(sid) or {}
        if st == "filter" and sid == "pixel":
            entry["filter_source"] = slot.get("filter_source") or first_ready_style(
                m, exclude=("pixel",),
            )
        out.append(entry)
    return out


def can_activate(media: dict, style: str, *, generating: str | None = None) -> bool:
    st = style_status(media, style, generating=generating)
    return st in ("ready", "filter")


def set_active_style(media: dict, style: str) -> dict:
    style = normalize_style_id(style)
    m = ensure_manifest(media)
    m["active"] = style
    return m


def enable_pixel_filter(media: dict, *, source_style: str | None = None) -> dict:
    m = ensure_manifest(media)
    src = normalize_style_id(
        source_style or first_ready_style(m, exclude=("pixel",)) or "semi-real",
    )
    m["styles"]["pixel"] = {
        "mode": "filter",
        "filter_source": src,
    }
    m["active"] = "pixel"
    return m


def generation_target_style(media: dict | None, requested: str) -> str:
    """Raster assets live on the source style when pixel filter mode is active."""
    m = ensure_manifest(media, default_active=requested)
    style = normalize_style_id(requested)
    slot = m.get("styles", {}).get(style) or {}
    if is_filter_style(slot):
        return normalize_style_id(slot.get("filter_source") or first_ready_style(m, exclude=("pixel",)) or "semi-real")
    return style


def mark_style_generating(media: dict, style: str) -> dict:
    m = ensure_manifest(media)
    style = normalize_style_id(style)
    slot = m.get("styles", {}).get(style) or {}
    if is_filter_style(slot):
        # Never mutate the filter slot — generate into the source style instead.
        source = generation_target_style(m, style)
        slot = _style_slot(m, source)
        slot.pop("mode", None)
        slot["complete"] = False
        return m
    slot = _style_slot(m, style)
    slot.pop("mode", None)
    slot["complete"] = False
    m["active"] = style
    return m


def mark_style_complete(media: dict, style: str) -> dict:
    m = ensure_manifest(media)
    slot = _style_slot(m, style)
    slot["complete"] = True
    slot.pop("mode", None)
    return m


def read_pins_for_style(media: dict, style: str) -> dict:
    return dict(_style_slot(media, style).get("image_pins") or {})


def merge_pins_for_style(media: dict, style: str, pins: dict) -> dict:
    if not pins:
        return read_pins_for_style(media, style)
    m = ensure_manifest(media)
    slot = _style_slot(m, style)
    merged = dict(slot.get("image_pins") or {})
    merged.update(pins)
    slot["image_pins"] = merged
    return merged


def generated_style_count(media: dict) -> int:
    m = ensure_manifest(media)
    n = 0
    for sid, slot in m.get("styles", {}).items():
        if is_filter_style(slot):
            continue
        if style_has_assets(slot) or slot.get("complete"):
            n += 1
    return n


def delete_style(media: dict, style: str) -> dict:
    """Remove a style from manifest. Caller must guard last-style deletion."""
    m = ensure_manifest(media)
    style = normalize_style_id(style)
    m.get("styles", {}).pop(style, None)
    if m.get("active") == style:
        fallback = first_ready_style(m) or "semi-real"
        m["active"] = fallback
    return m


def style_storage_bytes(media_root: Path, book_id: str, style: str) -> int:
    d = media_root / book_id / normalize_style_id(style)
    if not d.is_dir():
        return 0
    return sum(f.stat().st_size for f in d.rglob("*") if f.is_file())


def remove_style_files(media_root: Path, book_id: str, style: str) -> None:
    d = media_root / book_id / normalize_style_id(style)
    if d.is_dir():
        shutil.rmtree(d, ignore_errors=True)
