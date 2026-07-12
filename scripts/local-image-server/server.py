"""
Local Stable Diffusion adapter server for VAE's `local_sd` image-freemium tier.

Implements the contract the worker already expects (see
worker/_shared/freemium-image.js's tryLocalSd and
server/images/backends.py's _try_local_http):

    POST /generate
    body: {"prompt": str, "width"?: int, "height"?: int, "model"?: str}
    -> 200, Content-Type: image/png, raw PNG bytes

Plus two extras beyond that contract, for local dev/benchmarking:

    GET  /models
    -> {"default": str, "profiles": {id: {repo_id, steps, guidance_scale, loaded}}}

    POST /generate_batch
    body: {"prompts": [str, ...], "width"?: int, "height"?: int, "model"?: str}
    -> {"images": [base64 PNG, ...], "count": int, "elapsed_sec": float, "model": str}

    This is REAL batched diffusion — one pipe() call with prompt=[list],
    every image in the batch decodes the same fixed step count together as
    one tensor op. Unlike autoregressive LLM decode (see Ollama benchmark in
    docs/LOCAL_LLM_EXTRACTION.md, where concurrent requests fought each other
    for the same compute with no net gain), diffusion steps are synchronized
    across the whole batch, so this is architecturally suited to real
    throughput gains from batching. Use this endpoint to find out, per model,
    per this machine — don't assume.

Three model profiles (pick via LOCAL_IMAGE_MODEL env or per-request "model"):

  sdxl-turbo     stabilityai/sdxl-turbo — 2 steps, guidance 0.0. Fastest, but
                 turbo's guidance-free distillation removes negative-prompt
                 steering entirely, and SDXL's base training skews
                 photorealistic — the combination produces an uncanny
                 "realistic but wrong" look on stylized/anime prompts.
  animagine-xl   cagliostrolab/animagine-xl-3.1 — SDXL architecture but
                 anime-native training. Much better anime fidelity, no turbo
                 distillation available, so full step count (~28) and real
                 CFG/negative-prompt steering — slower per image.
  sd15-anime-lcm An anime-native SD1.5 checkpoint + the official LCM-LoRA,
                 aiming for anime fidelity AND turbo-like speed (4-8 steps).

Auto-detects the compute backend at startup: CUDA (NVIDIA) > MPS (Apple
Silicon Metal) > CPU, in that order. Override with LOCAL_IMAGE_DEVICE if the
auto-pick guesses wrong.

Run:  source .venv/bin/activate && python scripts/local-image-server/server.py
Then: set LOCAL_IMAGE_URL=http://127.0.0.1:7860 in .env (worker appends /generate).
"""
from __future__ import annotations

import base64
import io
import itertools
import logging
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import torch
from diffusers import AutoPipelineForText2Image, LCMScheduler, StableDiffusionPipeline
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from PIL import Image
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("local-image-server")


def detect_device() -> tuple[str, str]:
    """Pick the best backend: CUDA (NVIDIA) > MPS (Apple Metal) > CPU.

    Returns (device, reason) so startup logs can show whether the choice
    came from an explicit override or auto-detection — useful when a box
    has more than one backend compiled in and picks the "wrong" one.
    """
    override = os.environ.get("LOCAL_IMAGE_DEVICE", "").strip().lower()
    if override in ("cuda", "mps", "cpu"):
        return override, "LOCAL_IMAGE_DEVICE override"
    if torch.cuda.is_available():
        return "cuda", f"auto-detected ({torch.cuda.get_device_name(0)})"
    if torch.backends.mps.is_available():
        return "mps", "auto-detected (Apple Silicon Metal)"
    return "cpu", "auto-detected (no CUDA/MPS found — will be slow)"


DEVICE, DEVICE_REASON = detect_device()
USE_HALF_PRECISION = DEVICE in ("cuda", "mps")

# "multiple views, character sheet, turnaround, grid, collage, multiple
# people, split screen, comic panel" added after observing a real, repeated
# failure mode on character portraits: the model occasionally tiles several
# small faces into one image instead of a single centered portrait (a
# classic SDXL "character sheet" artifact, most common on prompts without an
# explicit reference image conditioning it toward one subject). Confirmed
# live on two different characters (no shared prompt content beyond the
# standard portrait framing) — this is stochastic, not deterministic per
# character, so it won't eliminate bad generations entirely, just reduce
# their rate. A bad output still needs a manual regen/reject via the compare
# modal's "Keep previous" button.
_ANIME_NEGATIVE_PROMPT = (
    "lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, "
    "fewer digits, cropped, worst quality, low quality, normal quality, "
    "jpeg artifacts, signature, watermark, blurry, "
    "multiple views, character sheet, turnaround, reference sheet, grid, "
    "collage, tiled, multiple people, multiple faces, split screen, comic panel, "
    "duplicate, clone, two heads, "
    # Reinforces the positive aesthetic-boost tags the worker now prepends to
    # character portraits (freemium-image.js's CHARACTER_AESTHETIC_BOOST) —
    # a positive "beautiful/gorgeous" tag alone doesn't stop the base model
    # from still landing on a plain or asymmetrical face; the matching
    # negative term does more of the actual work on a booru-tag model.
    "asymmetrical face, unattractive, plain looking, dull eyes, deformed face"
)

