"""Tests for sprite background purge (edge-detected color key)."""
from __future__ import annotations

import io

from PIL import Image

from server.images.white_key import (
    detect_edge_background_color,
    image_needs_background_purge,
    maybe_purge_sprite_background,
    purge_sprite_background,
    purge_white_background,
)


def _png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _jpeg_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=95)
    return buf.getvalue()


def test_detect_edge_background_gray():
    img = Image.new("RGB", (40, 40), (200, 200, 200))
    for x in range(15, 25):
        for y in range(15, 25):
            img.putpixel((x, y), (50, 50, 150))
    bg, dom = detect_edge_background_color(img)
    assert bg == (192, 192, 192)  # quantized from 200
    assert dom > 0.9


def test_purge_sprite_background_auto_gray():
    img = Image.new("RGB", (32, 32), (180, 180, 180))
    for x in range(10, 22):
        for y in range(10, 22):
            img.putpixel((x, y), (200, 40, 40))
    out_bytes, meta = purge_sprite_background(_jpeg_bytes(img), tolerance=20, softness=0)
    out = Image.open(io.BytesIO(out_bytes)).convert("RGBA")
    assert out.getpixel((16, 16))[3] > 200
    assert out.getpixel((0, 0))[3] == 0
    assert meta["background_rgb"] == [176, 176, 176]
    assert meta["auto_detected"] is True


def test_purge_white_background_legacy():
    img = Image.new("RGB", (32, 32), (255, 255, 255))
    for x in range(10, 22):
        for y in range(10, 22):
            img.putpixel((x, y), (200, 40, 40))
    out_bytes, meta = purge_white_background(_png_bytes(img), threshold=240, softness=0)
    out = Image.open(io.BytesIO(out_bytes)).convert("RGBA")
    assert out.getpixel((0, 0))[3] == 0
    assert meta["legacy_white_threshold"] == 240


def test_image_needs_background_purge_jpeg():
    img = Image.new("RGB", (8, 8), (255, 255, 255))
    assert image_needs_background_purge(_jpeg_bytes(img), "image/jpeg") is True


def test_maybe_purge_skips_transparent_png():
    img = Image.new("RGBA", (32, 32), (255, 255, 255, 0))
    for x in range(8, 24):
        for y in range(8, 24):
            img.putpixel((x, y), (200, 40, 40, 255))
    assert maybe_purge_sprite_background(_png_bytes(img), "image/png") is None


def test_purge_feathers_edges():
    img = Image.new("RGB", (20, 20), (255, 255, 255))
    img.putpixel((10, 10), (100, 100, 100))
    img.putpixel((5, 5), (238, 238, 238))
    out_bytes, meta = purge_sprite_background(
        _png_bytes(img), bg_color=(255, 255, 255), tolerance=10, softness=10,
        min_edge_dominance=0.0,
    )
    out = Image.open(io.BytesIO(out_bytes)).convert("RGBA")
    assert out.getpixel((10, 10))[3] == 255
    assert out.getpixel((0, 0))[3] == 0
    assert 0 < out.getpixel((5, 5))[3] < 255
    assert meta["pixels_feathered"] >= 1
    assert meta["method"] == "edge_flood"


def test_purge_preserves_enclosed_background_color():
    """White highlight inside foreground must not be keyed out."""
    img = Image.new("RGB", (32, 32), (255, 255, 255))
    for x in range(8, 24):
        for y in range(8, 24):
            img.putpixel((x, y), (200, 40, 40))
    img.putpixel((16, 16), (255, 255, 255))
    out_bytes, meta = purge_sprite_background(
        _png_bytes(img),
        bg_color=(255, 255, 255),
        tolerance=10,
        softness=0,
        min_edge_dominance=0.0,
    )
    out = Image.open(io.BytesIO(out_bytes)).convert("RGBA")
    assert out.getpixel((0, 0))[3] == 0
    assert out.getpixel((16, 16))[3] == 255
    assert meta["pixels_preserved_islands"] >= 1


def test_purge_gray_enclosed_island():
    img = Image.new("RGB", (40, 40), (200, 200, 200))
    for x in range(12, 28):
        for y in range(12, 28):
            img.putpixel((x, y), (50, 50, 150))
    img.putpixel((20, 20), (200, 200, 200))
    out_bytes, meta = purge_sprite_background(
        _png_bytes(img), tolerance=18, softness=0,
        min_edge_dominance=0.0,
    )
    out = Image.open(io.BytesIO(out_bytes)).convert("RGBA")
    assert out.getpixel((0, 0))[3] == 0
    assert out.getpixel((20, 20))[3] == 255
    assert meta["pixels_preserved_islands"] >= 1
