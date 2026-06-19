"""Expression tags → Edge prosody + DSP plan (port of voiceExpression.js)."""
from __future__ import annotations

from typing import Any

ENGINE_CAPS = {
    "edge": {"prosody": True, "expressAs": False, "referenceClips": False},
    "xtts": {"prosody": False, "expressAs": False, "referenceClips": True,
             "samplingKnob": True},
    "azure": {"prosody": True, "expressAs": True, "referenceClips": False},
}

AZURE_STYLE_FOR_EXPRESSION = {
    "whisper": "whispering",
    "yell": "shouting",
    "sad": "sad",
    "angry": "angry",
    "cheerful": "cheerful",
    "normal": None,
}

PROSODY_PRESETS = {
    "normal":  {"rate": "+0%",  "pitch": "+0Hz",  "volume": "+0%"},
    "whisper": {"rate": "-15%", "pitch": "-2Hz",  "volume": "-40%"},
    "yell":    {"rate": "+8%",  "pitch": "+12Hz", "volume": "+40%"},
    "sad":     {"rate": "-12%", "pitch": "-4Hz",  "volume": "-15%"},
    "angry":   {"rate": "+6%",  "pitch": "+6Hz",  "volume": "+20%"},
}

DSP_PRESETS: dict[str, list[dict[str, Any]]] = {
    "normal": [],
    "whisper": [
        {"type": "highpass", "freqHz": 1200},
        {"type": "highshelf", "freqHz": 4000, "gainDb": 6},
        {"type": "gain", "db": -6},
        {"type": "noise_blend", "source": "pink", "level": 0.12, "gatedToEnvelope": True},
    ],
    "yell": [
        {"type": "compressor", "thresholdDb": -18, "ratio": 6, "attackMs": 5, "releaseMs": 80},
        {"type": "saturation", "driveDb": 6},
        {"type": "highshelf", "freqHz": 3000, "gainDb": 4},
        {"type": "gain", "db": 5},
    ],
    "sad": [{"type": "lowpass", "freqHz": 6000}],
    "angry": [{"type": "saturation", "driveDb": 3}],
}

ENVIRONMENT_PRESETS: dict[str, list[dict[str, Any]]] = {
    "open": [],
    "indoor": [{"type": "reverb", "decaySec": 0.4, "wet": 0.15}],
    "hall": [{"type": "reverb", "decaySec": 1.6, "wet": 0.30}],
    "cave": [
        {"type": "delay", "timeMs": 120, "feedback": 0.35, "mix": 0.4},
        {"type": "reverb", "decaySec": 2.4, "wet": 0.40},
    ],
}


def normalize_expression(expr: str | None) -> str:
    if not isinstance(expr, str):
        return "normal"
    e = expr.lower().strip()
    if any(w in e for w in ("whisper", "mutter", "hush")):
        return "whisper"
    if any(w in e for w in ("yell", "shout", "scream")):
        return "yell"
    if any(w in e for w in ("sad", "sob", "weep")):
        return "sad"
    if any(w in e for w in ("angry", "furious", "snarl")):
        return "angry"
    return "normal"


def normalize_environment(env: str | None) -> str:
    if not isinstance(env, str):
        return "open"
    e = env.lower().strip()
    if any(w in e for w in ("cave", "cavern", "tunnel")):
        return "cave"
    if any(w in e for w in ("hall", "cathedral", "chamber")):
        return "hall"
    if any(w in e for w in ("indoor", "room", "inside")):
        return "indoor"
    return "open"


def _clamp01(n: float | None) -> float:
    if not isinstance(n, (int, float)) or n != n:
        return 1.0
    return max(0.0, min(1.0, float(n)))


def _scale_pct(s: str, k: float) -> str:
    if not s.endswith("%"):
        return s
    try:
        v = int(float(s.rstrip("%")) * k)
        return f"{v:+d}%"
    except ValueError:
        return s


