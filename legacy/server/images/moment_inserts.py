"""Per-line moment illustrations (full-frame inserts)."""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

from ..analyze.schema import AnalysisLine, AnalysisScene, BookAnalysis
from .expression_sprites import _line_expression, expression_prompt_suffix


def line_at_index(analysis: BookAnalysis, line_idx: int) -> tuple[AnalysisScene, int, AnalysisLine] | None:
    idx = 0
    for scene in analysis.scenes:
        for li, line in enumerate(scene.lines):
            if idx == line_idx:
                return scene, li, line
            idx += 1
    return None


def moment_description(
    analysis: BookAnalysis,
    scene: AnalysisScene,
    line: AnalysisLine,
    *,
    line_idx: int,
) -> str:
    custom = getattr(line, "moment_prompt", None) or ""
    if custom.strip():
        return custom.strip()
    by_id = {c.id: c for c in analysis.characters}
    cid = line.character_id
    char = by_id.get(cid)
    name = char.name if char else (cid if cid != "narrator" else "Narrator")
    expr = _line_expression(line)
    expr_bit = expression_prompt_suffix(expr) if expr != "normal" else "dramatic expressive moment"
    loc = scene.location or scene.title or "scene"
    text = (line.text or "").strip()[:200]
    return (
        f"{loc}. Full-screen story moment: {name}, {expr_bit}. "
        f"Scene: {scene.title or scene.id}. Story beat: {text}"
    ).strip()


def tweak_moment_line(
    analysis: BookAnalysis,
    scene: AnalysisScene,
    line: AnalysisLine,
    *,
    use_llm: bool = False,
) -> AnalysisLine:
    """Mark line as a visual moment; optionally enrich prompt / polish tag via LLM."""
    updates: dict = {"visual_moment": True}
    if not getattr(line, "moment_prompt", None):
        updates["moment_prompt"] = moment_description(
            analysis, scene, line, line_idx=-1,
        )
    if not use_llm or os.environ.get("DISABLE_MOMENT_SCRIPT_TWEAK", "").lower() in (
        "1", "true", "yes",
    ):
        return line.model_copy(update=updates)

    try:
        from ..analyze.freemium_extract import freemium_extract
        by_id = {c.id: c for c in analysis.characters}
        char = by_id.get(line.character_id)
        system = (
            "You polish visual-audiobook moment tags. Return JSON only: "
            '{"moment_prompt": "image gen description", "text": "optional refined line"}'
        )
        user = (
            f"Scene: {scene.title}. Location: {scene.location}.\n"
            f"Character: {char.name if char else line.character_id}.\n"
            f"Line ({line.kind}): {line.text}\n"
            f"Expression: {line.expression}\n"
            "Write a vivid moment_prompt for a full-screen illustration (fan-service OK when "
            "the line warrants it). Keep text identical unless a tiny clarity fix helps."
        )
        result = freemium_extract(user, system_prompt=system)
        data = result.get("data") or {}
        if isinstance(data, str):
            data = json.loads(re.sub(r",(\s*[}\]])", r"\1", data))
        if data.get("moment_prompt"):
            updates["moment_prompt"] = str(data["moment_prompt"]).strip()
        if data.get("text") and str(data["text"]).strip():
            new_text = str(data["text"]).strip()
            if new_text != (line.text or "").strip():
                updates["text"] = new_text
    except Exception:
        pass
    return line.model_copy(update=updates)


def patch_analysis_line(analysis: BookAnalysis, line_idx: int, line: AnalysisLine) -> BookAnalysis:
    loc = line_at_index(analysis, line_idx)
    if not loc:
        return analysis
    scene, li, _ = loc
    new_lines = list(scene.lines)
    new_lines[li] = line
    scenes = []
    for s in analysis.scenes:
        if s.id == scene.id:
            scenes.append(s.model_copy(update={"lines": new_lines}))
        else:
            scenes.append(s)
    return analysis.model_copy(update={"scenes": scenes})


def collect_visual_inserts(analysis: BookAnalysis) -> list[dict]:
    """All moment lines that need generated inserts (no cap)."""
    from .expression_sprites import INSERT_EXPRESSIONS  # noqa: PLC0415

    by_id = {c.id: c for c in analysis.characters}
    primary = {c.id for c in analysis.characters if c.importance == "primary"}
    inserts: list[dict] = []
    line_idx = 0
    for scene in analysis.scenes:
        for line in scene.lines:
            cid = line.character_id
            expr = _line_expression(line)
            visual = bool(getattr(line, "visual_moment", False))
            has_epub = getattr(line, "illustration_ref", None) is not None
            if not visual and not has_epub:
                if (
                    cid in primary
                    and line.kind == "dialogue"
                    and expr in INSERT_EXPRESSIONS
                    and float(getattr(line, "intensity", 1.0) or 1.0) >= 0.75
                    and len((line.text or "").split()) >= 4
                ):
                    visual = True
            if visual and not has_epub:
                inserts.append({
                    "line_idx": line_idx,
                    "character_id": cid,
                    "scene_id": scene.id,
                    "expression": expr,
                    "description": moment_description(
                        analysis, scene, line, line_idx=line_idx,
                    ),
                })
            line_idx += 1
    return inserts


def reference_bytes_for_moment(
    analysis: BookAnalysis,
    character_id: str,
    style_dir: Path,
    reference_images: list[bytes] | None,
) -> list[bytes] | None:
    from ..playback.illustrations import reference_bytes_for_character

    p = style_dir / f"char_{character_id}.png"
    if p.is_file():
        try:
            return [p.read_bytes()]
        except OSError:
            pass
    return reference_bytes_for_character(character_id, analysis, reference_images)
