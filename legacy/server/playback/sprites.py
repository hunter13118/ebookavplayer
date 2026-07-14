"""Resolve per-line character sprites from the media manifest."""
from __future__ import annotations

import os
from pathlib import Path


def _media_root() -> Path:
    return Path(os.environ.get("DATA_DIR", "./data")) / "media"


def _url_exists(url: str | None) -> bool:
    if not url or not url.startswith("/media/"):
        return False
    return (_media_root() / url.removeprefix("/media/")).is_file()


def resolve_expression_sprite(
    character_id: str,
    expression: str | None,
    media: dict | None,
) -> str | None:
    """URL for char expression variant, or None."""
    if not media or not character_id or not expression:
        return None
    expr = (expression or "normal").lower().strip()
    if expr in ("", "normal"):
        return None
    expressions = media.get("expressions") or {}
    key = f"{character_id}:{expr}"
    url = expressions.get(key)
    if url and _url_exists(url):
        return url
    return None


def resolve_line_sprite(
    character_id: str,
    expression: str | None,
    media: dict | None,
    default_sprite: str,
) -> str:
    variant = resolve_expression_sprite(character_id, expression, media)
    if variant:
        return variant
    if default_sprite and (
        not default_sprite.startswith("/media/") or _url_exists(default_sprite)
    ):
        return default_sprite
    return default_sprite
