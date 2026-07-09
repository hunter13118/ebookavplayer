"""The single Gemini mega-pass prompt (one request per book, Brief step 2).

We ask for the entire structured analysis at once to conserve free-tier rate
limits. The schema mirrors analyze/schema.py:BookAnalysis so the response can
be validated directly. Embedded EPUB images (if any) are attached to the same
request as visual/color reference (Brief step 3).
"""
from __future__ import annotations

import json

from .dialogue_rules import DIALOGUE_EXTRACTION, DIALOGUE_EXAMPLES

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
        "illustration_ref": 0,
        "temperament": "stoic|excitable|dry/sarcastic|warm|volatile or blank if unclear",
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
        "illustration_ref": 0,
        "lines": [{
            "character_id": "slug or 'narrator'",
            "text": "the spoken/narrated text, verbatim",
            "kind": "dialogue|narration|thought|delivery",
            "expression": "yell|angry|whisper|sad|scared|surprised|happy|excited|embarrassed|smug|tender|nervous|sarcastic|determined|desperate|normal",
            "environment": "open|indoor|hall|cave",
            "intensity": 0.0,
            "illustration_ref": 0,
            "line_weight": "normal|minor",
            "delivery_verb": "sang|yelled|whispered|muttered|… or null",
        }],
    }],
}

RULES = f"""
{DIALOGUE_EXTRACTION}
{DIALOGUE_EXAMPLES}

Additional rules:
- Multi-speaker runs without "said X": use context (prior lines, scene
  present_character_ids, gender, conversation turn-taking) to pick the correct
  character_id. When uncertain between two present characters, prefer the one
  who did not speak last.
- SELF-IDENTIFICATION overrides turn-taking: if dialogue text clearly identifies
  the speaker ("It is I, PersonA", "I am PersonA", "PersonA speaking", first-person
  confession of identity), attribute to that character even when turn order suggests
  otherwise. Only override when the narrator explicitly attributes the line to
  someone else in the same beat or the text is unmistakably narrator prose.
- importance: 'primary' = recurring/named POV or major; 'secondary' = named but
  minor; 'background' = unnamed/crowd. Be conservative with 'primary'.
- Segment scenes on location change, time skip, or POV shift. Set
  time_skip_before=true when narrative time jumps.
- CHAPTER BOUNDARIES: When source text includes "## Chapter N: Title" headers,
  every scene MUST set chapter=N for the section it came from. Never assign
  Chapter 2+ prose to chapter=1.
- SCENE TITLES: scene.title is an evocative setting card ("Forest at Night",
  "Castle Gate at Dusk") — NOT the chapter title. Derive from location + mood/time.
- reuse_background_of: when a scene returns to a location already described,
  point at the earlier scene id instead of re-describing (saves image gen).
- appearance_changes: list only changes that should trigger NEW character art
  (injury, aging, costume change); otherwise leave empty to reuse art.
- temperament (per character, optional): a one/two-word baseline emotional
  register if the text makes it clear early on — stoic, excitable,
  dry/sarcastic, warm, volatile, etc. Leave blank rather than guessing. This
  is what lets a blunt character's "normal" line read flatter than an
  excitable character's "normal" line, instead of amplifying both equally.
- description/background_desc: 1-2 vivid sentences, concrete and visual. If
  reference images are attached, keep palette/style consistent with them.
- expression (per line, apply to every dialogue/thought/delivery line — be
  decisive, not cautious): default to a SPECIFIC emotional read. "normal" is
  reserved for genuinely flat, matter-of-fact lines (plain exposition, routine
  logistics) — NOT the safe default when unsure. If dialogue carries ANY
  charge (a question, a tease, mild surprise, affection, irritation), tag it
  as such rather than falling back to normal.
  Canonical buckets (primary vocabulary — freeform still allowed for flavor
  but MUST map conceptually onto one of these): yell, angry, whisper, sad,
  scared, surprised, happy, excited, embarrassed, smug, tender, nervous,
  sarcastic, determined, desperate, normal.
  Signals that should almost always produce a non-normal tag: exclamation
  points/"?!"/ALL CAPS → yell/angry/excited/scared; a delivery verb already
  present (sang, shouted, whispered, sobbed, hissed, teased, snapped,
  growled...) → derive the bucket directly from the verb; endearments/
  compliments/physical affection → tender/happy; self-deprecation, apology,
  hedging ("I guess", trailing off) → nervous/embarrassed; direct insults,
  commands, clipped sentences in a conflict beat → angry.
- visual_moment (per line, boolean): true on standout visual beats — dramatic
  poses, fan-service moments, splash-worthy reactions — when a full-screen
  insert would enhance the scene (omit illustration_ref if no EPUB image fits).
- environment (per line): acoustic space for reverb — open (outdoors), indoor,
  hall (large enclosed), cave (echoey). Default from scene location when unclear.
- intensity: 0.0–1.0 strength of expression (0.5 = subtle, 1.0 = full). Use
  higher values for emphatic whispers/yells; ~0.85 for calm narration; ~0.45
  for minor delivery tags (sang, whispered, etc.).
"""

ILLUSTRATION_RULES = """
- illustration_ref uses attached image indices 0, 1, 2, … (attachment order).
- On characters: best portrait/plate for that character — used as REFERENCE when
  generating an individual sprite (image may contain multiple people; still pick
  the closest plate). Do NOT assume it becomes the on-screen sprite.
- On scenes: establishing insert for that location — flashed briefly when the
  scene begins (first line) unless a specific line overrides it.
- On lines: set illustration_ref when an insert should appear exactly as that
  line is spoken (splash page, reaction shot, group illustration). This is a
  timed full-screen flash, then normal sprites return.
- Use null when no embedded image fits. Prefer line-level refs for timing.
"""


def build_prompt(book_id: str, title: str, author: str, body_text: str,
                 has_reference_images: bool = False) -> str:
    ref = ""
    if has_reference_images:
        ref = (
            "\nReference images are attached (numbered 0..N-1 in order); match "
            "their palette/style and emit illustration_ref when an image clearly "
            "belongs to a character or scene.\n"
            f"{ILLUSTRATION_RULES}"
        )
    else:
        ref = "\nNo reference images attached — omit illustration_ref (null).\n"
    return (
        f"{SYSTEM_INSTRUCTION}\n\n"
        f"Return JSON exactly matching this shape (types shown):\n"
        f"{json.dumps(SCHEMA_HINT, indent=2)}\n"
        f"{RULES}{ref}\n"
        f"book_id = {book_id!r}; title = {title!r}; author = {author!r}.\n\n"
        f"BOOK TEXT START\n{body_text}\nBOOK TEXT END\n"
    )
