"""Post-extract repair: structural fixes only — never rewrite line text."""
from __future__ import annotations

import re

from .schema import AnalysisLine, AnalysisScene, BookAnalysis

PLAIN_VERBS = frozenset({
    "said", "asked", "replied", "answered", "continued", "added", "exclaimed",
    "observed", "noted", "remarked", "demanded", "insisted", "declared",
    "announced", "explained", "offered", "suggested", "warned", "promised",
    "agreed", "protested", "mused", "wondered", "admitted", "confessed",
    "informed", "told", "reported", "finished", "concluded", "began",
    "started", "pressed", "urged", "pleaded", "begged", "commanded", "ordered",
    "interrupted", "went on",
})

STYLIZED_VERBS = frozenset({
    "sang", "sung", "yelled", "shouted", "screamed", "whispered", "murmured",
    "muttered", "cried", "sobbed", "laughed", "chuckled", "snapped", "growled",
    "hissed", "stammered", "stuttered", "croaked", "mumbled", "breathed",
    "sighed", "gasped", "panted", "barked", "roared", "sneered", "taunted",
    "teased", "joked", "quipped", "grinned", "smiled", "frowned", "scowled",
    "wept", "nodded", "shrugged",
})

_PRONOUN_TAG = re.compile(
    r"^(?P<pronoun>he|she|they)\s+(?P<verb>\w+)(?P<rest>.*)$",
    re.I,
)
_LONE_VERB = re.compile(
    r"^(?P<verb>said|asked|replied|answered|continued|added)(?P<rest>.*)$",
    re.I,
)
_ADVERB_TAIL = re.compile(
    r"^(quietly|softly|slowly|firmly|coldly|flatly|evenly|simply|"
    r"carefully|gently|sharply)(?P<punct>[.,!?]?)$",
    re.I,
)
_EMBEDDED_TAG_SPLIT = re.compile(
    r"^(?P<tag>(?:he|she|they)\s+(?:said|asked|replied|whispered|muttered|continued|added))"
    r"(?P<punct>[,.])?\s+(?P<rest>.+)$",
    re.I,
)
_STANDALONE_TAG = re.compile(
    r"^(?:he|she|they)\s+"
    r"(?:said|asked|replied|whispered|muttered|continued|added)"
    r"(?:\s+(?:quietly|softly|slowly|firmly|evenly|simply|carefully|gently|sharply))?"
    r"[.,!?]?$",
    re.I,
)
_TAGish = re.compile(
    r"^(?:(?:he|she|they)\s+)?(?:said|asked|replied|answered|continued|added|"
    r"whispered|murmured|muttered|exclaimed|observed|noted|remarked|demanded|"
    r"insisted|declared|announced|explained|offered|suggested|warned|promised|"
    r"agreed|protested|mused|wondered|admitted|confessed|informed|told|reported|"
    r"finished|concluded|began|started|pressed|urged|pleaded|begged|commanded|"
    r"ordered|interrupted)(?:\s+\w+)*[.,!?]?$",
    re.I,
)


def _first_verb_token(text: str) -> str:
    m = _PRONOUN_TAG.match(text.strip())
    if m:
        return m.group("verb").lower()
    m = _LONE_VERB.match(text.strip())
    if m:
        return m.group("verb").lower()
    parts = text.strip().split()
    return parts[0].lower().rstrip(".,!?") if parts else ""


def _is_plain_speech_tag_line(line: AnalysisLine) -> bool:
    if line.kind not in ("narration", "delivery"):
        return False
    verb = (line.delivery_verb or _first_verb_token(line.text or "")).lower()
    if verb in PLAIN_VERBS:
        return True
    text = (line.text or "").strip()
    if not text:
        return False
    if line.kind == "delivery" and verb not in STYLIZED_VERBS:
        return True
    return bool(_TAGish.match(text)) and verb not in STYLIZED_VERBS


def _normalize_delivery_line(line: AnalysisLine) -> AnalysisLine:
    """Plain said/asked on delivery lines → narration (text unchanged)."""
    verb = (line.delivery_verb or _first_verb_token(line.text or "")).lower()
    if line.kind != "delivery":
        return line
    if verb in STYLIZED_VERBS:
        return line
    return line.model_copy(update={
        "kind": "narration",
        "line_weight": "normal",
        "delivery_verb": None,
    })


