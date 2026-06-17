"""The single Gemini mega-pass prompt (one request per book, Brief step 2).

We ask for the entire structured analysis at once to conserve free-tier rate
limits. The schema mirrors analyze/schema.py:BookAnalysis so the response can
be validated directly. Embedded EPUB images (if any) are attached to the same
request as visual/color reference (Brief step 3).
"""
from __future__ import annotations

import json

SYSTEM_INSTRUCTION = (
    "You are a literary scene director. You convert a novel's text into a "
    "structured 'visual audiobook' script. You never invent plot; you only "
    "segment, attribute, and describe what is already in the text. Output must "
    "be a single valid JSON object and nothing else."
)

SCHEMA_HINT = {
    "book_id": "string",
    "title": "string",
    "author": "string",
    "characters": [{
        "id": "lowercase-slug",
        "name": "string",
        "aliases": ["string"],
        "gender": "male|female|unknown",
        "age": "child|young|adult|old",
        "importance": "primary|secondary|background",
        "description": "concise visual description for image generation",
        "appearance_changes": ["notable look change warranting new art"],
    }],
    "scenes": [{
        "id": "scene-0001",
        "chapter": 1,
        "title": "string",
        "location": "string",
        "background_desc": "concise scene/setting description for image gen",
        "reuse_background_of": "scene-id or null (recurring location)",
        "time_skip_before": False,
        "present_character_ids": ["slug"],
        "lines": [{
            "character_id": "slug or 'narrator'",
            "text": "the spoken/narrated text, verbatim",
            "kind": "dialogue|narration|thought",
        }],
    }],
}

RULES = """
Rules:
- ONE narrator line per stretch of narration; keep dialogue attributed to the
  speaking character by slug. Use 'narrator' for all narration.
- importance: 'primary' = recurring/named POV or major; 'secondary' = named but
  minor; 'background' = unnamed/crowd. Be conservative with 'primary'.
- Segment scenes on location change, time skip, or POV shift. Set
  time_skip_before=true when narrative time jumps.
- reuse_background_of: when a scene returns to a location already described,
  point at the earlier scene id instead of re-describing (saves image gen).
- appearance_changes: list only changes that should trigger NEW character art
  (injury, aging, costume change); otherwise leave empty to reuse art.
- description/background_desc: 1-2 vivid sentences, concrete and visual. If
  reference images are attached, keep palette/style consistent with them.
- Preserve text verbatim in line.text. Do not summarize or paraphrase.
"""


def build_prompt(book_id: str, title: str, author: str, body_text: str,
                 has_reference_images: bool = False) -> str:
    ref = ("\nReference images are attached; match their color palette and "
           "character/world style.\n" if has_reference_images else "")
    return (
        f"{SYSTEM_INSTRUCTION}\n\n"
        f"Return JSON exactly matching this shape (types shown):\n"
        f"{json.dumps(SCHEMA_HINT, indent=2)}\n"
        f"{RULES}{ref}\n"
        f"book_id = {book_id!r}; title = {title!r}; author = {author!r}.\n\n"
        f"BOOK TEXT START\n{body_text}\nBOOK TEXT END\n"
    )
