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
import random
from dataclasses import dataclass
from pathlib import Path

from ..analyze.schema import BookAnalysis
from ..playback.illustrations import reference_bytes_for_character
from .sprite_plan import plan_character_sprites, stock_sprite_url


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
    gen_c, stock_c = plan_character_sprites(analysis)
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
                     insert_line_indices: list[int] | None = None,
                     include_cover: bool = False) -> int:
    """Total generation steps (cover + chars + backgrounds + moment inserts)."""
    plan = plan_media(analysis, force_all=force_all)
    char_filter = set(character_ids or [])
    scene_filter = set(scene_ids or [])
    n = 0
    if scope in ("all", "cover") or (scope == "selected" and include_cover):
        n += 1
    if scope in ("all", "characters") or (scope == "selected" and char_filter):
        if scope == "selected" and char_filter:
            n += len(char_filter)
        else:
            chars = plan.characters_to_generate
            if char_filter:
                chars = [c for c in chars if c in char_filter]
            n += len(chars)
    if scope in ("all", "backgrounds") or (scope == "selected" and scene_filter):
        bgs = plan.backgrounds_to_generate
        if scene_filter:
            bgs = [b for b in bgs if b in scene_filter]
        n += len(bgs)
    n += _insert_work_count(analysis, scope, insert_line_indices)
    return n


def _insert_work_count(analysis: BookAnalysis, scope: str,
                       insert_line_indices: list[int] | None) -> int:
    if os.environ.get("DISABLE_VISUAL_INSERTS", "").lower() in ("1", "true", "yes"):
        return 0
    if scope == "inserts":
        if insert_line_indices:
            return len(insert_line_indices)
        from .moment_inserts import collect_visual_inserts
        return len(collect_visual_inserts(analysis))
    if scope == "all":
        from .moment_inserts import collect_visual_inserts
        return len(collect_visual_inserts(analysis))
    if scope == "selected" and insert_line_indices:
        return len(insert_line_indices)
    return 0


def regen_targets(
    analysis: BookAnalysis,
    *,
    force_all: bool = False,
    scope: str = "all",
    character_ids: list[str] | None = None,
    scene_ids: list[str] | None = None,
    insert_line_indices: list[int] | None = None,
    include_cover: bool = False,
) -> list[tuple[str, str]]:
    """(kind, key) pairs that will be generated — for pre-backup before overwrite."""
    plan = plan_media(analysis, force_all=force_all)
    char_filter = set(character_ids or [])
    scene_filter = set(scene_ids or [])
    by_id = {c.id: c for c in analysis.characters}
    out: list[tuple[str, str]] = []
    if scope in ("all", "cover") or (scope == "selected" and include_cover):
        out.append(("cover", "cover"))
    if scope in ("all", "characters") or (scope == "selected" and char_filter):
        if scope == "selected" and char_filter:
            out.extend(("characters", cid) for cid in char_filter if cid in by_id)
        else:
            chars = plan.characters_to_generate
            if char_filter:
                chars = [c for c in chars if c in char_filter]
            out.extend(("characters", cid) for cid in chars)
    if scope in ("all", "backgrounds") or (scope == "selected" and scene_filter):
        bgs = plan.backgrounds_to_generate
        if scene_filter:
            bgs = [b for b in bgs if b in scene_filter]
        out.extend(("backgrounds", sid) for sid in bgs)
    if scope in ("all", "inserts") or (scope == "selected" and insert_line_indices):
        if scope in ("all", "inserts") and not insert_line_indices:
            from .moment_inserts import collect_visual_inserts
            for ins in collect_visual_inserts(analysis):
                out.append(("inserts", str(ins["line_idx"])))
        elif insert_line_indices:
            for idx in insert_line_indices:
                out.append(("inserts", str(idx)))
    return out


def _stable_seed(key: str) -> int:
    return int(hashlib.sha256(key.encode()).hexdigest()[:8], 16) % (2**31)


def _style_out_dir(out_dir: str, art_style: str) -> str:
    d = os.path.join(out_dir, art_style)
    os.makedirs(d, exist_ok=True)
    return d


def _media_public_url(book_id: str, art_style: str, filename: str) -> str:
    return f"/media/{book_id}/{art_style}/{filename}"


from .backends import generate_image

REGEN_DIVERSITY_HINT = (
    "Alternate fresh interpretation — clearly different pose, expression, outfit details, "
    "camera angle, and composition from any previous version of this subject. "
    "Do not closely copy an earlier image."
)


