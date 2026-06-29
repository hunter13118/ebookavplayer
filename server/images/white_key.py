"""Detect solid sprite backdrops and punch them to alpha (edge-connected flood fill)."""
from __future__ import annotations

import io
from collections import Counter, deque
from typing import Any

from PIL import Image

# MIME types that never carry an alpha channel in typical provider responses.
_OPAQUE_CONTENT_TYPES = frozenset({
    "image/jpeg",
    "image/jpg",
    "image/bmp",
})


def _quantize_rgb(rgb: tuple[int, ...], step: int = 16) -> tuple[int, int, int]:
    step = max(1, int(step))
    return tuple(min(255, (int(c) // step) * step) for c in rgb[:3])  # type: ignore[return-value]


def _edge_pixels(img: Image.Image, border: int) -> list[tuple[int, int, int]]:
    img = img.convert("RGB")
    w, h = img.size
    b = max(1, min(border, w // 4, h // 4))
    coords: set[tuple[int, int]] = set()
    for x in range(w):
        for y in range(b):
            coords.add((x, y))
            coords.add((x, h - 1 - y))
    for y in range(h):
        for x in range(b):
            coords.add((x, y))
            coords.add((w - 1 - x, y))
    return [img.getpixel(c) for c in coords]


def detect_edge_background_color(
    img: Image.Image,
    *,
    border: int = 2,
    quantize_step: int = 16,
) -> tuple[tuple[int, int, int], float]:
    """Return the dominant RGB on the image border and its share of edge samples."""
    samples = _edge_pixels(img, border)
    if not samples:
        return (255, 255, 255), 1.0
    counts: Counter[tuple[int, int, int]] = Counter(
        _quantize_rgb(s, quantize_step) for s in samples
    )
    bg, n = counts.most_common(1)[0]
    return bg, n / len(samples)


def _color_distance(rgb: tuple[int, ...], bg: tuple[int, int, int]) -> int:
    return max(abs(int(rgb[0]) - bg[0]), abs(int(rgb[1]) - bg[1]), abs(int(rgb[2]) - bg[2]))


def _transparent_ratio(img: Image.Image, *, alpha_cutoff: int = 250) -> float:
    rgba = img.convert("RGBA")
    alpha = rgba.getchannel("A")
    data = alpha.tobytes()
    if not data:
        return 0.0
    transparent = sum(1 for a in data if a < alpha_cutoff)
    return transparent / len(data)


def image_needs_background_purge(
    image_bytes: bytes,
    content_type: str | None = None,
    *,
    min_existing_transparency: float = 0.02,
) -> bool:
    """True when the asset likely has a baked-in backdrop worth keying out."""
    if not image_bytes:
        return False

    ct = (content_type or "").split(";")[0].strip().lower()
    if ct in _OPAQUE_CONTENT_TYPES:
        return True

    img = Image.open(io.BytesIO(image_bytes))
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        if _transparent_ratio(img) >= min_existing_transparency:
            return False

    return True


def _idx(x: int, y: int, w: int) -> int:
    return y * w + x


def _flood_edge_background(
    dist: list[int],
    w: int,
    h: int,
    tol: int,
) -> bytearray:
    """Mark pixels connected to the image border through same-color paths (4-neighbor).

    Only pixels with dist <= tol are candidates. Interior islands matching the
    backdrop color but enclosed by foreground are never visited.
    """
    n = w * h
    connected = bytearray(n)
    if not n:
        return connected

    def candidate(i: int) -> bool:
        return dist[i] <= tol

    queue: deque[tuple[int, int]] = deque()

    def try_seed(x: int, y: int) -> None:
        i = _idx(x, y, w)
        if not connected[i] and candidate(i):
            connected[i] = 1
            queue.append((x, y))

    for x in range(w):
        try_seed(x, 0)
        try_seed(x, h - 1)
    for y in range(h):
        try_seed(0, y)
        try_seed(w - 1, y)

    while queue:
        x, y = queue.popleft()
        if x > 0:
            nx, ny = x - 1, y
            i = _idx(nx, ny, w)
            if not connected[i] and candidate(i):
                connected[i] = 1
                queue.append((nx, ny))
        if x + 1 < w:
            nx, ny = x + 1, y
            i = _idx(nx, ny, w)
            if not connected[i] and candidate(i):
                connected[i] = 1
                queue.append((nx, ny))
        if y > 0:
            nx, ny = x, y - 1
            i = _idx(nx, ny, w)
            if not connected[i] and candidate(i):
                connected[i] = 1
                queue.append((nx, ny))
        if y + 1 < h:
            nx, ny = x, y + 1
            i = _idx(nx, ny, w)
            if not connected[i] and candidate(i):
                connected[i] = 1
                queue.append((nx, ny))

    return connected


def _neighbor_connected(connected: bytearray, x: int, y: int, w: int, h: int) -> bool:
    for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
        if 0 <= nx < w and 0 <= ny < h and connected[_idx(nx, ny, w)]:
            return True
    return False


def purge_sprite_background(
    image_bytes: bytes,
    *,
    bg_color: tuple[int, int, int] | None = None,
    tolerance: int = 22,
    softness: int = 12,
    border: int = 2,
    quantize_step: int = 16,
    min_edge_dominance: float = 0.35,
) -> tuple[bytes, dict[str, Any]]:
    """Key out backdrop pixels reachable from the image edges (flood fill).

    Same-color pixels fully enclosed by foreground are left opaque — e.g. a
    white eye highlight on a character over a white key color.
    """
    if not image_bytes:
        raise ValueError("purge_sprite_background: empty input")

    tol = max(0, min(255, int(tolerance)))
    soft = max(0, int(softness))
    min_dom = max(0.0, min(1.0, float(min_edge_dominance)))

    img = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
    w, h = img.size

    detected = bg_color
    dominance = 1.0
    if detected is None:
        rgb = img.convert("RGB")
        detected, dominance = detect_edge_background_color(
            rgb, border=border, quantize_step=quantize_step,
        )
        if dominance < min_dom:
            raise ValueError(
                f"edge background ambiguous (dominance={dominance:.2f} < {min_dom})"
            )

    bg = tuple(int(c) for c in detected[:3])
    px = img.load()

    dist: list[int] = [0] * (w * h)
    for y in range(h):
        for x in range(w):
            r, g, b, _a = px[x, y]
            dist[_idx(x, y, w)] = _color_distance((r, g, b), bg)

    connected = _flood_edge_background(dist, w, h, tol)

    removed = 0
    feathered = 0
    preserved_islands = 0

    for y in range(h):
        for x in range(w):
            i = _idx(x, y, w)
            d = dist[i]
            r, g, b, a = px[x, y]

            if connected[i]:
                if a:
                    removed += 1
                px[x, y] = (r, g, b, 0)
                continue

            if d <= tol:
                # Same color as backdrop but not edge-connected — keep it.
                preserved_islands += 1
                continue

            if soft and tol < d <= tol + soft and _neighbor_connected(connected, x, y, w, h):
                t = (d - tol) / soft
                new_a = int(a * t)
                if new_a < a:
                    feathered += 1
                px[x, y] = (r, g, b, new_a)

    out = io.BytesIO()
    img.save(out, format="PNG", optimize=True)
    meta: dict[str, Any] = {
        "width": w,
        "height": h,
        "background_rgb": list(bg),
        "edge_dominance": round(dominance, 4),
        "tolerance": tol,
        "softness": soft,
        "pixels_removed": removed,
        "pixels_feathered": feathered,
        "pixels_preserved_islands": preserved_islands,
        "flood_connected": int(sum(connected)),
        "auto_detected": bg_color is None,
        "method": "edge_flood",
    }
    return out.getvalue(), meta


def maybe_purge_sprite_background(
    image_bytes: bytes,
    content_type: str | None = None,
    **purge_kwargs: Any,
) -> tuple[bytes, dict[str, Any]] | None:
    """Purge when format lacks transparency; return None if skipped."""
    if not image_needs_background_purge(image_bytes, content_type):
        return None
    return purge_sprite_background(image_bytes, **purge_kwargs)


def purge_white_background(
    image_bytes: bytes,
    *,
    threshold: int = 240,
    softness: int = 12,
) -> tuple[bytes, dict[str, Any]]:
    """Legacy white-only key (explicit white backdrop)."""
    tol = max(0, 255 - int(threshold))
    png, meta = purge_sprite_background(
        image_bytes,
        bg_color=(255, 255, 255),
        tolerance=tol,
        softness=softness,
        min_edge_dominance=0.0,
    )
    meta["legacy_white_threshold"] = threshold
    return png, meta