# Mirrors server/images/expression_sprites.py exactly — this endpoint is the
# local-generation backend that dormant module never had. Keep these two in
# sync; don't fork the taxonomy.
EXPRESSION_PROMPTS: dict[str, str] = {
    "sad": "sad wistful expression, downturned eyes, soft melancholy",
    "angry": "angry fierce expression, narrowed eyes, tense jaw",
    "whisper": "quiet secretive expression, softened lips, intent gaze",
    "yell": "shouting intense expression, open mouth, emphatic",
    "happy": "bright happy smile, lively eyes",
    "surprised": "surprised wide eyes, startled expression",
}


@dataclass
class ModelProfile:
    id: str
    repo_id: str
    pipeline_cls: str  # "sdxl" | "sd15"
    steps: int
    guidance_scale: float
    default_width: int
    default_height: int
    negative_prompt: str = ""
    lora_repo: str | None = None
    scheduler: str | None = None  # None = pipeline default
    has_fp16_variant: bool = True  # False for repos that don't publish a separate fp16 variant
    max_batch_size: int = 4  # empirically verified safe on MPS — see docs/LOCAL_LLM_EXTRACTION.md.
    # MPS hard-crashes the WHOLE PROCESS (native Metal assertion, unrecoverable
    # in Python) if any single intermediate tensor exceeds 4GB — this isn't a
    # graceful OOM. Rather than rediscover that the hard way per model, this
    # caps /generate_batch below the largest size actually tested per profile.
    ip_adapter_repo: str | None = None  # set to enable reference-image conditioning
    ip_adapter_subfolder: str | None = None
    ip_adapter_weight_name: str | None = None
    default_ip_adapter_scale: float = 0.6
    # Positive-prompt tokens prepended ONLY on the single-character portrait
    # path (see _generate_with_retry). Booru-tag-trained models (animagine)
    # need the literal `solo` tag to suppress the character-sheet grid — prose
    # framing alone doesn't. Empty = leave the caller's prompt untouched.
    portrait_prompt_prefix: str = ""


PROFILES: dict[str, ModelProfile] = {
    "sdxl-turbo": ModelProfile(
        id="sdxl-turbo",
        repo_id="stabilityai/sdxl-turbo",
        pipeline_cls="sdxl",
        steps=2,
        guidance_scale=0.0,
        default_width=768,
        default_height=1024,
        max_batch_size=8,  # verified: works, though throughput gets WORSE per batch (see docs) — not a crash risk
    ),
    "animagine-xl": ModelProfile(
        id="animagine-xl",
        repo_id="cagliostrolab/animagine-xl-3.1",
        pipeline_cls="sdxl",
        steps=28,
        guidance_scale=7.0,
        default_width=832,
        default_height=1216,
        negative_prompt=_ANIME_NEGATIVE_PROMPT,
        has_fp16_variant=False,
        max_batch_size=2,  # unverified above 2 — highest resolution of the three, conservative until tested
        ip_adapter_repo="h94/IP-Adapter",
        ip_adapter_subfolder="sdxl_models",
        ip_adapter_weight_name="ip-adapter_sdxl.bin",
        # Lowered from 0.6 (2026-07-10): confirmed live that any character
        # WITH a reference image (IP-Adapter engaged) had a high rate of a
        # severe "character sheet" artifact — a tiled grid of duplicate faces
        # (up to 15 in one case) — while every reference-free character
        # generated cleanly, every time. This is IP-Adapter's well-documented
        # over-conditioning failure mode: at high scale on a tall portrait
        # canvas (832x1216) it can push the base UNet to replicate the
        # reference's framing across the whole canvas instead of just
        # steering identity/style. Negative-prompt terms alone
        # (character sheet, grid, duplicate, etc.) did not fix this — the
        # conditioning strength itself needed to come down.
        default_ip_adapter_scale=0.35,
        # The positive-prompt counterpart to _ANIME_NEGATIVE_PROMPT's grid
        # terms. animagine-xl-3.1 is Danbooru-tag-trained, so it steers far
        # harder on the tag `solo` ("exactly one character in frame") than on
        # the worker's prose framing ("single character, one person only").
        # Confirmed root cause of the persistent Anne grid: the prose never
        # carried the one tag this model actually understands. `upper body`
        # reinforces the head-and-shoulders crop the worker asks for.
        portrait_prompt_prefix="solo, upper body, ",
    ),
    "sd15-anime-lcm": ModelProfile(
        id="sd15-anime-lcm",
        repo_id="gsdf/Counterfeit-V2.5",
        pipeline_cls="sd15",
        steps=6,
        guidance_scale=1.5,
        default_width=512,
        default_height=768,
        negative_prompt=_ANIME_NEGATIVE_PROMPT,
        lora_repo="latent-consistency/lcm-lora-sdv1-5",
        scheduler="lcm",
        max_batch_size=4,  # verified: batch=8 crashes the whole process (MPS >4GB single-tensor assertion)
        ip_adapter_repo="h94/IP-Adapter",
        ip_adapter_subfolder="models",  # SD1.5 weights live under "models/", not "sdxl_models/"
        ip_adapter_weight_name="ip-adapter_sd15.bin",
    ),
}

