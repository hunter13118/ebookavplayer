"""Line-attribution heuristics for custom vs stock character sprites."""
from __future__ import annotations

import hashlib
import os

from ..analyze.schema import AnalysisCharacter, BookAnalysis


def count_character_lines(analysis: BookAnalysis) -> dict[str, int]:
    """Dialogue + thought lines per character (excludes narrator narration)."""
    counts: dict[str, int] = {}
    for scene in analysis.scenes:
        for line in scene.lines:
            cid = line.character_id
            if not cid or cid == "narrator":
                continue
            kind = (line.kind or "dialogue").lower()
            if kind == "narration":
                continue
            counts[cid] = counts.get(cid, 0) + 1
    return counts


def _thresholds() -> tuple[int, float]:
    min_lines = int(os.environ.get("VAE_CUSTOM_SPRITE_MIN_LINES", "3"))
    min_share = float(os.environ.get("VAE_CUSTOM_SPRITE_MIN_SHARE", "0.015"))
    return min_lines, min_share


def use_stock_sprite(
    character: AnalysisCharacter,
    line_count: int,
    total_attributed: int,
) -> bool:
    """True when a side character should pull from the generic stock pool."""
    min_lines, min_share = _thresholds()
    imp = (character.importance or "secondary").lower()
    if imp == "background":
        return True
    if imp == "primary" and line_count >= min_lines:
        return False
    if line_count < min_lines:
        return True
    if total_attributed >= 20 and line_count / total_attributed < min_share:
        return True
    return False


def plan_character_sprites(
    analysis: BookAnalysis,
    *,
    force_all: bool = False,
) -> tuple[list[str], list[str]]:
    """(characters_to_generate, characters_from_stock) character ids."""
    if force_all:
        return [c.id for c in analysis.characters if c.id and c.id != "narrator"], []

    line_counts = count_character_lines(analysis)
    total = sum(line_counts.values())
    to_gen: list[str] = []
    stock: list[str] = []
    for c in analysis.characters:
        if not c.id or c.id == "narrator":
            continue
        n = line_counts.get(c.id, 0)
        if use_stock_sprite(c, n, total):
            stock.append(c.id)
        else:
            to_gen.append(c.id)
    return to_gen, stock


def stock_sprite_url(character_id: str, gender: str) -> str:
    """Deterministic pick from the generic gendered stock pool."""
    pool = os.environ.get("STOCK_POOL_SIZE", "12")
    n = int(pool) if pool.isdigit() else 12
    h = int(hashlib.sha1(character_id.encode()).hexdigest(), 16) % n
    g = (gender or "n")[0].lower()
    return f"/media/stock/{g}{h:02d}.png"
