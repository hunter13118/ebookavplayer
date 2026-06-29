#!/usr/bin/env python3
"""One-shot smoke test: each freemium image + extract provider in isolation."""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv

load_dotenv(ROOT / ".env")

OUT = ROOT / "smoke_out" / "freemium_probe"
OUT.mkdir(parents=True, exist_ok=True)

IMAGE_PROVIDERS = [
    "cloudflare",
    "pollinations-seed",
    "pollinations-anon",
    "huggingface",
]
EXTRACT_PROVIDERS = ["gemini", "cerebras", "groq", "mistral", "openrouter"]

IMAGE_TASK = "a small blue owl perched on a book, simple test illustration"
EXTRACT_SYSTEM = (
    "You extract structured metadata from fiction snippets. "
    "Respond with JSON only: {\"title\": string, \"protagonist\": string, \"mood\": string}."
)
EXTRACT_USER = (
    "Snippet: In the mist above Silver Gate, Mira clutched her lantern while the wind "
    "howled through the broken arch. She had one night to find the key."
)


def ext(name: str) -> str:
    return {"jpeg": ".jpg", "jpg": ".jpg", "png": ".png"}.get(name.split("/")[-1], ".bin")


def test_images() -> list[dict]:
    from server.images.freemium import (
        _PROVIDER_FUNCS,
        _cfg,
        compose_prompt,
        freemium_image_gen,
    )

    prompt = compose_prompt(IMAGE_TASK, subject_type="character", style="neutral")
    cfg = _cfg()
    rows = []
    for pid in IMAGE_PROVIDERS:
        t0 = time.perf_counter()
        row = {"provider": pid, "ok": False, "isolated": True}
        fn = _PROVIDER_FUNCS[pid]
        expected_model = {
            "cloudflare": "flux-1-schnell (@cf/black-forest-labs/flux-1-schnell)",
            "pollinations-seed": "flux",
            "pollinations-anon": "flux",
            "huggingface": "black-forest-labs/FLUX.1-schnell",
        }[pid]
        row["configured_model"] = expected_model
        try:
            r = fn(prompt, 42, cfg)
            ct = r.get("content_type") or "image/jpeg"
            suffix = ext(ct)
            path = OUT / f"image_{pid}{suffix}"
            path.write_bytes(r["bytes"])
            row.update(
                {
                    "ok": True,
                    "model": r["model"],
                    "bytes": len(r["bytes"]),
                    "content_type": ct,
                    "saved": str(path.relative_to(ROOT)),
                    "elapsed_s": round(time.perf_counter() - t0, 2),
                }
            )
        except Exception as e:
            row["error"] = str(e)[:240]
            row["elapsed_s"] = round(time.perf_counter() - t0, 2)
        rows.append(row)

    # Also show cascade pick (character chain default)
    t0 = time.perf_counter()
    cascade_row = {"provider": "cascade (character chain)", "ok": False, "isolated": False}
    try:
        r = freemium_image_gen(IMAGE_TASK, subject_type="character", style="neutral", seed=42)
        cascade_row.update(
            {
                "ok": True,
                "winner": r["provider"],
                "model": r["model"],
                "bytes": len(r["bytes"]),
                "elapsed_s": round(time.perf_counter() - t0, 2),
            }
        )
    except Exception as e:
        cascade_row["error"] = str(e)[:240]
        cascade_row["elapsed_s"] = round(time.perf_counter() - t0, 2)
    rows.append(cascade_row)
    return rows


def test_extracts() -> list[dict]:
    from server.analyze.freemium_extract import (
        _PROVIDER_MODELS,
        _PROVIDER_URLS,
        _cfg,
        _openai_compatible_extract,
        freemium_extract,
    )

    rows = []
    cfg = _cfg()
    for pid in EXTRACT_PROVIDERS:
        t0 = time.perf_counter()
        row = {
            "provider": pid,
            "configured_model": _PROVIDER_MODELS[pid],
            "ok": False,
            "isolated": True,
        }
        try:
            r = _openai_compatible_extract(
                provider_id=pid,
                base_url=_PROVIDER_URLS[pid],
                api_key=cfg.get(pid),
                model=_PROVIDER_MODELS[pid],
                system_prompt=EXTRACT_SYSTEM,
                user_text=EXTRACT_USER,
            )
            row.update(
                {
                    "ok": True,
                    "model": r["model"],
                    "data": r["data"],
                    "elapsed_s": round(time.perf_counter() - t0, 2),
                }
            )
        except Exception as e:
            row["error"] = str(e)[:240]
            row["elapsed_s"] = round(time.perf_counter() - t0, 2)
        rows.append(row)

    t0 = time.perf_counter()
    cascade_row = {"provider": "cascade (default chain)", "ok": False, "isolated": False}
    try:
        r = freemium_extract(EXTRACT_USER, system_prompt=EXTRACT_SYSTEM)
        cascade_row.update(
            {
                "ok": True,
                "winner": r["provider"],
                "model": r["model"],
                "data": r["data"],
                "elapsed_s": round(time.perf_counter() - t0, 2),
            }
        )
    except Exception as e:
        cascade_row["error"] = str(e)[:240]
        cascade_row["elapsed_s"] = round(time.perf_counter() - t0, 2)
    rows.append(cascade_row)
    return rows


def main() -> None:
    print("=== FREEMIUM IMAGE PROVIDERS ===")
    print(f"Task: {IMAGE_TASK}\n")
    for row in test_images():
        print(json.dumps(row, indent=2))
        print()

    print("=== FREEMIUM EXTRACT PROVIDERS ===")
    print(f"Task: extract title/protagonist/mood from snippet\n")
    for row in test_extracts():
        print(json.dumps(row, indent=2))
        print()


if __name__ == "__main__":
    main()
