"""Map EPUB figure positions → analysis line illustration_ref (no LLM required)."""
from __future__ import annotations

import re

from ..analyze.schema import BookAnalysis, AnalysisLine, AnalysisScene

_MARKER = re.compile(r"^\[\[ILLUS:(\d+)\]\]$")
_NORM = re.compile(r"[^\w\s]+")
_WS = re.compile(r"\s+")


def _norm(text: str) -> str:
    return _WS.sub(" ", _NORM.sub("", (text or "").lower())).strip()


def _prefix_key(text: str, n: int = 48) -> str:
    return _norm(text)[:n]


def markers_in_chapter_text(text: str) -> list[tuple[int, str]]:
    """Return (image_index, following_paragraph_prefix) for each [[ILLUS:n]] marker."""
    paras = [p.strip() for p in (text or "").split("\n\n") if p.strip()]
    out: list[tuple[int, str]] = []
    for i, para in enumerate(paras):
        m = _MARKER.match(para)
        if not m:
            continue
        following = ""
        for nxt in paras[i + 1 :]:
            if _MARKER.match(nxt):
                break
            following = nxt
            break
        if following and len(following) > 180:
            following = following[:180]
        out.append((int(m.group(1)), following))
    return out


def _lines_for_chapter(analysis: BookAnalysis, chapter: int) -> list[tuple[AnalysisScene, int, AnalysisLine]]:
    rows: list[tuple[AnalysisScene, int, AnalysisLine]] = []
    for scene in analysis.scenes:
        if int(scene.chapter) != int(chapter):
            continue
        for li, line in enumerate(scene.lines):
            rows.append((scene, li, line))
    return rows


def _find_line_by_prefix(
    analysis: BookAnalysis,
    chapter: int,
    prefix: str,
) -> tuple[AnalysisScene, int] | None:
    key = _prefix_key(prefix)
    if not key:
        return None
    for scene, li, line in _lines_for_chapter(analysis, chapter):
        if _prefix_key(line.text).startswith(key[:32]) or key.startswith(_prefix_key(line.text)[:32]):
            return scene, li
    return None


def _first_dialogue_line(analysis: BookAnalysis, chapter: int) -> tuple[AnalysisScene, int] | None:
    for scene, li, line in _lines_for_chapter(analysis, chapter):
        if line.kind == "dialogue":
            return scene, li
    return None


def apply_illustration_placements(
    analysis: BookAnalysis,
    chapter_markers: dict[int, list[tuple[int, str]]],
) -> BookAnalysis:
    """Attach illustration_ref to playback lines from parse-time EPUB markers.

    Product rule: insert between lines A and B → ref on line B (flash after A,
    B starts while overlay visible).
    """
    if not chapter_markers:
        return analysis

    for chapter, markers in sorted(chapter_markers.items()):
        if not markers:
            continue
        chapter_lines = _lines_for_chapter(analysis, chapter)
        if not chapter_lines:
            continue

        for image_idx, following in markers:
            target: tuple[AnalysisScene, int] | None = None
            if following.strip():
                target = _find_line_by_prefix(analysis, chapter, following)
            if target is None and not following.strip():
                # Figure at chapter start (before body): show after opening narration,
                # before first dialogue when possible.
                target = _first_dialogue_line(analysis, chapter)
            if target is None and following.strip():
                target = _first_dialogue_line(analysis, chapter)
            if target is None and chapter_lines:
                # Last resort: second line in chapter (after first narration beat).
                scene, li = chapter_lines[min(1, len(chapter_lines) - 1)][:2]
                target = (scene, li)

            if target is None:
                continue
            scene, li = target
            line = scene.lines[li]
            scene.lines[li] = line.model_copy(update={"illustration_ref": image_idx})

    return analysis


def apply_single_illustration_fallback(analysis: BookAnalysis, image_count: int) -> BookAnalysis:
    """When EPUB has one plate but analysis omitted refs, attach to first ch-1 dialogue."""
    if image_count <= 0:
        return analysis
    has_ref = any(
        getattr(ln, "illustration_ref", None) is not None
        for s in analysis.scenes for ln in s.lines
    )
    if has_ref:
        return analysis
    target = _first_dialogue_line(analysis, 1)
    if target is None:
        return analysis
    scene, li = target
    scene.lines[li] = scene.lines[li].model_copy(update={"illustration_ref": 0})
    return analysis