def _merge_tag_fragments(lines: list[AnalysisLine]) -> list[AnalysisLine]:
    """Rejoin tags the model wrongly split ('he said' + 'quietly.')."""
    if len(lines) < 2:
        return lines
    out: list[AnalysisLine] = []
    i = 0
    while i < len(lines):
        cur = lines[i]
        if (
            i + 1 < len(lines)
            and cur.kind in ("narration", "delivery")
            and lines[i + 1].kind in ("narration", "delivery")
            and _is_plain_speech_tag_line(cur)
            and _ADVERB_TAIL.match((lines[i + 1].text or "").strip())
        ):
            merged_text = f"{cur.text.rstrip()} {lines[i + 1].text.lstrip()}".strip()
            out.append(cur.model_copy(update={
                "text": merged_text,
                "kind": "narration",
                "line_weight": "normal",
                "delivery_verb": None,
            }))
            i += 2
            continue
        out.append(cur)
        i += 1
    return out


def _normalize_tag_metadata(line: AnalysisLine) -> AnalysisLine:
    """Ensure plain tags use narration + narrator — never alter text."""
    if not _is_plain_speech_tag_line(line):
        return line
    return line.model_copy(update={
        "kind": "narration",
        "character_id": "narrator",
        "line_weight": "normal",
        "delivery_verb": None,
    })


def _split_merged_tag_narration(lines: list[AnalysisLine]) -> list[AnalysisLine]:
    """Split 'he said, climbing out…' after dialogue into tag + narration."""
    out: list[AnalysisLine] = []
    for i, ln in enumerate(lines):
        text = (ln.text or "").strip()
        prev = out[-1] if out else (lines[i - 1] if i > 0 else None)
        m = _EMBEDDED_TAG_SPLIT.match(text)
        if (
            m
            and ln.kind == "narration"
            and prev
            and prev.kind == "dialogue"
            and not _STANDALONE_TAG.match(text)
            and len(m.group("rest").split()) > 2
        ):
            punct = m.group("punct") or ","
            tag_text = f"{m.group('tag')}{punct}"
            out.append(ln.model_copy(update={"text": tag_text}))
            out.append(ln.model_copy(update={"text": m.group("rest").strip()}))
            continue
        out.append(ln)
    return out


def _fix_third_person_thought(line: AnalysisLine) -> AnalysisLine:
    """Interior monologue written in third person → narrator exposition."""
    if line.kind not in ("thought", "dialogue"):
        return line
    text = (line.text or "").strip()
    if not text or line.character_id == "narrator":
        return line
    cid = (line.character_id or "").lower()
    name_hint = cid.replace("_", " ")
    third = re.compile(
        rf"^(?:{re.escape(name_hint)}|{re.escape(line.character_id or '')})\s+"
        r"(?:thought|wondered|remembered|realized|recalled|considered|felt)\b",
        re.I,
    )
    if third.match(text) or re.match(
        r"^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+(?:thought|wondered|remembered|realized|recalled)\b",
        text,
    ):
        return line.model_copy(update={"kind": "narration", "character_id": "narrator"})
    if line.kind == "thought" and len(text.split()) > 18 and not text.startswith(('"', "'", "I ")):
        return line.model_copy(update={"kind": "narration", "character_id": "narrator"})
    return line


def repair_scene_lines(lines: list[AnalysisLine]) -> list[AnalysisLine]:
    fixed = [_normalize_delivery_line(ln) for ln in lines]
    fixed = [_fix_third_person_thought(ln) for ln in fixed]
    fixed = _merge_tag_fragments(fixed)
    fixed = _split_merged_tag_narration(fixed)
    return [_normalize_tag_metadata(ln) for ln in fixed]


def repair_analysis(analysis: BookAnalysis) -> BookAnalysis:
    """Structural speech-tag cleanup after LLM extraction (verbatim text preserved)."""
    scenes: list[AnalysisScene] = []
    for scene in analysis.scenes:
        repaired = repair_scene_lines(scene.lines)
        scenes.append(scene.model_copy(update={"lines": repaired}))
    return renormalize_chapters(analysis.model_copy(update={"scenes": scenes}))


def renormalize_chapters(analysis: BookAnalysis) -> BookAnalysis:
    """Map scene chapter numbers to 1..N in first-seen order (drops EPUB front-matter offset)."""
    order: list[int] = []
    for scene in analysis.scenes:
        if scene.chapter not in order:
            order.append(scene.chapter)
    if not order:
        return analysis
    if order == list(range(1, len(order) + 1)):
        return analysis
    mapping = {old: i + 1 for i, old in enumerate(order)}
    scenes = [
        scene.model_copy(update={"chapter": mapping.get(scene.chapter, scene.chapter)})
        for scene in analysis.scenes
    ]
    return analysis.model_copy(update={"scenes": scenes})


def chapter_remap(analysis: BookAnalysis) -> dict[int, int]:
    """Old chapter id → renormalized id (empty when already 1..N)."""
    order: list[int] = []
    for scene in analysis.scenes:
        if scene.chapter not in order:
            order.append(scene.chapter)
    if not order or order == list(range(1, len(order) + 1)):
        return {}
    return {old: i + 1 for i, old in enumerate(order)}
