#!/usr/bin/env python3
"""Generate generic stock character sprites (m00–m11, f00–f11) for fallback art."""
from __future__ import annotations

import os
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "media" / "stock"
POOL = int(os.environ.get("STOCK_POOL_SIZE", "12"))


def _png_rgb(w: int, h: int, rgb_fn) -> bytes:
    """Minimal RGB PNG without external deps."""
    rows = []
    for y in range(h):
        row = b"\x00"
        for x in range(w):
            row += bytes(rgb_fn(x, y))
        rows.append(row)
    raw = b"".join(rows)
    compressed = zlib.compress(raw, 9)

    def chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", compressed)
        + chunk(b"IEND", b"")
    )


def _palette(gender: str, idx: int):
    base = [(70, 130, 180), (100, 149, 237), (65, 105, 225)] if gender == "m" else [
        (219, 112, 147), (255, 105, 180), (199, 21, 133),
    ]
    skin = (255, 224, 189) if idx % 2 == 0 else (240, 200, 160)
    hair = [(40, 40, 40), (90, 60, 30), (180, 140, 80)][idx % 3]
    shirt = base[idx % len(base)]
    return skin, hair, shirt


def _draw_avatar(gender: str, idx: int, size: int = 64) -> bytes:
    skin, hair, shirt = _palette(gender, idx)
    cx, cy = size // 2, size // 2

    def px(x, y):
        dx, dy = x - cx, y - (cy - 4)
        r = (dx * dx + dy * dy) ** 0.5
        if y < cy - 10 and r < size * 0.28:
            return hair
        if r < size * 0.22:
            return skin
        if y > cy + 6 and abs(dx) < size * 0.2:
            return shirt
        if y > cy + 6 and size * 0.15 < abs(dx) < size * 0.28:
            return tuple(max(0, c - 40) for c in shirt)
        return (30, 35, 45)

    return _png_rgb(size, size, px)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for g in ("m", "f"):
        for i in range(POOL):
            path = OUT / f"{g}{i:02d}.png"
            path.write_bytes(_draw_avatar(g, i))
            print("wrote", path)
    print(f"done — {POOL * 2} stock sprites in {OUT}")


if __name__ == "__main__":
    main()
