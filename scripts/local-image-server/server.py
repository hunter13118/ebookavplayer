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
import logging
import os
import time
from dataclasses import dataclass

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

_ANIME_NEGATIVE_PROMPT = (
    "lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, "
    "fewer digits, cropped, worst quality, low quality, normal quality, "
    "jpeg artifacts, signature, watermark, blurry"
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
    if reference_image is not None:
        kwargs["ip_adapter_image"] = reference_image
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


class BatchGenerateRequest(BaseModel):
    prompts: list[str]
    width: int | None = None
    height: int | None = None
    model: str | None = None


class CropFacesRequest(BaseModel):
    image_b64: str  # the raw scene/plate to crop (e.g. an EPUB illustration)
    max_faces: int | None = None  # cap the number of crops returned, left-to-right


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


@app.post("/generate")
def generate(req: GenerateRequest):
    profile = _profile_for(req.model)

    reference_image = None
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

    pipe = _load_pipeline(profile)
    if reference_image is not None:
        pipe.set_ip_adapter_scale(
            req.ip_adapter_scale if req.ip_adapter_scale is not None
            else profile.default_ip_adapter_scale
        )
    width, height = _clamp_dims(
        req.width or profile.default_width, req.height or profile.default_height
    )
    log.info("[%s] generating %sx%s steps=%s reference=%s prompt=%r",
              profile.id, width, height, profile.steps, reference_image is not None, req.prompt[:120])
    images = _run(pipe, profile, [req.prompt], width, height, reference_image=reference_image)
    buf = io.BytesIO()
    images[0].save(buf, format="PNG")
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
        crops = crop_faces_from_bytes(image_bytes, max_faces=req.max_faces)
    except Exception as e:
        raise HTTPException(400, f"face detection failed: {e}")

    return {
        "count": len(crops),
        "crops": [base64.b64encode(c).decode() for c in crops],
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
