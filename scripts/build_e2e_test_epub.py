#!/usr/bin/env python3
"""Build a minimal EPUB for manual e2e testing (3 characters, 2 scenes, 1 plate).

Usage:
    python scripts/build_e2e_test_epub.py
    python scripts/build_e2e_test_epub.py --illustration path/to/owl.jpg
    python scripts/build_e2e_test_epub.py --skip-owl-gen
"""
from __future__ import annotations

import argparse
import html
import sys
import zipfile
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZIP_STORED

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

ASSETS = ROOT / "test_assets" / "e2e"
DEFAULT_EPUB = ASSETS / "lantern-owl-gate.epub"
DEFAULT_OWL = ASSETS / "sable_owl_plate.png"

BOOK_ID = "lantern-owl-gate"
TITLE = "The Lantern Owl Gate"
AUTHOR = "E2E Test Author"

CHAPTER_1 = """The Moss Gate at Dawn

Rain had stopped by the time Mira and Orin reached the moss gate. Vines hung over the arch like wet curtains, and the air smelled of pine and old stone.

Mira pulled her blue cloak tighter. "The wards still hum," she said. "Someone maintained them recently."

Orin rested a hand on his sword hilt. "Or something maintained them for us. Keep your voice down."

From the branch above, Sable the owl familiar clicked his beak and spread one wing. His golden eyes caught the first light.

"Sable sees movement," Mira whispered. "East side of the path."

Orin nodded once. "Then we go through fast. No lanterns until we're inside."

Mira raised her palm. A pale spark bloomed above it, and for a moment the gate stones glittered green with moss.

"That will draw eyes," Orin muttered.

"Only if they are already watching," Mira replied. She stepped forward, boots squelching in the mud.

Sable launched from the branch and glided ahead, a silent shadow against the gray sky.

The gate groaned as they passed beneath it. Mira felt the old magic brush her skin like cold silk.

"Welcome back to the old kingdom," Orin said, not smiling.

"We are not welcome yet," Mira answered. "We are merely allowed to knock."
"""

CHAPTER_2 = """The Lantern Shrine

Beyond the gate, a narrow trail opened into a shrine cut into the hillside. Paper charms fluttered from cedar beams. A stone basin held rainwater that reflected the ceiling.

Sable landed on the rim of the basin and stared at his reflection. His feathers were still damp from the flight.

Mira knelt by the basin. "This is the place from the map. The lantern should be behind the inner screen."

Orin checked the doorway. "No footprints. No ash. Either we are first, or whoever came here did not want to be seen."

"Sable disagrees," Mira said softly.

The owl rotated his head sharply and hissed at the painted screen. In the same instant, a hidden latch clicked.

Orin drew half an inch of steel. "Speak plainly, Mira. Is that your doing?"

"Not mine." Mira stood. "But the shrine recognizes familiars. Sable is listed in the old registries."

A thin beam of daylight slid through the screen gap. Inside, they could see a brass lantern on a lacquered stand, unlit but intact.

Mira exhaled. "Two scenes, one gate, one shrine. If the lantern still holds a flame-spell, we can relight the ward network before nightfall."

Orin sheathed his sword. "Then stop narrating the obvious and open the screen."

Sable clicked proudly, as if the shrine had complimented him personally.

Mira laughed despite herself. "All right. Let the owl have his moment."

She pushed the screen aside. The lantern waited, patient as any keeper who had outlived its priests.
"""


def _paras(text: str) -> str:
    blocks = [b.strip() for b in text.strip().split("\n\n") if b.strip()]
    return "".join(f"<p>{html.escape(b)}</p>" for b in blocks)


def _xhtml(ch_title: str, body_html: str) -> str:
    return f"""<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>{ch_title}</title></head>
<body>
{body_html}
</body>
</html>
"""


def _ensure_owl(path: Path, *, skip_gen: bool) -> Path:
    if path.is_file():
        return path
    alt = path.with_suffix(".png" if path.suffix.lower() == ".jpg" else ".jpg")
    if alt.is_file():
        return alt
    if skip_gen:
        raise SystemExit(f"illustration missing: {path} (pass --illustration or drop file there)")

    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
    from server.images.freemium import _cfg, _maybe_purge_sprite_background, _try_pollinations_anon, compose_prompt

    prompt = compose_prompt(
        "Sable the owl familiar: surprised expression, wide golden eyes, blue-gray feathers, "
        "perched on an old lantern, portrait plate",
        subject_type="character",
        style="anime",
    )
    print(f"Generating owl plate via pollinations-anon …")
    cfg = {**_cfg(), "pollinations_format": "png"}
    result = _maybe_purge_sprite_background(
        _try_pollinations_anon(prompt, seed=42, cfg=cfg),
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    ext = ".png" if result.get("content_type", "").endswith("png") else ".jpg"
    out = path.with_suffix(ext)
    out.write_bytes(result["bytes"])
    print(f"  wrote {out} ({len(result['bytes'])} bytes)")
    return out


def build_epub(out_path: Path, illustration: Path) -> None:
    ill_name = f"images/{illustration.name}"
    ill_bytes = illustration.read_bytes()
    media_type = "image/png" if illustration.suffix.lower() == ".png" else "image/jpeg"
    ch1 = _xhtml(
        "The Moss Gate",
        f"""<h1>The Moss Gate at Dawn</h1>
<figure>
  <img src="{ill_name}" alt="Sable the owl familiar with a surprised expression"/>
  <figcaption>Sable reacts to movement beyond the gate.</figcaption>
</figure>
{_paras(CHAPTER_1)}""",
    )
    ch2 = _xhtml(
        "The Lantern Shrine",
        f"<h1>The Lantern Shrine</h1>{_paras(CHAPTER_2)}",
    )
    opf = f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:e2e:{BOOK_ID}</dc:identifier>
    <dc:title>{TITLE}</dc:title>
    <dc:creator>{AUTHOR}</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="owl" href="{ill_name}" media-type="{media_type}"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>
"""
    container = """<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_path, "w") as z:
        z.writestr("mimetype", "application/epub+zip", compress_type=ZIP_STORED)
        z.writestr("META-INF/container.xml", container, compress_type=ZIP_DEFLATED)
        z.writestr("OEBPS/content.opf", opf, compress_type=ZIP_DEFLATED)
        z.writestr("OEBPS/chapter1.xhtml", ch1, compress_type=ZIP_DEFLATED)
        z.writestr("OEBPS/chapter2.xhtml", ch2, compress_type=ZIP_DEFLATED)
        z.writestr(f"OEBPS/{ill_name}", ill_bytes, compress_type=ZIP_DEFLATED)
    print(f"Wrote EPUB -> {out_path}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Build e2e test EPUB")
    ap.add_argument("-o", "--output", type=Path, default=DEFAULT_EPUB)
    ap.add_argument("--illustration", type=Path, default=DEFAULT_OWL)
    ap.add_argument("--skip-owl-gen", action="store_true")
    args = ap.parse_args()

    ill = _ensure_owl(args.illustration, skip_gen=args.skip_owl_gen)
    build_epub(args.output, ill)

    from server.epub.parse import parse_epub
    book = parse_epub(str(args.output), BOOK_ID)
    print(
        f"Parse check: title={book.title!r} chapters={len(book.chapters)} "
        f"images={len(book.images)} chars~{len(book.body_text)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