DEFAULT_PROFILE_ID = os.environ.get("LOCAL_IMAGE_MODEL", "sdxl-turbo")
if DEFAULT_PROFILE_ID not in PROFILES:
    raise ValueError(
        f"LOCAL_IMAGE_MODEL={DEFAULT_PROFILE_ID!r} is not a known profile "
        f"({', '.join(PROFILES)})"
    )

app = FastAPI()
_PIPES: dict[str, object] = {}  # profile id -> loaded pipeline, cached across requests

# Every /generate-family route is a sync `def`, which FastAPI/Starlette runs
# in a thread-pool worker — so two concurrent HTTP requests for the same
# profile really can call pipe() on the SAME cached pipeline object from two
# different threads at once. Confirmed live, twice this session: overlapping
# calls corrupt the scheduler's internal step_index (diffusers schedulers
# aren't reentrant), surfacing as an unrelated-looking crash on whichever
# request loses the race: "IndexError: index 29 is out of bounds for
# dimension 0 with size 29" in scheduling_euler_ancestral_discrete.py. A
# single device (MPS here) has nothing to gain from "concurrent" generation
# anyway — it's one GPU either way — so serializing every pipe() call behind
# one global lock is a pure correctness fix with no real throughput cost.
_PIPE_LOCK = threading.Lock()


def _profile_for(model_id: str | None) -> ModelProfile:
    pid = model_id or DEFAULT_PROFILE_ID
    profile = PROFILES.get(pid)
    if profile is None:
        raise HTTPException(400, f"unknown model {pid!r} (known: {', '.join(PROFILES)})")
    return profile


def _load_pipeline(profile: ModelProfile):
    if profile.id in _PIPES:
        return _PIPES[profile.id]

    log.info("loading %s (%s) on %s (this downloads the model on first run)...",
              profile.id, profile.repo_id, DEVICE)
    dtype = torch.float16 if USE_HALF_PRECISION else torch.float32

    if profile.pipeline_cls == "sdxl":
        pipe = AutoPipelineForText2Image.from_pretrained(
            profile.repo_id,
            torch_dtype=dtype,
            variant="fp16" if (USE_HALF_PRECISION and profile.has_fp16_variant) else None,
        )
    elif profile.pipeline_cls == "sd15":
        pipe = StableDiffusionPipeline.from_pretrained(
            profile.repo_id,
            torch_dtype=dtype,
            safety_checker=None,
        )
    else:
        raise ValueError(f"unknown pipeline_cls {profile.pipeline_cls!r}")

    if profile.lora_repo:
        pipe.load_lora_weights(profile.lora_repo)
    if profile.scheduler == "lcm":
        pipe.scheduler = LCMScheduler.from_config(pipe.scheduler.config)

    pipe = pipe.to(DEVICE)

    if profile.ip_adapter_repo:
        log.info("[%s] loading IP-Adapter %s/%s/%s for reference-image conditioning...",
                  profile.id, profile.ip_adapter_repo, profile.ip_adapter_subfolder,
                  profile.ip_adapter_weight_name)
        pipe.load_ip_adapter(
            profile.ip_adapter_repo,
            subfolder=profile.ip_adapter_subfolder,
            weight_name=profile.ip_adapter_weight_name,
        )
        pipe.set_ip_adapter_scale(profile.default_ip_adapter_scale)

    _PIPES[profile.id] = pipe
    log.info("%s loaded, ready to generate", profile.id)
    return pipe


def _clamp_dims(width: int, height: int) -> tuple[int, int]:
    # SDXL/SD1.5 VAEs downsample by 8x — dims must be multiples of 8.
    return width - width % 8, height - height % 8


