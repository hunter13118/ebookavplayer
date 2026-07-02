"""
Local Stable Diffusion adapter server for VAE's `local_sd` image-freemium tier.

Implements the contract the worker already expects (see
worker/_shared/freemium-image.js's tryLocalSd and
server/images/backends.py's _try_local_http):

    POST /generate
    body: {"prompt": str, "width"?: int, "height"?: int}
    -> 200, Content-Type: image/png, raw PNG bytes

Runs SDXL-Turbo on Apple Silicon via PyTorch's MPS (Metal) backend —
single-step distilled model, fast enough for local dev iteration.

Run:  source .venv/bin/activate && python scripts/local-image-server/server.py
Then: set LOCAL_IMAGE_URL=http://127.0.0.1:7860 in .env (worker appends /generate).
"""
from __future__ import annotations

import io
import logging
import os

import torch
from diffusers import AutoPipelineForText2Image
from fastapi import FastAPI
from fastapi.responses import Response
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("local-image-server")

MODEL_ID = os.environ.get("LOCAL_IMAGE_MODEL", "stabilityai/sdxl-turbo")
DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"
STEPS = int(os.environ.get("LOCAL_IMAGE_STEPS", "2"))
DEFAULT_W = int(os.environ.get("LOCAL_IMAGE_DEFAULT_WIDTH", "768"))
DEFAULT_H = int(os.environ.get("LOCAL_IMAGE_DEFAULT_HEIGHT", "1024"))

app = FastAPI()
pipe = None


class GenerateRequest(BaseModel):
    prompt: str
    width: int | None = None
    height: int | None = None
    out_hint: str | None = None  # accepted for legacy-backend compat, unused


@app.on_event("startup")
def load_pipeline():
    global pipe
    log.info("loading %s on %s (this downloads the model on first run)...", MODEL_ID, DEVICE)
    pipe = AutoPipelineForText2Image.from_pretrained(
        MODEL_ID,
        torch_dtype=torch.float16 if DEVICE == "mps" else torch.float32,
        variant="fp16" if DEVICE == "mps" else None,
    )
    pipe = pipe.to(DEVICE)
    log.info("model loaded, ready to generate")


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_ID, "device": DEVICE, "ready": pipe is not None}


@app.post("/generate")
def generate(req: GenerateRequest):
    width = req.width or DEFAULT_W
    height = req.height or DEFAULT_H
    # SDXL requires dimensions to be multiples of 8.
    width -= width % 8
    height -= height % 8

    log.info("generating %sx%s steps=%s prompt=%r", width, height, STEPS, req.prompt[:120])
    image = pipe(
        prompt=req.prompt,
        num_inference_steps=STEPS,
        guidance_scale=0.0,  # SDXL-Turbo is distilled for guidance-free single/few-step sampling
        width=width,
        height=height,
    ).images[0]

    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return Response(content=buf.getvalue(), media_type="image/png")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("LOCAL_IMAGE_PORT", "7860")))
