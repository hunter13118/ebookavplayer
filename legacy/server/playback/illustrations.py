"""EPUB illustration modes: flash moments, sprite-gen reference, legacy direct-use."""
from __future__ import annotations

from ..analyze.schema import BookAnalysis


def default_illustration_mode(art_style: str, image_count: int) -> str:
    """moment = timed flash + per-character gen reference (default when art exists).

    Multi-character inserts are poor permanent sprites but great as brief flashes
    and as reference plates for generating individual sprites.
    """
    if image_count <= 0:
        return "reference"
    if art_style in ("anime", "cartoon"):
        return "moment"
    return "reference"


def normalize_illustration_mode(mode: str | None, art_style: str, image_count: int) -> str:
    m = (mode or "auto").lower().strip()
    if m in ("direct", "direct-use", "direct_use", "use"):
        return "direct-use"
    if m in ("moment", "flash", "insert"):
        return "moment"
    if m == "reference":
        return "reference"
    return default_illustration_mode(art_style, image_count)


def catalog_from_urls(image_urls: dict[int, str]) -> list[str]:
    """Ordered illustration catalog for playback (index → public URL)."""
    if not image_urls:
        return []
    return [image_urls[i] for i in sorted(image_urls)]


def reference_bytes_for_character(
    character_id: str,
    analysis: BookAnalysis,
    all_images: list[bytes] | None,
) -> list[bytes] | None:
    """Pick the best reference plate for sprite generation (single character)."""
    if not all_images:
        return None
    by_id = {c.id: c for c in analysis.characters}
    c = by_id.get(character_id)
    if not c:
        return all_images[:3]
    ref = getattr(c, "illustration_ref", None)
    if ref is not None and 0 <= ref < len(all_images):
        return [all_images[ref]]
    return all_images[:3]


def apply_direct_illustrations(
    book_id: str,
    analysis: BookAnalysis,
    image_urls: dict[int, str],
    *,
    style: str,
    set_media,
) -> dict[str, int]:
    """Legacy: map illustration_ref → permanent media slots (direct-use mode)."""
    counts = {"characters": 0, "backgrounds": 0, "cover": 0}
    if not image_urls:
        return counts

    cover_url = None
    for c in analysis.characters:
        ref = getattr(c, "illustration_ref", None)
        if ref is None or ref not in image_urls:
            continue
        url = image_urls[ref]
        set_media(book_id, "characters", c.id, url, style=style)
        counts["characters"] += 1
        if cover_url is None:
            cover_url = url

    for s in analysis.scenes:
        if s.reuse_background_of:
            continue
        ref = getattr(s, "illustration_ref", None)
        if ref is None or ref not in image_urls:
            continue
        url = image_urls[ref]
        set_media(book_id, "backgrounds", s.id, url, style=style)
        counts["backgrounds"] += 1
        if cover_url is None:
            cover_url = url

    if cover_url and counts["characters"] + counts["backgrounds"] > 0:
        set_media(book_id, "cover", "cover", cover_url, style=style)
        counts["cover"] = 1

    return counts


def resolve_line_illustration(
    line_ref: int | None,
    scene_ref: int | None,
    *,
    is_first_line_in_scene: bool,
    catalog: list[str],
) -> tuple[int | None, str | None]:
    """Line event wins; else scene insert on first line of scene."""
    ref = line_ref
    if ref is None and is_first_line_in_scene:
        ref = scene_ref
    if ref is None or ref < 0 or ref >= len(catalog):
        return None, None
    return ref, catalog[ref]