# Once load_ip_adapter() runs on a pipe (see _load_pipeline — happens
# unconditionally for any profile with ip_adapter_repo set, not per-request),
# diffusers permanently wires the UNet's encoder_hid_dim_type to
# 'ip_image_proj': every subsequent forward pass on that pipe object requires
# an `image_embeds`-producing ip_adapter_image, even for a request that never
# asked for reference conditioning. Skipping the kwarg (the old behavior)
# crashes with "requires the keyword argument `image_embeds`" — this bit a
# real run where some characters had a cropped reference and others didn't,
# processed back-to-back against the same cached pipe (see
# docs/LOCAL_IMAGE_GEN.md). Fix: always pass an ip_adapter_image on an
# IP-Adapter-loaded pipe — a real reference when we have one, otherwise a
# flat neutral gray placeholder at scale 0.0 (zero visual influence, purely
# satisfies the structural requirement).
_NEUTRAL_IP_IMAGE = Image.new("RGB", (224, 224), (128, 128, 128))


def _run(pipe, profile: ModelProfile, prompts: list[str], width: int, height: int,
         reference_image=None):
    kwargs = dict(
        prompt=prompts,
        num_inference_steps=profile.steps,
        guidance_scale=profile.guidance_scale,
        width=width,
        height=height,
    )
    if profile.negative_prompt:
        kwargs["negative_prompt"] = [profile.negative_prompt] * len(prompts)
    if profile.ip_adapter_repo:
        kwargs["ip_adapter_image"] = reference_image if reference_image is not None else _NEUTRAL_IP_IMAGE
    with _PIPE_LOCK:
        return pipe(**kwargs).images


@app.on_event("startup")
def load_default_pipeline():
    log.info("device=%s (%s)", DEVICE, DEVICE_REASON)
    _load_pipeline(PROFILES[DEFAULT_PROFILE_ID])


class GenerateRequest(BaseModel):
    prompt: str
    width: int | None = None
    height: int | None = None
    out_hint: str | None = None  # accepted for legacy-backend compat, unused
    model: str | None = None
    reference_image_b64: str | None = None  # IP-Adapter conditioning — model must set ip_adapter_repo
    ip_adapter_scale: float | None = None  # 0-1; overrides profile.default_ip_adapter_scale for this call
    # Manual override for /generate's _looks_like_grid reference-rejection
    # guard (see that guard's docstring) — the grid classifier is a
    # heuristic, not infallible, and a user who's LOOKED at their
    # character's current image and confirmed it's actually fine (a false
    # positive) needs a way to force it through rather than being silently
    # overruled with no recourse. Also useful when someone genuinely wants
    # continuity with a known-imperfect image over the auto-guard's judgment.
    force_reference: bool = False


class BatchGenerateRequest(BaseModel):
    prompts: list[str]
    width: int | None = None
    height: int | None = None
    model: str | None = None


class CropFacesRequest(BaseModel):
    image_b64: str  # the raw scene/plate to crop (e.g. an EPUB illustration)
    max_faces: int | None = None  # cap the number of crops returned, left-to-right


class OcrFacesRequest(BaseModel):
    image_b64: str  # a plate that may have character names captioned on it


class ExpressionSetRequest(BaseModel):
    character_description: str  # e.g. "Elara: red-haired blacksmith adventurer, dark leather armor"
    reference_image_b64: str  # ideally the baseline portrait, not the raw EPUB source — see docs
    expressions: list[str] | None = None  # default: all of EXPRESSION_PROMPTS
    model: str | None = None
    ip_adapter_scale: float | None = None  # default 0.85 here, higher than the freeform-scene default
    width: int | None = None
    height: int | None = None


@app.get("/health")
def health():
    return {
        "status": "ok",
        "default_model": DEFAULT_PROFILE_ID,
        "device": DEVICE,
        "device_reason": DEVICE_REASON,
        "ready": DEFAULT_PROFILE_ID in _PIPES,
    }


@app.get("/models")
def models():
    return {
        "default": DEFAULT_PROFILE_ID,
        "profiles": {
            pid: {
                "repo_id": p.repo_id,
                "steps": p.steps,
                "guidance_scale": p.guidance_scale,
                "default_width": p.default_width,
                "default_height": p.default_height,
                "loaded": pid in _PIPES,
            }
            for pid, p in PROFILES.items()
        },
    }


MAX_MULTI_FACE_RETRIES = 2  # total attempts = this + 1


