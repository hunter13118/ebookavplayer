"""Expression sprite variants + situational visual inserts from analysis."""
from __future__ import annotations

from ..analyze.schema import BookAnalysis
from ..audio.voice_expression import infer_expression_from_text, normalize_expression

# Visual expressions worth a distinct portrait (audio-only normal skipped).
EXPRESSION_VARIANTS = frozenset({
    "sad", "angry", "whisper", "yell", "happy", "surprised",
})

EXPRESSION_PROMPTS: dict[str, str] = {
    "sad": "sad wistful expression, downturned eyes, soft melancholy",
    "angry": "angry fierce expression, narrowed eyes, tense jaw",
    "whisper": "quiet secretive expression, softened lips, intent gaze",
    "yell": "shouting intense expression, open mouth, emphatic",
    "happy": "bright happy smile, lively eyes",
    "surprised": "surprised wide eyes, startled expression",
}

INSERT_EXPRESSIONS = frozenset({"yell", "angry", "whisper", "sad"})
MAX_EXPRESSIONS_PER_CHAR = 4


def _line_expression(line) -> str:
    raw = getattr(line, "expression", None)
    if raw and str(raw).strip().lower() not in ("", "normal"):
        return normalize_expression(raw)
    expr, _ = infer_expression_from_text(line.text, line.kind)
    return normalize_expression(expr or "normal")


def collect_character_expressions(analysis: BookAnalysis) -> dict[str, set[str]]:
    """character_id → expression names that need portrait variants."""
    primary = {c.id for c in analysis.characters if c.importance == "primary"}
    out: dict[str, set[str]] = {}
    for scene in analysis.scenes:
        for line in scene.lines:
            cid = line.character_id
            if cid == "narrator" or cid not in primary:
                continue
            expr = _line_expression(line)
            if expr not in EXPRESSION_VARIANTS:
                continue
            out.setdefault(cid, set()).add(expr)
    for cid in list(out):
        ordered = sorted(out[cid], key=lambda e: list(EXPRESSION_VARIANTS).index(e)
                         if e in EXPRESSION_VARIANTS else 99)
        out[cid] = set(ordered[:MAX_EXPRESSIONS_PER_CHAR])
    return out


def expression_prompt_suffix(expression: str) -> str:
    return EXPRESSION_PROMPTS.get(expression, f"{expression} facial expression")
