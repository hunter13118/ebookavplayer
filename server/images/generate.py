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


@dataclass
class MediaPlan:
    characters_to_generate: list[str]
    characters_from_stock: list[str]
    backgrounds_to_generate: list[str]
    backgrounds_reused: list[str]

    def request_count(self) -> int:
        return len(self.characters_to_generate) + len(self.backgrounds_to_generate)


def plan_media(analysis: BookAnalysis) -> MediaPlan:
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


def media_work_items(analysis: BookAnalysis) -> int:
    """Total generation steps (cover + primary chars + non-reused backgrounds).
    Stock-pool sprites are free (no request) and excluded from the count."""
    plan = plan_media(analysis)
    return 1 + len(plan.characters_to_generate) + len(plan.backgrounds_to_generate)


def _stock_sprite(character_id: str, gender: str) -> str:
    """Deterministically pick from a pre-generated generic pool."""
    pool = os.environ.get("STOCK_POOL_SIZE", "12")
    n = int(pool) if pool.isdigit() else 12
    h = int(hashlib.sha1(character_id.encode()).hexdigest(), 16) % n
    g = (gender or "n")[0].lower()
    return f"/media/stock/{g}{h:02d}.png"


def _gen_one(prompt: str, reference_images: list[bytes] | None,
             out_path: str) -> str | None:
    """Generate a single image. Returns path on success, None to fall back.
    Host-side; import-safe without a key. Wire Gemini image model here, then
    Cloudflare/HF/local-SD fallbacks (Brief step 3)."""
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return None
    try:
        from google import genai
        from google.genai import types
    except ImportError:
        return None
    try:
        client = genai.Client(api_key=api_key)
        # Current image models (2026): gemini-3.1-flash-image (Nano Banana 2,
        # fast default), gemini-3-pro-image (Nano Banana Pro), gemini-2.5-flash-image.
        model = os.environ.get("GEMINI_IMAGE_MODEL", "gemini-3.1-flash-image")
        parts = [prompt]
        for img in (reference_images or [])[:3]:
            parts.append(types.Part.from_bytes(data=img, mime_type="image/jpeg"))
        resp = client.models.generate_content(model=model, contents=parts)
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        for part in (resp.candidates[0].content.parts or []):
            inline = getattr(part, "inline_data", None)
            if inline and getattr(inline, "data", None):
                with open(out_path, "wb") as f:
                    f.write(inline.data)
                return out_path
            # newer SDK convenience: part.as_image() -> PIL Image
            as_img = getattr(part, "as_image", None)
            if callable(as_img):
                img = as_img()
                if img is not None:
                    img.save(out_path)
                    return out_path
    except Exception:
        return None
    return None


def generate_media(analysis: BookAnalysis, out_dir: str,
                   reference_images: list[bytes] | None = None,
                   art_style: str = "semi-real",
                   on_item=None) -> dict:
    """Returns {'characters': {id: url}, 'backgrounds': {scene_id: url}, 'cover'}.

    `on_item(kind, key, url)` (optional) fires as each asset resolves. Anything
    not generated is simply absent -> compiler emits a gradient placeholder.
    """
    plan = plan_media(analysis)
    style_tag = "pixel-art sprite" if art_style == "pixel" else \
        "semi-realistic digital painting"
    media = {"characters": {}, "backgrounds": {}, "cover": None}

    def _emit(kind, key, url):
        if kind == "cover":
            media["cover"] = url
        else:
            media[kind][key] = url
        if on_item:
            on_item(kind, key, url)

    # Cover first so a real thumbnail replaces the spinner early.
    cover_prompt = (f"{style_tag}, evocative book cover key art for "
                    f"'{analysis.title}'. No text.")
    cpath = _gen_one(cover_prompt, reference_images,
                     os.path.join(out_dir, "cover.png"))
    if cpath:
        _emit("cover", "cover", f"/media/{analysis.book_id}/cover.png")

    by_id = {c.id: c for c in analysis.characters}
    for cid in plan.characters_to_generate:
        c = by_id[cid]
        prompt = (f"{style_tag}, full-body character portrait, transparent "
                  f"background. {c.name}: {c.description}")
        path = _gen_one(prompt, reference_images,
                        os.path.join(out_dir, f"char_{cid}.png"))
        if path:
            _emit("characters", cid, f"/media/{analysis.book_id}/char_{cid}.png")
    for cid in plan.characters_from_stock:
        _emit("characters", cid, _stock_sprite(cid, by_id[cid].gender))

    by_scene = {s.id: s for s in analysis.scenes}
    for sid in plan.backgrounds_to_generate:
        s = by_scene[sid]
        prompt = (f"{style_tag}, wide scene background, no characters. "
                  f"{s.location}. {s.background_desc}")
        path = _gen_one(prompt, reference_images,
                        os.path.join(out_dir, f"bg_{sid}.png"))
        if path:
            _emit("backgrounds", sid, f"/media/{analysis.book_id}/bg_{sid}.png")
    return media