def _face_count(pil_image) -> int | None:
    """Run the same anime-face cascade used for cropping against a
    freshly-generated portrait, as a quality gate — returns None (skip the
    check) if the cascade itself isn't available for any reason, never
    raises. Only >1 is treated as a problem (see _generate_with_retry) since
    0 just means the cascade didn't confidently recognize the art style/
    framing, which isn't evidence of the actual failure mode being guarded
    against.

    Uses lower min_neighbors/min_size than the crop-detection default — a
    false positive here just costs one extra ~90s regeneration attempt,
    cheap next to shipping a broken grid artifact, so it's worth trading
    precision for recall (unlike cropping, where a false positive wastes
    storage and clutters the crop catalog).

    Confirmed unreliable on its own, live: this whole-image count
    under-detects badly on real "character sheet" grids (an 8-tile grid
    scored "faces=1"), because detectMultiScale suppresses overlapping/
    adjacent boxes and wasn't trained on tightly-cropped grid tiles. Kept as
    a cheap first pass — see _looks_like_grid for the check that actually
    catches what this misses.
    """
    try:
        from detect_and_crop_faces import detect_faces_from_bytes
        buf = io.BytesIO()
        pil_image.save(buf, format="PNG")
        _, faces = detect_faces_from_bytes(buf.getvalue(), min_neighbors=2, min_size=24)
        return len(faces)
    except Exception:
        return None


_GRID_QA_SYSTEM_PROMPT = (
    "You are a strict image QA classifier for AI-generated anime character "
    "portraits. You will be shown one generated image that was SUPPOSED to be "
    "a single upper-body portrait of one character. Sometimes the generation "
    "fails and instead produces a tiled grid / contact-sheet / collage of "
    "many small repeated face variations (a \"character sheet\" artifact), "
    "which is a defect. Respond with JSON only: "
    "{\"is_grid\": true|false, \"reason\": \"short explanation\"}. "
    "is_grid=true means the image shows multiple repeated/tiled face crops "
    "arranged in a grid rather than one single coherent portrait."
)


