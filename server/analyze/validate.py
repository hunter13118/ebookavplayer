"""Validate extracted analysis against source EPUB text."""
from __future__ import annotations

import re
from collections import Counter

from ..epub.parse import parse_epub
from .repair import PLAIN_VERBS, _is_plain_speech_tag_line
from .schema import AnalysisLine, BookAnalysis

_WS = re.compile(r"\s+")
_PUNCT = re.compile(r"[^\w\s']+", re.UNICODE)
_WORD = re.compile(r"[\w']+", re.UNICODE)

_EMBEDDED_TAG = re.compile(
    r"^(?P<tag>(?:he|she|they)\s+(?:said|asked|replied|whispered|muttered|continued|added))"
    r"[,.]?\s+(?P<rest>.+)$",
    re.I,
)
_STANDALONE_TAG = re.compile(
    r"^(?:he|she|they)\s+"
    r"(?:said|asked|replied|whispered|muttered|continued|added)"
    r"(?:\s+(?:quietly|softly|slowly|firmly|evenly|simply|carefully|gently|sharply))?"
    r"[.,!?]?$",
    re.I,
)


def normalize_words(text: str) -> list[str]:
    t = _PUNCT.sub(" ", (text or "").lower())
    return _WORD.findall(t)


def flatten_script(analysis: BookAnalysis) -> list[AnalysisLine]:
    out: list[AnalysisLine] = []
    for scene in analysis.scenes:
        out.extend(scene.lines)
    return out


def source_chapter_text(epub_path: str, *, skip_titles: bool = True) -> str:
    book = parse_epub(epub_path)
    chunks: list[str] = []
    for ch in book.chapters:
        title = (ch.title or "").lower()
        if skip_titles and title in ("contents", "title", "nav"):
            continue
        if skip_titles and len(ch.text.strip()) < 80 and "chapter" not in title:
            continue
        chunks.append(ch.text)
    return "\n\n".join(chunks)


def word_coverage(source: str, script_lines: list[AnalysisLine]) -> dict:
    src_words = normalize_words(source)
    scr_words: list[str] = []
    for ln in script_lines:
        scr_words.extend(normalize_words(ln.text))
    src_c, scr_c = Counter(src_words), Counter(scr_words)
    missing_counts = {w: src_c[w] - scr_c.get(w, 0) for w in src_c if scr_c.get(w, 0) < src_c[w]}
    extra_counts = {w: scr_c[w] - src_c.get(w, 0) for w in scr_c if src_c.get(w, 0) < scr_c[w]}
    return {
        "source_words": len(src_words),
        "script_words": len(scr_words),
        "unique_missing": len(missing_counts),
        "unique_extra": len(extra_counts),
        "missing_counts": dict(sorted(missing_counts.items(), key=lambda x: -x[1])[:20]),
        "extra_counts": dict(sorted(extra_counts.items(), key=lambda x: -x[1])[:20]),
        "coverage_ratio": round(len(scr_words) / max(1, len(src_words)), 4),
    }


def structural_issues(lines: list[AnalysisLine]) -> list[dict]:
    issues: list[dict] = []
    for i, ln in enumerate(lines):
        text = (ln.text or "").strip()
        if not text:
            issues.append({"line": i + 1, "code": "empty_line", "text": text})
            continue
        if ln.kind == "dialogue" and ('"' in text or "'" in text):
            issues.append({"line": i + 1, "code": "dialogue_has_quotes", "text": text[:80]})
        if ln.kind == "delivery" and (ln.delivery_verb or "").lower() in PLAIN_VERBS:
            issues.append({"line": i + 1, "code": "plain_verb_as_delivery", "text": text[:80]})
        if text.lower() in PLAIN_VERBS:
            issues.append({"line": i + 1, "code": "lone_speech_verb", "text": text})
        if _is_plain_speech_tag_line(ln) and ln.character_id != "narrator":
            issues.append({"line": i + 1, "code": "tag_not_narrator", "char": ln.character_id, "text": text[:80]})
        if ln.kind == "dialogue" and ln.character_id == "narrator":
            issues.append({"line": i + 1, "code": "dialogue_on_narrator", "text": text[:80]})
        if i + 1 < len(lines) and ln.kind == "narration" and lines[i + 1].kind == "dialogue":
            if re.match(r"^(said|asked|replied)[,.]?$", text, re.I):
                issues.append({"line": i + 1, "code": "split_tag_fragment", "text": text})
        m = _EMBEDDED_TAG.match(text)
        if (
            m
            and ln.kind == "narration"
            and i > 0
            and lines[i - 1].kind == "dialogue"
            and not _STANDALONE_TAG.match(text)
            and len(m.group("rest").split()) > 2
        ):
            issues.append({
                "line": i + 1,
                "code": "tag_merged_with_narration",
                "text": text[:96],
                "hint": f"split after {m.group('tag')!r}",
            })
    return issues


