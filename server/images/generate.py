"""Image generation (Brief step 3): primary characters + backgrounds only.

Strategy:
  * Primary characters & non-reused backgrounds  -> Gemini image gen
    (Google AI Studio free tier ~500 img/day), using embedded EPUB images as
    color/style reference when available.
  * Secondary / background characters            -> generic stock pool (no
    request bloat). Retroactive upgrade if a side character becomes important.
  * No key / quota exhausted                      -> css-gradient placeholder
    tokens (the client renders these), so the pipeline never hard-fails.

`generate_media(..., on_item=cb)` invokes cb(kind, key, url) as each asset
resolves so the ingest job can persist + bump progress live (Brief: assets
become available to an already-open book as they generate).
"""
from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass

from ..analyze.schema import BookAnalysis
from ..playback.illustrations import reference_bytes_for_character


@dataclass
class MediaPlan:
    characters_to_generate: list[str]
    characters_from_stock: list[str]
    backgrounds_to_generate: list[str]
    backgrounds_reused: list[str]

    def request_count(self) -> int:
        return len(self.characters_to_generate) + len(self.backgrounds_to_generate)


def plan_media(analysis: BookAnalysis, *, force_all: bool = False) -> MediaPlan:
    if force_all:
        gen_c = [c.id for c in analysis.characters]
        gen_b, reuse_b = [], []
        for s in analysis.scenes:
            if s.reuse_background_of:
                reuse_b.append(s.id)
            else:
                gen_b.append(s.id)
        return MediaPlan(gen_c, [], gen_b, reuse_b)
    gen_c, stock_c = [], []
    for c in analysis.characters:
        (gen_c if c.importance == "primary" else stock_c).append(c.id)
    gen_b, reuse_b = [], []
    for s in analysis.scenes:
        if s.reuse_background_of:
            reuse_b.append(s.id)
        else:
            gen_b.append(s.id)
    return MediaPlan(gen_c, stock_c, gen_b, reuse_b)


def media_work_items(analysis: BookAnalysis, *, force_all: bool = False,
                     scope: str = "all",
                     character_ids: list[str] | None = None,
                     scene_ids: list[str] | None = None,
                     include_cover: bool = False) -> int:
    """Total generation steps (cover + chars + non-reused backgrounds)."""
    plan = plan_media(analysis, force_all=force_all)
    char_filter = set(character_ids or [])
    scene_filter = set(scene_ids or [])
    n = 0
    if scope in ("all", "cover") or (scope == "selected" and include_cover):
        n += 1
    if scope in ("all", "characters") or (scope == "selected" and char_filter):
        chars = plan.characters_to_generate
        if char_filter:
            chars = [c for c in chars if c in char_filter]
        n += len(chars)
    if scope in ("all", "backgrounds") or (scope == "selected" and scene_filter):
        bgs = plan.backgrounds_to_generate
        if scene_filter:
            bgs = [b for b in bgs if b in scene_filter]
        n += len(bgs)
    return n


def _stock_sprite(character_id: str, gender: str) -> str:
    """Deterministically pick from a pre-generated generic pool."""
    pool = os.environ.get("STOCK_POOL_SIZE", "12")
    n = int(pool) if pool.isdigit() else 12
    h = int(hashlib.sha1(character_id.encode()).hexdigest(), 16) % n
    g = (gender or "n")[0].lower()
    return f"/media/stock/{g}{h:02d}.png"


def _stable_seed(key: str) -> int:
    return int(hashlib.sha256(key.encode()).hexdigest()[:8], 16) % (2**31)


def _style_out_dir(out_dir: str, art_style: str) -> str:
    d = os.path.join(out_dir, art_style)
    os.makedirs(d, exist_ok=True)
    return d


def _media_public_url(book_id: str, art_style: str, filename: str) -> str:
    return f"/media/{book_id}/{art_style}/{filename}"


from .backends import generate_image


def _gen_one(
    description: str,
    reference_images: list[bytes] | None,
    out_path: str,
    *,
    subject_type: str = "character",
    art_style: str = "semi-real",
    kind: str = "character",
    allow_gemini: bool = True,
    allow_freemium: bool = True,
    allow_local: bool = True,
    seed: int | None = None,
    prefer_provider: str | None = None,
    on_event=None,
) -> tuple[str | None, dict]:
    """Gemini → freemium → local SD. Returns (path, metadata) on success."""
    ok, meta = generate_image(
        description,
        out_path,
        reference_images=reference_images,
        subject_type=subject_type,
        art_style=art_style,
        kind=kind,
        allow_gemini=allow_gemini,
        allow_freemium=allow_freemium,
        allow_local=allow_local,
        seed=seed,
        prefer_provider=prefer_provider,
        on_event=on_event,
    )
    return (out_path, meta) if ok else (None, meta)


