#!/usr/bin/env python3
"""Compare extracted analysis against source EPUB (verbatim + structure checks)."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from legacy.server.analyze.schema import BookAnalysis  # noqa: E402
from legacy.server.analyze.validate import validate_extract  # noqa: E402
from legacy.server.playback import library as L  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description="Validate extract vs EPUB source")
    ap.add_argument("book_id", nargs="?", default="The_Vending_Machine_at_the_Edge_of_the_World")
    ap.add_argument("--epub", type=Path, help="EPUB path override")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    bid = args.book_id
    epub_path = args.epub or (ROOT / "data" / "uploads" / f"{bid}.epub")
    analysis_path = L._path(bid, ".analysis.json")
    if not epub_path.is_file():
        ap.error(f"EPUB not found: {epub_path}")
    if not analysis_path.is_file():
        ap.error(f"analysis not found: {analysis_path}")

    analysis = BookAnalysis.model_validate(json.loads(analysis_path.read_text(encoding="utf-8")))
    report = validate_extract(str(epub_path), analysis)
    report["book_id"] = bid
    report["epub"] = str(epub_path)

    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return

    wc = report["word_coverage"]
    print(f"=== {bid} ===")
    print(f"Lines: {report['lines']}  Scenes: {report['scenes']}")
    print(f"Kinds: {report['kind_counts']}")
    print(f"Words: script {wc['script_words']} / source {wc['source_words']}  ratio={wc['coverage_ratio']}")
    if wc["missing_counts"]:
        print(f"Missing word counts (top): {wc['missing_counts']}")
    if wc["extra_counts"]:
        print(f"Extra word counts (top): {wc['extra_counts']}")
    ill = report["illustrations"]
    print(f"Illustrations: epub={ill['epub_images']} markers={ill['epub_markers']} refs={ill['analysis_refs']}")
    issues = report["structural_issues"]
    print(f"Structural issues: {len(issues)}")
    for it in issues[:15]:
        print(f"  L{it['line']} [{it['code']}] {it.get('text', it)}")
    missing_ch = [c for c in report["chapter_coverage"] if c.get("likely_missing")]
    if missing_ch:
        print("Likely missing / thin chapters:")
        for c in missing_ch:
            print(f"  ch{c['chapter']} {c['title']!r} overlap={c['overlap_ratio']}")
    if report["substring_misses"]:
        print("Substring misses (line text not found in EPUB):")
        for m in report["substring_misses"]:
            print(f"  L{m['line']} ({m['kind']}/{m['char']}): {m['text']!r}")


if __name__ == "__main__":
    main()
