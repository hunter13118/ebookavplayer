"""Simplest-form smoke test for Gemini extraction + image gen.

Run on the HOST (needs GEMINI_API_KEY + network; the cowork sandbox has neither):

    pip install -r requirements.txt
    export GEMINI_API_KEY=...            # or set in your shell / .env
    python3 scripts/smoke_extract.py path/to/book.epub            # extraction only
    python3 scripts/smoke_extract.py path/to/book.epub --image    # + 1 test image

What it proves, minimally:
  1. EPUB parses (chapters, embedded images).
  2. The single Gemini mega-pass returns JSON that validates against BookAnalysis.
  3. (optional) One real image generates and saves to ./smoke_out/.

It deliberately does NOT run the whole pipeline — just the two risky, host-only
pieces, so you can confirm "it works" in under a minute.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a for a in sys.argv[1:] if a.startswith("--")}
    if not args:
        print("usage: python3 scripts/smoke_extract.py BOOK.epub [--image]")
        return 2
    epub = args[0]
    if not os.environ.get("GEMINI_API_KEY"):
        print("! GEMINI_API_KEY not set — set it and retry."); return 2

    from legacy.server.epub.parse import parse_epub
    from legacy.server.analyze.extract import extract_book
    from legacy.server.images.generate import generate_media, plan_media

    print(f"[1/3] parsing {epub} ...")
    book = parse_epub(epub)
    print(f"      title={book.title!r} author={book.author!r} "
          f"chapters={len(book.chapters)} embedded_images={len(book.images)}")

    print("[2/3] text extraction (Gemini → freemium fallback) ...")
    analysis = extract_book(book.book_id, book.title, book.author,
                            book.body_text, reference_images=book.images)
    n_primary = sum(1 for c in analysis.characters if c.importance == "primary")
    n_lines = sum(len(s.lines) for s in analysis.scenes)
    print(f"      OK — characters={len(analysis.characters)} "
          f"(primary={n_primary}) scenes={len(analysis.scenes)} lines={n_lines}")
    print("      sample line:",
          (analysis.scenes[0].lines[0].text[:70] + "…") if analysis.scenes
          and analysis.scenes[0].lines else "(none)")

    plan = plan_media(analysis)
    print(f"      image plan: would generate {plan.request_count()} "
          f"(+cover); {len(plan.characters_from_stock)} chars from stock pool")

    if "--image" in flags:
        print("[3/3] generating ONE test image (cover) ...")
        out = Path("smoke_out"); out.mkdir(exist_ok=True)
        # generate just the cover by running media gen and stopping after first emit
        got = {}
        def on_item(kind, key, url):
            got[kind] = url
            raise StopIteration  # bail after the first asset (cover)
        try:
            generate_media(analysis, str(out), book.images, on_item=on_item)
        except StopIteration:
            pass
        if got.get("cover"):
            print(f"      OK — wrote {out/'cover.png'}")
        else:
            print("      ! no image returned (check model id / quota / key)")
    else:
        print("[3/3] skipped image gen (pass --image to test it)")

    print("\nDONE. If steps 1–2 printed OK, simplest-form extraction works.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
