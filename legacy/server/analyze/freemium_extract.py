"""Free LLM cascade for text extraction (port of IMAGE AND VOICE HANDOFF/freemiumExtract.js).

Falls back across OpenAI-compatible providers when Gemini quota is exhausted.
Chunk sizing targets the smallest context window in the chain (~128k).
"""
from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Callable

import requests

log = logging.getLogger(__name__)

PER_PROVIDER_TIMEOUT_SEC = 90
MAX_CHUNK_TOKENS = int(os.environ.get("EXTRACT_CHUNK_MAX_TOKENS", "24000"))

DEFAULT_CHAIN = ["gemini", "cerebras", "groq", "mistral", "openrouter", "cloudflare"]

_PROVIDER_MODELS = {
    "gemini": "gemini-2.5-flash",
    "cerebras": os.environ.get("CEREBRAS_EXTRACT_MODEL", "gpt-oss-120b"),
    "groq": "llama-3.3-70b-versatile",
    "mistral": "mistral-small-latest",
    "openrouter": "meta-llama/llama-3.3-70b-instruct:free",
    "cloudflare": os.environ.get(
        "CLOUDFLARE_EXTRACT_MODEL", "@cf/meta/llama-3.1-8b-instruct",
    ),
}

_PROVIDER_URLS = {
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
    "cerebras": "https://api.cerebras.ai/v1",
    "groq": "https://api.groq.com/openai/v1",
    "mistral": "https://api.mistral.ai/v1",
    "openrouter": "https://openrouter.ai/api/v1",
}


def estimate_tokens(text: str) -> int:
    return (len(text or "") + 3) // 4


def parse_model_json(raw: str) -> Any:
    """Strip fences / prose wrappers and parse JSON (repair trailing commas once)."""
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("empty model response")
    s = raw.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", s, re.I)
    if fence:
        s = fence.group(1).strip()
    if not (s.startswith("{") or s.startswith("[")):
        first_obj = s.find("{")
        first_arr = s.find("[")
        if first_arr == -1:
            start = first_obj
        elif first_obj == -1:
            start = first_arr
        else:
            start = min(first_obj, first_arr)
        if start != -1:
            last_obj = s.rfind("}")
            last_arr = s.rfind("]")
            end = max(last_obj, last_arr)
            if end > start:
                s = s[start : end + 1]
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        repaired = re.sub(r",(\s*[}\]])", r"\1", s)
        return json.loads(repaired)


def build_chain(prefer_provider: str | None = None) -> list[str]:
    try:
        from ..pipeline.registry import resolved_extract_providers
        base = resolved_extract_providers()
        if prefer_provider:
            if prefer_provider in base:
                return [prefer_provider] + [p for p in base if p != prefer_provider]
            # Book extract pin overrides global disable.
            return [prefer_provider] + [p for p in base if p != prefer_provider]
        return list(base)
    except Exception:
        pass
    if prefer_provider and prefer_provider in _PROVIDER_MODELS:
        return [prefer_provider] + [p for p in DEFAULT_CHAIN if p != prefer_provider]
    return list(DEFAULT_CHAIN)


def _cfg() -> dict[str, str | None]:
    return {
        "gemini": os.environ.get("GEMINI_API_KEY"),
        "cerebras": os.environ.get("CEREBRAS_API_KEY"),
        "groq": os.environ.get("GROQ_API_KEY"),
        "mistral": os.environ.get("MISTRAL_API_KEY"),
        "openrouter": os.environ.get("OPENROUTER_API_KEY"),
        "cloudflare_account": os.environ.get("CLOUDFLARE_ACCOUNT_ID"),
        "cloudflare_token": os.environ.get("CLOUDFLARE_API_TOKEN"),
    }


def _cloudflare_extract(
    *,
    account_id: str | None,
    token: str | None,
    model: str,
    system_prompt: str,
    user_text: str,
) -> dict[str, Any]:
    if not account_id or not token:
        raise RuntimeError("cloudflare: missing account id or token (skipped)")
    url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{model}"
    body = {
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_text},
        ],
        "max_tokens": 8192,
        "temperature": 0.2,
    }
    r = requests.post(
        url,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json=body,
        timeout=PER_PROVIDER_TIMEOUT_SEC,
    )
    if not r.ok:
        raise RuntimeError(f"cloudflare: HTTP {r.status_code} {r.text[:200]}")
    data = r.json()
    if not data.get("success", True) and data.get("errors"):
        raise RuntimeError(f"cloudflare: {data['errors']}")
    result = data.get("result") or {}
    content = result.get("response") or result.get("text") or ""
    if not content and isinstance(result, dict):
        content = result.get("message", {}).get("content", "")
    if not content:
        raise RuntimeError("cloudflare: no content in response")
    parsed = parse_model_json(content)
    return {"provider": "cloudflare", "model": model, "data": parsed}