def _looks_like_grid(pil_image) -> bool:
    """Second-pass quality check via the local Ollama vision model (same
    gemma3:27b already used for plate-to-character matching — see
    worker/_shared/illustration-character-match.js's ollamaVisionMatch).

    Replaced an earlier attempt at a pixel-only detector (per-cell face
    cascade, then row/column edge-projection periodicity) — both failed on
    real examples: the cascade has poor recall on tightly-cropped grid
    tiles (an 8-tile grid detected faces in just 1/9 cells), and edge
    projection was inconsistent across grids with different tile
    backgrounds (real broken examples: Diana's 3x3 grid had a clean
    periodic signal, but Helen's 3x3 and Anne's 5x3 grids didn't — passing
    strict all-boundaries-strong thresholds on one and failing on the
    other). This is a genuinely semantic "does this look like a grid of
    faces" judgment, which is exactly what a vision LLM is good at and
    pixel heuristics aren't — validated against all 6 real captured
    examples (4 known-broken grids, 2 known-clean portraits) with zero
    misclassifications before wiring this in.

    Fails open (returns False, same spirit as _face_count) if Ollama is
    unreachable or returns something unparseable — a missed grid ships one
    bad image; a hard failure here would break generation entirely for
    dev environments without Ollama running.
    """
    try:
        import json
        import urllib.request

        base = (os.environ.get("OLLAMA_BASE_URL") or "http://localhost:11434").rstrip("/")
        model = os.environ.get("OLLAMA_MODEL_VISION") or "gemma3:27b"
        buf = io.BytesIO()
        pil_image.save(buf, format="PNG")
        img_b64 = base64.b64encode(buf.getvalue()).decode()
        body = json.dumps({
            "model": model,
            "messages": [
                {"role": "system", "content": _GRID_QA_SYSTEM_PROMPT},
                {"role": "user", "content": "Classify this image.", "images": [img_b64]},
            ],
            "format": "json",
            "stream": False,
            "think": False,
            "options": {"temperature": 0},
        }).encode()
        req = urllib.request.Request(
            f"{base}/api/chat", data=body, headers={"content-type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.load(resp)
        verdict = json.loads(data["message"]["content"])
        return bool(verdict.get("is_grid"))
    except Exception:
        return False


_ATTEMPTS_DIR = Path(__file__).resolve().parent / "debug" / "attempts"
_ATTEMPT_SEQ = itertools.count(1)  # next() is atomic under CPython's GIL


def _save_attempt_image(image, profile, prompt, attempt, total, faces, grid):
    """Persist one retry attempt's raw generation so a failing character can
    be inspected frame-by-frame — the retry loop otherwise discards every
    rejected attempt in memory, leaving nothing to look at after a run. Files
    land in scripts/local-image-server/debug/attempts/ (gitignored) named
    <epoch>_<seq>_<model>_<slug>_attemptNofM_<verdict>.png so a whole failing
    job sorts chronologically. On by default; set SAVE_RETRY_ATTEMPTS=0 to
    skip the disk writes. Best-effort: a debug-write failure never breaks a
    real generation. Returns the saved path (str) or None."""
    if os.environ.get("SAVE_RETRY_ATTEMPTS", "1") == "0":
        return None
    try:
        _ATTEMPTS_DIR.mkdir(parents=True, exist_ok=True)
        slug = "".join(c if c.isalnum() else "-" for c in prompt[:40]).strip("-").lower() or "prompt"
        verdict = "grid" if grid else (f"faces{faces}" if (faces or 0) > 1 else "clean")
        seq = next(_ATTEMPT_SEQ)
        name = f"{int(time.time())}_{seq:04d}_{profile.id}_{slug}_attempt{attempt}of{total}_{verdict}.png"
        path = _ATTEMPTS_DIR / name
        image.save(path)
        return str(path)
    except Exception:
        return None


class GenerationQualityError(RuntimeError):
    """Every retry attempt still showed the character-sheet grid artifact —
    see _generate_with_retry's docstring for why this raises instead of
    shipping the last attempt."""


def _generate_with_retry(pipe, profile, prompt, width, height, reference_image=None, check_quality=None):
    """Generate, then check the output for the "character sheet" tiled-grid
    artifact (see detect_and_crop_faces.py's _crop_is_text_heavy docstring
    for the full story) and retry if found. Confirmed live: this artifact
    reproduces on some character descriptions at a real, non-trivial rate
    even after negative-prompt and IP-Adapter-scale mitigations. A face
    count >1 in the whole-image cascade (_face_count) is a cheap first
    signal, but confirmed unreliable alone — it under-counts real grids
    badly, so a still-broken image can score faces<=1 and slip through.
    _looks_like_grid (per-cell tiled detection) is the check that actually
    catches those; both must pass clean for an attempt to be accepted.

    Bounded: at most MAX_MULTI_FACE_RETRIES extra attempts. If every one of
    them is still flagged broken, this RAISES GenerationQualityError instead
    of returning the last (still-broken) attempt. That used to be
    "best-effort — always return something, diffusion is stochastic, never
    hang a request" — reversed after confirmed live: a specific character
    ("Anne") reliably produced a 15-tile grid on EVERY one of 3 attempts,
    twice in a row across separate regen jobs, and the old behavior shipped
    that straight to the user as their character's committed portrait. The
    caller (/generate) turns this into an HTTP error, which the worker's
    existing provider-fallback chain (freemium-image.js's generateImage)
    already knows how to handle — falling through to the next configured
    provider — so a stubborn character now gets a chance at a DIFFERENT
    generation path instead of a guaranteed-bad image with no error at all.
    Never hangs indefinitely either way: the attempt count is still capped.

    check_quality controls whether the retry loop runs at all — defaults to
    `reference_image is not None` if left unset, but callers that reject a
    bad reference (see /generate's _looks_like_grid guard) MUST pass
    check_quality=True explicitly even though reference_image ends up None.
    Confirmed live: gating purely on "is reference_image set" broke exactly
    the case that needed this most — a character portrait whose reference
    got rejected as a broken grid still needs the OUTPUT checked, because
    animagine-xl has its own base-model tendency toward multi-character
    "character sheet" compositions independent of IP-Adapter (this
    manifested as a 5-face "queen and four attendants" illustration on a
    fully unconditioned generation). The original scoping intent stands for
    the actual distinguishing case — backgrounds/scenes/covers, which never
    send reference_image_b64 in the first place and can have legitimate
    repeating structure (windows, shelving) a grid check has no business
    judging — those still correctly skip via the default.
    """
    if check_quality is None:
        check_quality = reference_image is not None
    if not check_quality:
        return _run(pipe, profile, [prompt], width, height, reference_image=reference_image)[0]

    # Positive-prompt half of the anti-grid mitigation, applied ONLY here on
    # the single-character portrait path — scenes/backgrounds reach _run
    # directly (check_quality is False) and legitimately contain multiple
    # subjects, so they must not get `solo`. Booru-tag models need the literal
    # tag; the worker's prose framing alone let Anne grid on every attempt.
    # Prepend once, and don't double it if a caller already led with it.
    prefix = profile.portrait_prompt_prefix
    if prefix and not prompt.lstrip().lower().startswith(prefix.strip().lower()):
        prompt = prefix + prompt

    total = MAX_MULTI_FACE_RETRIES + 1
    image = None
    for attempt in range(total):
        t0 = time.time()
        image = _run(pipe, profile, [prompt], width, height, reference_image=reference_image)[0]
        elapsed = time.time() - t0
        faces = _face_count(image)
        grid = _looks_like_grid(image)
        saved = _save_attempt_image(image, profile, prompt, attempt + 1, total, faces, grid)
        where = f" — saved {saved}" if saved else ""
        if not grid and (faces is None or faces <= 1):
            log.info("[%s] attempt %d/%d clean (faces=%s, %.1fs)%s",
                      profile.id, attempt + 1, total, faces, elapsed, where)
            return image
        log.info("[%s] detected %s (attempt %d/%d, %.1fs) — retrying%s",
                  profile.id,
                  f"grid-tiling (faces={faces})" if grid else f"{faces} faces",
                  attempt + 1, total, elapsed, where)
    raise GenerationQualityError(
        f"{profile.id}: still showed the character-sheet grid artifact after "
        f"{total} attempts"
    )


@app.post("/generate")
def generate(req: GenerateRequest):
    profile = _profile_for(req.model)

    reference_image = None
    reference_was_requested = bool(req.reference_image_b64)
    if req.reference_image_b64:
        if not profile.ip_adapter_repo:
            raise HTTPException(
                400, f"{profile.id}: no IP-Adapter configured — reference_image_b64 unsupported "
                     "on this model (currently only animagine-xl)"
            )
        try:
            reference_image = Image.open(io.BytesIO(base64.b64decode(req.reference_image_b64)))
            reference_image = reference_image.convert("RGB")
        except Exception as e:
            raise HTTPException(400, f"invalid reference_image_b64: {e}")

        # Guard against a self-reinforcing loop: worker/_shared/
        # reference-images.js falls back to a character's own CURRENT LIVE
        # SPRITE as its highest-priority IP-Adapter reference when no
        # explicit reference crop is assigned. If that sprite is itself a
        # broken "character sheet" grid (the exact artifact
        # _generate_with_retry guards against), IP-Adapter faithfully
        # reproduces its tiled layout — every regen conditions on the prior
        # regen's defect and the artifact never clears no matter how many
        # times the user retries. Confirmed live: this was happening for
        # every affected character. Reject a known-broken reference here,
        # at the one place all reference sources funnel through, rather
        # than in every caller that might supply one.
        if req.force_reference:
            log.info("[%s] force_reference set — skipping the broken-grid reference check", profile.id)
        elif _looks_like_grid(reference_image):
            log.warning("[%s] reference image looks like a broken character-sheet grid — "
                        "ignoring it, generating unconditioned instead", profile.id)
            reference_image = None

    pipe = _load_pipeline(profile)
    if profile.ip_adapter_repo:
        pipe.set_ip_adapter_scale(
            (req.ip_adapter_scale if req.ip_adapter_scale is not None else profile.default_ip_adapter_scale)
            if reference_image is not None else 0.0
        )
    width, height = _clamp_dims(
        req.width or profile.default_width, req.height or profile.default_height
    )
    log.info("[%s] generating %sx%s steps=%s reference=%s prompt=%r",
              profile.id, width, height, profile.steps, reference_image is not None, req.prompt[:120])
    try:
        image = _generate_with_retry(
            pipe, profile, req.prompt, width, height,
            reference_image=reference_image, check_quality=reference_was_requested,
        )
    except GenerationQualityError as e:
        # 502 (not 500): this is the upstream model's output failing our own
        # quality bar, not a server bug — freemium-image.js's tryLocalSd
        # surfaces any non-2xx as a plain error, and generateImage()'s
        # provider-fallback loop already treats a thrown local_sd error as
        # "try the next tier" rather than a hard failure (see
        # worker/_shared/freemium-image.js's generateImage), so this gives a
        # stubborn character a shot at a different provider instead of a
        # silently-broken committed image.
        raise HTTPException(502, str(e))
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return Response(content=buf.getvalue(), media_type="image/png")


@app.post("/generate_batch")
def generate_batch(req: BatchGenerateRequest):
    if not req.prompts:
        raise HTTPException(400, "prompts required")
    profile = _profile_for(req.model)
    if len(req.prompts) > profile.max_batch_size:
        raise HTTPException(
            400,
            f"{profile.id}: batch of {len(req.prompts)} exceeds max_batch_size="
            f"{profile.max_batch_size} (empirically verified safe limit — MPS "
            "hard-crashes the whole process, unrecoverably, above the actual "
            "ceiling, so this is intentionally conservative rather than let "
            "you find that out the hard way)",
        )
    pipe = _load_pipeline(profile)
    if profile.ip_adapter_repo:
        pipe.set_ip_adapter_scale(0.0)  # no reference support here — see _run's neutral-placeholder note
    width, height = _clamp_dims(
        req.width or profile.default_width, req.height or profile.default_height
    )
    log.info("[%s] batch generating %d images %sx%s steps=%s",
              profile.id, len(req.prompts), width, height, profile.steps)
    t0 = time.time()
    images = _run(pipe, profile, req.prompts, width, height)
    elapsed = time.time() - t0
    encoded = []
    for image in images:
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        encoded.append(base64.b64encode(buf.getvalue()).decode())
    return {"images": encoded, "count": len(encoded), "elapsed_sec": elapsed, "model": profile.id}


@app.post("/crop_faces")
def crop_faces(req: CropFacesRequest):
    """Detect each anime-style character face in a scene/plate and crop each
    to a head+upper-body reference (better IP-Adapter signal than the whole
    scene — see docs/LOCAL_IMAGE_GEN.md's v1→v2→v3 results). Exposes
    detect_and_crop_faces.py's logic over HTTP so the Worker (no local
    image-processing capability of its own) can call it — that script was
    previously CLI-only."""
    from detect_and_crop_faces import crop_faces_from_bytes

    try:
        image_bytes = base64.b64decode(req.image_b64)
    except Exception as e:
        raise HTTPException(400, f"invalid image_b64: {e}")

    try:
        crops, bboxes = crop_faces_from_bytes(image_bytes, max_faces=req.max_faces)
    except Exception as e:
        raise HTTPException(400, f"face detection failed: {e}")

    return {
        "count": len(crops),
        "crops": [base64.b64encode(c).decode() for c in crops],
        "bboxes": bboxes,
    }


@app.post("/ocr_faces")
def ocr_faces(req: OcrFacesRequest):
    """Some illustration plates caption each pictured character's name
    directly on the image (a labeled group shot). Runs OCR (Tesseract) to
    find name-like captions, pairs each with its nearest detected face, and
    returns a crop per confidently-paired face — lets the worker map a single
    multi-character plate straight to several character profiles at once,
    instead of the usual one-plate-one-character whole-plate match. See
    detect_and_crop_faces.py's crop_named_faces_from_bytes for the pairing
    logic."""
    from detect_and_crop_faces import crop_named_faces_from_bytes

    try:
        image_bytes = base64.b64decode(req.image_b64)
    except Exception as e:
        raise HTTPException(400, f"invalid image_b64: {e}")

    try:
        pairs = crop_named_faces_from_bytes(image_bytes)
    except Exception as e:
        raise HTTPException(400, f"OCR/face pairing failed: {e}")

    return {
        "count": len(pairs),
        "matches": [
            {
                "label": p["label"],
                "bbox": p["bbox"],
                "crop_b64": base64.b64encode(p["crop_png_bytes"]).decode(),
            }
            for p in pairs
        ],
    }


@app.post("/generate_expression_set")
def generate_expression_set(req: ExpressionSetRequest):
    """Revives server/images/expression_sprites.py's dormant logic: given a
    baseline character reference, generate the visual expression variants
    that dialogue actually calls for (sad/angry/whisper/yell/happy/surprised)
    — same taxonomy, same "same character, same outfit and hair as reference"
    consistency instruction, now backed by a local model with a real
    reference-adherence mechanism (IP-Adapter) instead of hoping a cloud
    provider's img2img holds identity across calls.
    """
    profile = _profile_for(req.model)
    if not profile.ip_adapter_repo:
        raise HTTPException(
            400, f"{profile.id}: no IP-Adapter configured — expression sets need reference "
                 "adherence (currently animagine-xl, sd15-anime-lcm)"
        )
    try:
        reference_image = Image.open(io.BytesIO(base64.b64decode(req.reference_image_b64)))
        reference_image = reference_image.convert("RGB")
    except Exception as e:
        raise HTTPException(400, f"invalid reference_image_b64: {e}")

    # See /generate's identical guard — a broken "character sheet" grid used
    # as the baseline reference here would get IP-Adapter-conditioned into
    # every expression variant. Unlike /generate, there's no sensible
    # unconditioned fallback for an *expression set* (the whole point is
    # reference adherence), so this is a hard error instead of a silent
    # drop — the caller needs to fix the reference, not get six broken
    # variants back.
    if _looks_like_grid(reference_image):
        raise HTTPException(
            400, "reference_image_b64 looks like a broken character-sheet grid, not a single "
                 "portrait — pick a clean reference"
        )

    exprs = req.expressions or list(EXPRESSION_PROMPTS.keys())
    unknown = [e for e in exprs if e not in EXPRESSION_PROMPTS]
    if unknown:
        raise HTTPException(400, f"unknown expression(s) {unknown} — known: {list(EXPRESSION_PROMPTS)}")

    pipe = _load_pipeline(profile)
    pipe.set_ip_adapter_scale(
        req.ip_adapter_scale if req.ip_adapter_scale is not None else 0.85
    )
    width, height = _clamp_dims(
        req.width or profile.default_width, req.height or profile.default_height
    )

    log.info("[%s] expression set: %s for %r", profile.id, exprs, req.character_description[:80])
    t0 = time.time()
    variants = {}
    for expr in exprs:
        suffix = EXPRESSION_PROMPTS[expr]
        prompt = (
            f"{req.character_description}. {suffix}. "
            "Same character, same outfit and hair as reference."
        )
        images = _run(pipe, profile, [prompt], width, height, reference_image=reference_image)
        buf = io.BytesIO()
        images[0].save(buf, format="PNG")
        variants[expr] = base64.b64encode(buf.getvalue()).decode()
    elapsed = time.time() - t0
    return {"variants": variants, "elapsed_sec": elapsed, "model": profile.id}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("LOCAL_IMAGE_PORT", "7860")))