def chapter_coverage(epub_path: str, script_lines: list[AnalysisLine]) -> list[dict]:
    book = parse_epub(epub_path)
    script_words = set(normalize_words(" ".join(ln.text for ln in script_lines)))
    rows: list[dict] = []
    for ch in book.chapters:
        title = (ch.title or "").strip()
        if title.lower() in ("contents",):
            continue
        words = normalize_words(ch.text)
        if not words:
            continue
        word_set = set(words)
        overlap = len(word_set & script_words) / max(1, len(word_set))
        rows.append({
            "chapter": ch.index,
            "title": title,
            "words": len(words),
            "overlap_ratio": round(overlap, 4),
            "likely_missing": overlap < 0.45 and len(words) > 60,
        })
    return rows


def illustration_check(epub_path: str, analysis: BookAnalysis) -> dict:
    book = parse_epub(epub_path)
    refs = sum(1 for s in analysis.scenes for ln in s.lines if ln.illustration_ref is not None)
    return {
        "epub_images": len(book.images),
        "epub_markers": {str(k): len(v) for k, v in book.illustration_markers.items()},
        "analysis_refs": refs,
    }


def substring_presence(source: str, lines: list[AnalysisLine], sample: int = 12) -> list[dict]:
    norm_src = _WS.sub(" ", source.lower())
    misses = []
    for i, ln in enumerate(lines):
        t = _WS.sub(" ", (ln.text or "").strip().lower())
        if len(t) < 12:
            continue
        key = t[: min(48, len(t))]
        if key not in norm_src:
            misses.append({"line": i + 1, "kind": ln.kind, "char": ln.character_id, "text": ln.text[:72]})
        if len(misses) >= sample:
            break
    return misses


def chapter_signature_misses(epub_path: str, script_lines: list[AnalysisLine]) -> list[dict]:
    """Flag chapters whose opening phrase does not appear in the script."""
    book = parse_epub(epub_path)
    script_norm = _WS.sub(" ", " ".join(ln.text for ln in script_lines).lower())
    misses: list[dict] = []
    for ch in book.chapters:
        words = normalize_words(ch.text)
        if len(words) < 6:
            continue
        sig = " ".join(words[:8])
        if sig not in script_norm:
            misses.append({"chapter": ch.index, "title": ch.title, "signature": sig})
    return misses


def validate_extract(epub_path: str, analysis: BookAnalysis) -> dict:
    source = source_chapter_text(epub_path)
    lines = flatten_script(analysis)
    report = {
        "scenes": len(analysis.scenes),
        "lines": len(lines),
        "characters": [{"id": c.id, "name": c.name} for c in analysis.characters],
        "word_coverage": word_coverage(source, lines),
        "structural_issues": structural_issues(lines),
        "chapter_coverage": chapter_coverage(epub_path, lines),
        "chapter_signature_misses": chapter_signature_misses(epub_path, lines),
        "illustrations": illustration_check(epub_path, analysis),
        "substring_misses": substring_presence(source, lines),
        "kind_counts": {},
    }
    for ln in lines:
        report["kind_counts"][ln.kind] = report["kind_counts"].get(ln.kind, 0) + 1
    return report