def _openai_compatible_extract(
    *,
    provider_id: str,
    base_url: str,
    api_key: str | None,
    model: str,
    system_prompt: str,
    user_text: str,
) -> dict[str, Any]:
    if not api_key:
        raise RuntimeError(f"{provider_id}: missing API key (skipped)")
    body: dict[str, Any] = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_text},
        ],
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
    }
    r = requests.post(
        f"{base_url}/chat/completions",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        json=body,
        timeout=PER_PROVIDER_TIMEOUT_SEC,
    )
    if not r.ok:
        raise RuntimeError(f"{provider_id}: HTTP {r.status_code} {r.text[:200]}")
    data = r.json()
    content = (data.get("choices") or [{}])[0].get("message", {}).get("content")
    if not content:
        raise RuntimeError(f"{provider_id}: no content in response")
    parsed = parse_model_json(content)
    return {"provider": provider_id, "model": model, "data": parsed}


def freemium_extract(
    user_text: str,
    *,
    system_prompt: str,
    prefer_provider: str | None = None,
    on_event: Callable[..., None] | None = None,
) -> dict[str, Any]:
    """Try providers in order; return first successful {provider, model, data}."""
    if not (user_text or "").strip():
        raise ValueError("freemium_extract: user_text must be non-empty")
    est = estimate_tokens(user_text)
    if est > MAX_CHUNK_TOKENS:
        log.warning(
            "freemium_extract chunk ~%s tokens exceeds MAX_CHUNK_TOKENS (%s)",
            est, MAX_CHUNK_TOKENS,
        )
    cfg = _cfg()
    chain = build_chain(prefer_provider)
    failures: list[Exception] = []
    for pid in chain:
        try:
            if pid == "cloudflare":
                result = _cloudflare_extract(
                    account_id=cfg.get("cloudflare_account"),
                    token=cfg.get("cloudflare_token"),
                    model=_PROVIDER_MODELS[pid],
                    system_prompt=system_prompt,
                    user_text=user_text,
                )
            else:
                result = _openai_compatible_extract(
                    provider_id=pid,
                    base_url=_PROVIDER_URLS[pid],
                    api_key=cfg.get(pid),
                    model=_PROVIDER_MODELS[pid],
                    system_prompt=system_prompt,
                    user_text=user_text,
                )
            log.info(
                "freemium extract via %s (%s) prefer=%s",
                result["provider"], result["model"], prefer_provider,
            )
            if on_event:
                on_event("freemium_extract_ok", provider=result["provider"], model=result["model"])
            return result
        except Exception as e:
            log.warning("freemium extract %s: %s", pid, e)
            failures.append(e)
            if on_event and len(chain) > 1:
                on_event("freemium_extract_try_next", provider=pid, error=str(e))
    raise RuntimeError(
        f"freemium_extract: all providers failed ({len(failures)} errors)"
    ) from (failures[0] if failures else None)


def chunk_text(text: str, max_tokens: int = MAX_CHUNK_TOKENS) -> list[str]:
    """Split on paragraph / sentence boundaries under max_tokens."""
    if not (text or "").strip():
        return []
    max_chars = max_tokens * 4
    text = text.strip()
    if len(text) <= max_chars:
        return [text]

    paragraphs = re.split(r"\n\s*\n", text)
    chunks: list[str] = []
    current = ""

    def push_current() -> None:
        nonlocal current
        if current.strip():
            chunks.append(current.strip())
        current = ""

    sent_re = re.compile(r"[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$")

    for para in paragraphs:
        candidate = f"{current}\n\n{para}" if current else para
        if len(candidate) <= max_chars:
            current = candidate
            continue
        push_current()
        if len(para) <= max_chars:
            current = para
        else:
            for sent in sent_re.findall(para) or [para]:
                if len(current) + len(sent) <= max_chars:
                    current += sent
                else:
                    push_current()
                    if len(sent) > max_chars:
                        for i in range(0, len(sent), max_chars):
                            chunks.append(sent[i : i + max_chars].strip())
                        current = ""
                    else:
                        current = sent
    push_current()
    return chunks


def merge_analysis_dicts(data_objects: list[dict]) -> dict:
    """Naive merge of per-chunk BookAnalysis-shaped dicts."""
    char_by_id: dict[str, dict] = {}
    scenes: list[dict] = []

    for d in data_objects:
        if not d:
            continue
        for c in d.get("characters") or []:
            cid = (c.get("id") or c.get("name") or "").lower().strip()
            if not cid:
                continue
            if cid not in char_by_id:
                char_by_id[cid] = dict(c)
                char_by_id[cid].setdefault("aliases", [])
            else:
                ex = char_by_id[cid]
                ex["aliases"] = list({
                    *(ex.get("aliases") or []),
                    *(c.get("aliases") or []),
                })
                if len(c.get("description") or "") > len(ex.get("description") or ""):
                    ex["description"] = c["description"]
        for s in d.get("scenes") or []:
            scenes.append(s)

    return {
        "characters": list(char_by_id.values()),
        "scenes": scenes,
    }