def generate_media(analysis: BookAnalysis, out_dir: str,
                   reference_images: list[bytes] | None = None,
                   art_style: str = "semi-real",
                   on_item=None, *, force_all: bool = False,
                   scope: str = "all",
                   character_ids: list[str] | None = None,
                   scene_ids: list[str] | None = None,
                   include_cover: bool = False,
                   allow_gemini: bool = True,
                   allow_freemium: bool = True,
                   allow_local: bool = True,
                   on_event=None,
                   image_pins: dict | None = None,
                   existing_media: dict | None = None) -> dict:
    """Returns {'characters': {id: url}, 'backgrounds': {scene_id: url}, 'cover'}.

    `on_item(kind, key, url)` (optional) fires as each asset resolves. Anything
    not generated is simply absent -> compiler emits a gradient placeholder.
    """
    plan = plan_media(analysis, force_all=force_all)
    pins = dict(image_pins or {})
    media = {"characters": {}, "backgrounds": {}, "cover": None}
    style_dir = _style_out_dir(out_dir, art_style)
    url_prefix = lambda fn: _media_public_url(analysis.book_id, art_style, fn)
    char_filter = set(character_ids or [])
    scene_filter = set(scene_ids or [])
    want_cover = scope in ("all", "cover") or (scope == "selected" and include_cover)
    want_chars = scope in ("all", "characters") or (scope == "selected" and char_filter)
    want_bgs = scope in ("all", "backgrounds") or (scope == "selected" and scene_filter)
    skip = existing_media or {}
    skip_chars = set((skip.get("characters") or {}).keys())
    skip_bgs = set((skip.get("backgrounds") or {}).keys())
    skip_cover = bool(skip.get("cover"))

    def _emit(kind, key, url):
        if kind == "cover":
            media["cover"] = url
        else:
            media[kind][key] = url
        if on_item:
            on_item(kind, key, url)

    # Cover first so a real thumbnail replaces the spinner early.
    if want_cover and not skip_cover:
        cover_desc = f"Evocative book cover key art for '{analysis.title}'. No text."
        cpath, _ = _gen_one(
            cover_desc, reference_images, os.path.join(style_dir, "cover.png"),
            subject_type="background", art_style=art_style, kind="cover",
            allow_gemini=allow_gemini, allow_freemium=allow_freemium,
            allow_local=allow_local, on_event=on_event,
        )
        if cpath:
            _emit("cover", "cover", url_prefix("cover.png"))

    by_id = {c.id: c for c in analysis.characters}
    if want_chars:
        for cid in plan.characters_to_generate:
            if char_filter and cid not in char_filter:
                continue
            if cid in skip_chars:
                continue
            c = by_id[cid]
            desc = f"{c.name}: {c.description}".strip(": ")
            char_refs = reference_bytes_for_character(cid, analysis, reference_images)
            pin = pins.get(cid) or {}
            seed = pin.get("seed")
            if seed is None:
                seed = _stable_seed(cid)
            path, meta = _gen_one(
                desc, char_refs, os.path.join(style_dir, f"char_{cid}.png"),
                subject_type="character", art_style=art_style, kind="character",
                allow_gemini=allow_gemini, allow_freemium=allow_freemium,
                allow_local=allow_local, seed=seed,
                prefer_provider=pin.get("provider"),
                on_event=on_event,
            )
            if path:
                _emit("characters", cid, url_prefix(f"char_{cid}.png"))
                if meta.get("provider"):
                    pins[cid] = {"provider": meta["provider"], "seed": meta.get("seed", seed)}
        for cid in plan.characters_from_stock:
            if char_filter and cid not in char_filter:
                continue
            if cid in skip_chars:
                continue
            url = _stock_sprite(cid, by_id[cid].gender)
            stock_path = os.path.join(
                os.environ.get("DATA_DIR", "./data"), "media",
                url.removeprefix("/media/"))
            if os.path.isfile(stock_path):
                _emit("characters", cid, url)

    by_scene = {s.id: s for s in analysis.scenes}
    if want_bgs:
        for sid in plan.backgrounds_to_generate:
            if scene_filter and sid not in scene_filter:
                continue
            if sid in skip_bgs:
                continue
            s = by_scene[sid]
            desc = f"{s.location}. {s.background_desc}".strip(". ")
            path, _ = _gen_one(
                desc, reference_images, os.path.join(style_dir, f"bg_{sid}.png"),
                subject_type="background", art_style=art_style, kind="background",
                allow_gemini=allow_gemini, allow_freemium=allow_freemium,
                allow_local=allow_local, on_event=on_event,
            )
            if path:
                _emit("backgrounds", sid, url_prefix(f"bg_{sid}.png"))
    media["image_pins"] = pins
    return media
