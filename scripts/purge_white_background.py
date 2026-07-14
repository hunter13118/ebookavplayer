#!/usr/bin/env python3
"""Strip a solid sprite backdrop (auto-detected from edges) → transparent PNG."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from legacy.server.images.white_key import (  # noqa: E402
    image_needs_background_purge,
    maybe_purge_sprite_background,
    purge_sprite_background,
)


def main() -> None:
    ap = argparse.ArgumentParser(
        description=(
            "Remove solid sprite backdrops via edge-connected flood fill. "
            "Only backdrop pixels reachable from the border are keyed out; "
            "same-color pixels enclosed by foreground are preserved."
        ),
    )
    ap.add_argument("input", type=Path, help="Source image (jpg, png, webp, …)")
    ap.add_argument(
        "-o", "--output", type=Path,
        help="Output PNG path (default: <input_stem>_transparent.png)",
    )
    ap.add_argument(
        "--background", metavar="R,G,B",
        help="Explicit backdrop color instead of edge detection",
    )
    ap.add_argument(
        "--tolerance", type=int, default=22,
        help="Max per-channel delta from backdrop color to key out (default: 22)",
    )
    ap.add_argument(
        "--softness", type=int, default=12,
        help="Feather band above tolerance (default: 12)",
    )
    ap.add_argument(
        "--min-edge-dominance", type=float, default=0.35,
        help="Require this share of edge pixels match detected color (default: 0.35)",
    )
    ap.add_argument(
        "--force", action="store_true",
        help="Purge even when input already has transparency",
    )
    ap.add_argument("--json", action="store_true", help="Print metadata JSON to stdout")
    args = ap.parse_args()

    src = args.input
    if not src.is_file():
        ap.error(f"input not found: {src}")

    raw = src.read_bytes()
    suffix = src.suffix.lower()
    ct = {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".png": "image/png", ".webp": "image/webp",
    }.get(suffix)

    bg = None
    if args.background:
        parts = [int(x.strip()) for x in args.background.split(",")]
        if len(parts) != 3:
            ap.error("--background must be R,G,B")
        bg = tuple(parts)  # type: ignore[assignment]

    if args.force:
        png_bytes, meta = purge_sprite_background(
            raw,
            bg_color=bg,
            tolerance=args.tolerance,
            softness=args.softness,
            min_edge_dominance=args.min_edge_dominance,
        )
    else:
        if not image_needs_background_purge(raw, ct):
            ap.error("input already has transparency; use --force to purge anyway")
        purged = maybe_purge_sprite_background(
            raw, ct,
            bg_color=bg,
            tolerance=args.tolerance,
            softness=args.softness,
            min_edge_dominance=args.min_edge_dominance,
        )
        if purged is None:
            ap.error("purge skipped (already transparent?)")
        png_bytes, meta = purged

    out = args.output or src.with_name(f"{src.stem}_transparent.png")
    out.write_bytes(png_bytes)
    meta["input"] = str(src)
    meta["output"] = str(out)
    meta["bytes_out"] = len(png_bytes)

    if args.json:
        print(json.dumps(meta, indent=2))
    else:
        bg = meta.get("background_rgb")
        print(
            f"Wrote {out} ({meta['bytes_out']} bytes, "
            f"bg={bg}, removed={meta['pixels_removed']})"
        )


if __name__ == "__main__":
    main()