def _apply_diversify(description: str, *, diversify: bool) -> str:
    if not diversify:
        return description
    return f"{description.strip()}. {REGEN_DIVERSITY_HINT}"


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
    diversify: bool = False,
) -> tuple[str | None, dict]:
    """Gemini → freemium → local SD. Returns (path, metadata) on success."""
    description = _apply_diversify(description, diversify=diversify)
    refs = None if diversify else reference_images
    ok, meta = generate_image(
        description,
        out_path,
        reference_images=refs,
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
                   existing_media: dict | None = None,
                   ignore_pins: bool = False,
                   diversify: bool = False,
                   insert_line_indices: list[int] | None = None) -> dict:
    """Returns {'characters': {id: url}, 'backgrounds': {scene_id: url}, 'cover'}.

    `on_item(kind, key, url)` (optional) fires as each asset resolves. Anything
    not generated is simply absent -> compiler emits a gradient placeholder.
    """
    plan = plan_media(analysis, force_all=force_all)
    pins = dict(image_pins or {})
    media = {"characters": {}, "backgrounds": {}, "expressions": {}, "inserts": {}, "cover": None}
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
    skip_inserts = set((skip.get("inserts") or {}).keys())
    skip_cover = bool(skip.get("cover"))
    insert_filter = set(insert_line_indices or [])
    want_inserts = (
        scope in ("all", "inserts")
        or (scope == "selected" and insert_filter)
    )

    def _emit(kind, key, url):
        if kind == "cover":
            media["cover"] = url
        else:
            media.setdefault(kind, {})[key] = url
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
            diversify=diversify,
        )
        if cpath:
            _emit("cover", "cover", url_prefix("cover.png"))

    by_id = {c.id: c for c in analysis.characters}
    if want_chars:
        if scope == "selected" and char_filter:
            char_targets = [cid for cid in char_filter if cid in by_id]
        else:
            char_targets = list(plan.characters_to_generate)
            if char_filter:
                char_targets = [c for c in char_targets if c in char_filter]
        for cid in char_targets:
            if cid in skip_chars:
                continue
            c = by_id[cid]
            desc = f"{c.name}: {c.description}".strip(": ")
            char_refs = (
                []
                if diversify
                else reference_bytes_for_character(cid, analysis, reference_images)
            )
            pin = pins.get(cid) or {}
            if diversify or ignore_pins:
                seed = random.randint(1, 2**31 - 1)
                prefer = None
            else:
                seed = pin.get("seed")
                if seed is None:
                    seed = _stable_seed(cid)
                prefer = pin.get("provider")
            path, meta = _gen_one(
                desc, char_refs, os.path.join(style_dir, f"char_{cid}.png"),
                subject_type="character", art_style=art_style, kind="character",
                allow_gemini=allow_gemini, allow_freemium=allow_freemium,
                allow_local=allow_local, seed=seed,
                prefer_provider=prefer,
                on_event=on_event,
                diversify=diversify,
            )
            if path:
                _emit("characters", cid, url_prefix(f"char_{cid}.png"))
                if meta.get("provider"):
                    pins[cid] = {"provider": meta["provider"], "seed": meta.get("seed", seed)}
                if not diversify and os.environ.get("DISABLE_EXPRESSION_SPRITES", "").lower() not in (
                    "1", "true", "yes",
                ):
                    from .expression_sprites import (
                        collect_character_expressions,
                        expression_prompt_suffix,
                    )
                    expr_map = collect_character_expressions(analysis)
                    for expr in sorted(expr_map.get(cid, [])):
                        expr_desc = (
                            f"{c.name}: {c.description}. "
                            f"{expression_prompt_suffix(expr)}. "
                            "Same character, same outfit and hair as reference."
                        )
                        expr_seed = _stable_seed(f"{cid}:{expr}")
                        epath, _ = _gen_one(
                            expr_desc, char_refs or None,
                            os.path.join(style_dir, f"char_{cid}_{expr}.png"),
                            subject_type="character", art_style=art_style,
                            kind="character",
                            allow_gemini=allow_gemini,
                            allow_freemium=allow_freemium,
                            allow_local=allow_local,
                            seed=expr_seed,
                            prefer_provider=prefer,
                            on_event=on_event,
                        )
                        if epath:
                            _emit("expressions", f"{cid}:{expr}",
                                  url_prefix(f"char_{cid}_{expr}.png"))
        if scope != "selected":
            for cid in plan.characters_from_stock:
                if char_filter and cid not in char_filter:
                    continue
                if cid in skip_chars:
                    continue
                url = stock_sprite_url(cid, by_id[cid].gender)
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
            bg_refs = [] if diversify else reference_images
            bg_seed = random.randint(1, 2**31 - 1) if diversify else None
            path, _ = _gen_one(
                desc, bg_refs, os.path.join(style_dir, f"bg_{sid}.png"),
                subject_type="background", art_style=art_style, kind="background",
                allow_gemini=allow_gemini, allow_freemium=allow_freemium,
                allow_local=allow_local, seed=bg_seed, on_event=on_event,
                diversify=diversify,
            )
            if path:
                _emit("backgrounds", sid, url_prefix(f"bg_{sid}.png"))

    if want_inserts and os.environ.get("DISABLE_VISUAL_INSERTS", "").lower() not in (
        "1", "true", "yes",
    ):
        from .moment_inserts import (
            collect_visual_inserts,
            moment_description,
            reference_bytes_for_moment,
        )

        if scope == "inserts" and insert_filter:
            targets = []
            for idx in sorted(insert_filter):
                loc = None
                li = 0
                for scene in analysis.scenes:
                    for line in scene.lines:
                        if li == idx:
                            loc = (scene, line)
                            break
                        li += 1
                    if loc:
                        break
                if loc:
                    scene, line = loc
                    targets.append({
                        "line_idx": idx,
                        "character_id": line.character_id,
                        "description": moment_description(
                            analysis, scene, line, line_idx=idx,
                        ),
                    })
        else:
            targets = collect_visual_inserts(analysis)
            if insert_filter:
                targets = [t for t in targets if t["line_idx"] in insert_filter]

        for ins in targets:
            key = str(ins["line_idx"])
            if key in skip_inserts:
                continue
            cid = ins["character_id"]
            refs = reference_bytes_for_moment(
                analysis, cid, Path(style_dir), reference_images,
            )
            ipath, _ = _gen_one(
                ins["description"], refs,
                os.path.join(style_dir, f"insert_{key}.png"),
                subject_type="character", art_style=art_style, kind="character",
                allow_gemini=allow_gemini, allow_freemium=allow_freemium,
                allow_local=allow_local,
                seed=_stable_seed(f"insert:{key}") if not diversify else random.randint(1, 2**31 - 1),
                on_event=on_event,
                diversify=diversify,
            )
            if ipath:
                _emit("inserts", key, url_prefix(f"insert_{key}.png"))

    media["image_pins"] = pins
    return media