def _scale_hz(s: str, k: float) -> str:
    if not s.endswith("Hz"):
        return s
    try:
        v = int(float(s.rstrip("Hz")) * k)
        return f"{v:+d}Hz"
    except ValueError:
        return s


def scale_prosody(preset: dict[str, str], intensity: float) -> dict[str, str]:
    k = _clamp01(intensity)
    return {
        "rate": _scale_pct(preset["rate"], k),
        "pitch": _scale_hz(preset["pitch"], k),
        "volume": _scale_pct(preset["volume"], k),
    }


def scale_dsp(atoms: list[dict[str, Any]], intensity: float) -> list[dict[str, Any]]:
    k = _clamp01(intensity)
    out = []
    for a in atoms:
        b = dict(a)
        for key in ("gainDb", "db", "driveDb"):
            if isinstance(b.get(key), (int, float)):
                b[key] = round(b[key] * k, 2)
        if isinstance(b.get("level"), (int, float)):
            b["level"] = round(b["level"] * k, 3)
        out.append(b)
    return out


def infer_expression_from_text(text: str, kind: str = "dialogue") -> tuple[str, float]:
    """Heuristic when Gemini did not emit expression tags."""
    t = text or ""
    if t.isupper() and len(t) > 4:
        return "yell", 0.9
    if "!!!" in t or t.endswith("!") and len(t) < 80:
        return "yell", 0.75
    if "..." in t or t.startswith("("):
        return "whisper", 0.65
    if kind == "narration":
        return "normal", 0.85
    return "normal", 1.0


def build_expression_plan(tag: dict[str, Any], engine: str = "edge") -> dict[str, Any]:
    if not tag or not str(tag.get("text", "")).strip():
        raise ValueError("build_expression_plan: tag.text must be non-empty")
    expression = normalize_expression(tag.get("expression"))
    environment = normalize_environment(tag.get("environment"))
    intensity = _clamp01(tag.get("intensity"))
    caps = ENGINE_CAPS.get(engine, ENGINE_CAPS["edge"])
    environment_fx = ENVIRONMENT_PRESETS.get(environment, [])

    if engine == "edge":
        return {
            "engine": "edge",
            "text": tag["text"],
            "character": tag.get("character"),
            "expression": expression,
            "intensity": intensity,
            "ssml": scale_prosody(PROSODY_PRESETS.get(expression, PROSODY_PRESETS["normal"]),
                                  intensity),
            "dsp": [
                *scale_dsp(DSP_PRESETS.get(expression, []), intensity),
                *environment_fx,
            ],
            "notes": (
                "Edge cannot do this natively; timbre is reconstructed entirely in DSP."
                if expression in ("whisper", "yell") else "Prosody-only; DSP minimal."
            ),
        }

    if engine == "xtts":
        return {
            "engine": "xtts",
            "text": tag["text"],
            "character": tag.get("character"),
            "expression": expression,
            "intensity": intensity,
            "referenceClipKey": f"{tag.get('character') or 'default'}:{expression}",
            "sampling": {"temperature": round(0.55 + 0.35 * intensity, 2)},
            "dsp": list(environment_fx),
            "notes": "Expression carried by reference clip; DSP only for environment.",
        }

    if engine == "azure":
        style = AZURE_STYLE_FOR_EXPRESSION.get(expression) if caps["expressAs"] else None
        return {
            "engine": "azure",
            "text": tag["text"],
            "character": tag.get("character"),
            "expression": expression,
            "intensity": intensity,
            "expressAs": (
                {"style": style, "styledegree": round(0.5 + 1.5 * intensity, 2)}
                if style else None
            ),
            "ssml": None if style else scale_prosody(
                PROSODY_PRESETS.get(expression, PROSODY_PRESETS["normal"]), intensity),
            "dsp": (
                list(environment_fx) if style else [
                    *scale_dsp(DSP_PRESETS.get(expression, []), intensity),
                    *environment_fx,
                ]
            ),
            "notes": "Native express-as" if style else "Fell back to prosody+DSP.",
        }

    raise ValueError(f"build_expression_plan: unknown engine {engine!r}")
