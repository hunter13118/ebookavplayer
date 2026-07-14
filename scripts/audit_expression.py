#!/usr/bin/env python3
"""Audit a book's compiled playback for under-triggered expression tagging.

Phase 0 of docs/EXPRESSION_SENSITIVITY_PLAN.md: this is the regression
fixture the rest of that plan is measured against. Flags chapters where the
extraction came back suspiciously flat (mostly/all "normal" expression) even
though the raw line text looks emotionally charged — catching exactly the
kind of miss found by hand on Vol.5 Ch.1 (100% normal on both a cloud and a
from-scratch local Ollama pass).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server.playback import library as L  # noqa: E402

DIALOGUE_ISH_KINDS = {"dialogue", "thought"}

# Signals that suggest a line reads as emotional even if tagged "normal" —
# mirrors the "signals that should almost always produce a non-normal tag"
# list in EXPRESSION_SENSITIVITY_PLAN.md Phase 1a: exclamation points and
# question marks STACKED with an exclamation ("?!"), not a bare "?" — a plain
# question is routinely genuinely flat, and matching any "?" here flooded the
# report with false positives (confirmed against a real 780-line chapter set:
# ~85% of flagged lines were plain, correctly-"normal" questions).
EXCLAIM_RE = re.compile(r"!|\?!")
ALLCAPS_WORD_RE = re.compile(r"\b[A-Z]{3,}\b")


def _is_normal(expression: str | None) -> bool:
    return str(expression or "normal").strip().lower() == "normal"


def _looks_emotional(text: str) -> bool:
    text = text or ""
    return bool(EXCLAIM_RE.search(text) or ALLCAPS_WORD_RE.search(text))


def load_playback(book_id: str) -> dict:
    playback = L._read_json(L._path(book_id, ".json"))
    if not playback:
        raise SystemExit(f"no compiled playback found for book_id={book_id!r} (expected data/books/{book_id}.json)")
    return playback


def audit_book(playback: dict, threshold: float) -> dict:
    chapters: dict[int, dict] = defaultdict(lambda: {
        "lines": 0,
        "non_normal": 0,
        "expressions": defaultdict(int),
        "flat_but_emotional": [],
    })

    for scene in playback.get("scenes") or []:
        chapter = scene.get("chapter", 0)
        stat = chapters[chapter]
        for line in scene.get("lines") or []:
            kind = line.get("kind", "dialogue")
            if kind not in DIALOGUE_ISH_KINDS and kind != "delivery":
                continue
            expression = line.get("expression", "normal")
            stat["lines"] += 1
            stat["expressions"][expression] += 1
            if not _is_normal(expression):
                stat["non_normal"] += 1
            elif kind in DIALOGUE_ISH_KINDS and (
                line.get("delivery_verb") or _looks_emotional(line.get("text", ""))
            ):
                stat["flat_but_emotional"].append({
                    "idx": line.get("idx"),
                    "character_id": line.get("character_id"),
                    "text": line.get("text", "")[:80],
                    "delivery_verb": line.get("delivery_verb"),
                })

    report = {"book_id": playback.get("book_id"), "threshold_pct": threshold, "chapters": []}
    for chapter in sorted(chapters):
        stat = chapters[chapter]
        pct = round(100 * stat["non_normal"] / stat["lines"], 1) if stat["lines"] else 0.0
        report["chapters"].append({
            "chapter": chapter,
            "lines": stat["lines"],
            "non_normal": stat["non_normal"],
            "non_normal_pct": pct,
            "distinct_expressions": sorted(stat["expressions"]),
            "suspiciously_flat": stat["lines"] > 0 and pct < threshold,
            "flat_but_emotional_count": len(stat["flat_but_emotional"]),
            "flat_but_emotional_sample": stat["flat_but_emotional"][:5],
        })
    return report


def main() -> None:
    ap = argparse.ArgumentParser(description="Audit expression-tagging density per chapter")
    ap.add_argument("book_id")
    ap.add_argument("--threshold", type=float, default=5.0, help="flag chapters under this %% non-normal (default 5)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    playback = load_playback(args.book_id)
    report = audit_book(playback, args.threshold)

    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return

    print(f"=== {report['book_id']} (flag threshold: <{report['threshold_pct']}% non-normal) ===")
    any_flat = False
    for c in report["chapters"]:
        flag = " ⚠ SUSPICIOUSLY FLAT" if c["suspiciously_flat"] else ""
        if c["suspiciously_flat"]:
            any_flat = True
        print(
            f"  ch{c['chapter']:>2}  lines={c['lines']:>4}  non-normal={c['non_normal']:>4} "
            f"({c['non_normal_pct']:>5.1f}%)  distinct={len(c['distinct_expressions'])}{flag}"
        )
        if c["flat_but_emotional_count"]:
            print(f"        {c['flat_but_emotional_count']} 'normal'-tagged line(s) look emotional (delivery verb / !? / CAPS):")
            for ln in c["flat_but_emotional_sample"]:
                print(f"          L{ln['idx']} [{ln['character_id']}] {ln['text']!r}")
    if not any_flat:
        print("No chapters flagged — expression density looks healthy.")


if __name__ == "__main__":
    main()
