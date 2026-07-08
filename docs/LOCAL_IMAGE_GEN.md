# Local image generation (`local_sd` tier)

[scripts/local-image-server/server.py](../scripts/local-image-server/server.py)
is a self-contained SDXL/SD1.5 server backing the `local_sd` image tier — no
cloud key, no dependency on another project. Same spirit as
[LOCAL_LLM_EXTRACTION.md](LOCAL_LLM_EXTRACTION.md)'s local Ollama setup, but
for image generation instead of text extraction.

## The three model profiles

Picking the right model matters more than picking the right prompt. All
three are SDXL/SD1.5-architecture and share the same server/endpoints —
switch with the `model` field on a request, or `LOCAL_IMAGE_MODEL` in `.env`.

| Profile id | Repo | Steps | Resolution | Character |
|---|---|---|---|---|
| `sdxl-turbo` | `stabilityai/sdxl-turbo` | 2 | 768×1024 | Fastest, but wrong tool for anime |
| `animagine-xl` | `cagliostrolab/animagine-xl-3.1` | 28 | 832×1216 | Best anime fidelity, slowest |
| `sd15-anime-lcm` | `gsdf/Counterfeit-V2.5` + `latent-consistency/lcm-lora-sdv1-5` | 6 | 512×768 | Anime-native and fast |

**Why not just use `sdxl-turbo` for everything:** turbo's speed comes from
distillation that *requires* `guidance_scale=0.0` — no CFG, so negative
prompts do nothing. Combined with base SDXL's photoreal-leaning training,
asking it for a stylized anime face produces an uncanny "realistic but
wrong" result (colloquially: the "biblically accurate angel" effect) rather
than actual anime art. There's no prompt fix for this — it's an
architecture/training mismatch, not a wording problem.

**`animagine-xl`** is trained specifically on anime data and uses real
CFG + negative-prompt steering (28 steps, guidance 7.0, a stock
low-quality/bad-anatomy negative prompt) — genuinely anime output, at the
cost of being ~20-25x slower per image than turbo on this hardware.

**`sd15-anime-lcm`** tries to split the difference: an anime-native SD1.5
checkpoint (smaller/lighter than SDXL to begin with) plus the official
LCM-LoRA, cutting inference to 6 steps. Anime-native *and* close to turbo
speed.

## Endpoints

```
GET  /health
-> {"status", "default_model", "device", "device_reason", "ready"}

GET  /models
-> {"default": str, "profiles": {id: {repo_id, steps, guidance_scale, default_width, default_height, loaded}}}

POST /generate
body: {"prompt": str, "width"?: int, "height"?: int, "model"?: str,
       "reference_image_b64"?: str, "ip_adapter_scale"?: float}
-> 200, image/png, raw bytes
(this is the contract worker/_shared/freemium-image.js's tryLocalSd and
server/images/backends.py's _try_local_http actually call — the production
app only ever sends {prompt, width, height, model}; reference_image_b64 and
ip_adapter_scale are additions for local dev/character-consistency work, see
below. Only valid for a model with ip_adapter_repo set — see the table below.)

POST /generate_batch
body: {"prompts": [str, ...], "width"?: int, "height"?: int, "model"?: str}
-> {"images": [base64 PNG, ...], "count": int, "elapsed_sec": float, "model": str}
(no reference-image support — see "one reference across a batch" note below)

POST /generate_expression_set
body: {"character_description": str, "reference_image_b64": str,
       "expressions"?: [str, ...], "model"?: str, "ip_adapter_scale"?: float,
       "width"?: int, "height"?: int}
-> {"variants": {expression: base64 PNG, ...}, "elapsed_sec": float, "model": str}
```

`/generate_batch` is a **real** batched diffusion call — one `pipe()`
invocation with `prompt=[...]`, every image in the batch decoding the same
fixed step count together as one tensor op. This is architecturally
different from concurrent LLM decode (see the Ollama benchmark in
[LOCAL_LLM_EXTRACTION.md](LOCAL_LLM_EXTRACTION.md), where concurrent
requests fought each other for the same GPU with net-negative aggregate
throughput) — diffusion steps are synchronized across the batch, so it was
worth actually testing whether it scales here. It's for local dev/
benchmarking only; the production app never calls it.

### Device auto-detection

Same CUDA > MPS > CPU precedence as the Ollama setup, checked once at
startup and reported on `GET /health`:

```bash
export LOCAL_IMAGE_DEVICE=cuda   # or mps / cpu — override if auto-detect guesses wrong
```

## Batching benchmark: mixed results, and a hard crash ceiling

**This is not a clean "batching helps" story like it might be on a CUDA
server GPU with mature batched kernels.** Measured on this machine (Apple M4
Pro, 48GB unified memory, PyTorch MPS backend), the three profiles behaved
three different ways:

| Model | batch=1 | batch=2 | batch=4 | batch=8 |
|---|---|---|---|---|
| `sdxl-turbo` | 0.252 img/s | 0.227 img/s | 0.154 img/s | 0.069 img/s |
| `sd15-anime-lcm` | 0.064 img/s | 0.107 img/s | 0.113 img/s | **process crash** |
| `animagine-xl` | 0.011 img/s | 0.011 img/s | rejected (see below) | rejected |

- **`sdxl-turbo`: batching actively hurts.** Throughput drops monotonically
  and super-linearly as batch size grows (batch=8 takes 115s for 8 images —
  worse than 8× the batch=1 time). Don't batch this model.
- **`sd15-anime-lcm`: batching genuinely helps, up to a point.** Real
  throughput gains from batch=1 to batch=4 (0.064 → 0.113 img/s, ~1.8x). At
  batch=8 it doesn't slow down — **it crashes the entire server process.**
- **`animagine-xl`: batching is a wash.** batch=2 took almost exactly 2x
  batch=1's time (93.3s → 187.6s) — no gain, no loss, purely additive. At
  832×1216 resolution and 28 steps it's also by far the slowest model
  regardless of batch size.

### The crash: a real, hard MPS limit — not a graceful OOM

`sd15-anime-lcm` at batch=8 killed the whole server process with:

```
MPSNDArray.mm:850: failed assertion `[MPSTemporaryNDArray initWithDevice:
descriptor:isTextureBacked:] Error: total bytes of NDArray > 2**32'
```

This is a **native Metal assertion failure that calls `abort()`** — it is
not a Python exception, cannot be caught with `try`/`except`, and is not
about running out of memory (RSS was nowhere near 48GB when it happened).
Apple's Metal Performance Shaders backend hard-caps any **single tensor
allocation at 4GB (2^32 bytes)**, full stop, regardless of how much unified
memory is free. Large enough batch × resolution × intermediate-activation
size in a U-Net forward pass can cross that ceiling well before system
memory becomes a concern — the same "RAM isn't actually the bottleneck"
lesson as the Ollama benchmark, but manifesting as a crash instead of a
slowdown here.

**Mitigation:** each `ModelProfile` in `server.py` has a `max_batch_size`
field, empirically set from what was actually verified safe above, and
`/generate_batch` rejects anything over it with a clear `HTTP 400` instead
of letting the process die:

| Profile | `max_batch_size` | Basis |
|---|---|---|
| `sdxl-turbo` | 8 | verified working (just badly — see table above) |
| `sd15-anime-lcm` | 4 | verified working; 8 crashes the process |
| `animagine-xl` | 2 | untested above 2 — highest resolution of the three, conservative until proven |

If you raise any of these, do it by actually testing first — the crash
doesn't degrade gracefully, it takes the whole server down mid-request.

## Reference-image conditioning (IP-Adapter) — character consistency

The production app's `local_sd` tier is txt2img only. This section covers a
second, non-production capability built on top: given a reference image (an
EPUB-extracted character plate, or a previously-generated portrait), condition
generation to preserve that character's identity across new scenes/poses —
directly usable with the EPUB illustrations the ingest pipeline already
extracts.

### Why not img2img

Plain img2img (`AutoPipelineForImage2Image`, works trivially on all three
models) is the wrong tool: it uses the reference as noisy *starting pixels*,
not an identity signal. Low `strength` barely deviates from the reference's
composition; high `strength` throws the reference away almost entirely.
Neither gives you "same character, new scene."

### The right tool: IP-Adapter

IP-Adapter encodes the reference via a CLIP vision model and injects it as a
second conditioning signal *alongside* the text prompt (parallel cross-
attention, not starting noise) — this is what "same character, new scene"
actually needs. Enabled per-profile via `ip_adapter_repo`/`ip_adapter_subfolder`/
`ip_adapter_weight_name` on `ModelProfile`, loaded once at pipeline-load time,
applied via `POST /generate`'s `reference_image_b64` field:

| Profile | IP-Adapter weights | Verified |
|---|---|---|
| `sdxl-turbo` | not configured | Skipped intentionally — `guidance_scale=0.0` strips the same steering mechanisms this needs (same root cause as the negative-prompt problem above); not worth the download. |
| `animagine-xl` | `h94/IP-Adapter`, `sdxl_models/ip-adapter_sdxl.bin` (+ auto-loaded OpenCLIP ViT-bigG image encoder, ~3.7GB) | Yes — the primary target, see results below |
| `sd15-anime-lcm` | `h94/IP-Adapter`, `models/ip-adapter_sd15.bin` (+ a separate, smaller SD1.5 image encoder) | Yes — loads and generates correctly stacked on top of the LCM-LoRA already on this profile; no load-order conflict (LoRA loads first, then IP-Adapter, then both move to device together via `pipe.to(DEVICE)`) |

The image encoder auto-loads the first time `pipe.load_ip_adapter(...)` runs
— no separate `CLIPVisionModelWithProjection` construction needed in current
`diffusers`, despite older examples showing that pattern.

### Character-crop tool: `detect_and_crop_faces.py`

EPUB illustrations are frequently group scenes (a cover with 2-3 characters,
an insert with a whole party). Feeding IP-Adapter the whole scene as a
reference is a worse signal than a clean per-character crop.
[scripts/local-image-server/detect_and_crop_faces.py](../scripts/local-image-server/detect_and_crop_faces.py)
detects each anime-style face in an image and crops each to a head+upper-body
framing (better than a face-only crop for IP-Adapter — see results below):

```bash
python3 scripts/local-image-server/detect_and_crop_faces.py input.jpg output_dir/
# detected 3 face(s)
#   face 0: bbox=(155,124,289,289) -> output_dir/character-0.png (617x1156)
#   face 1: bbox=(634,417,58,58)   -> output_dir/character-1.png (127x232)
#   face 2: bbox=(1206,1019,53,53) -> output_dir/character-2.png (116x212)
```

Uses `lbpcascade_animeface` (nagadomi) — a small Haar/LBP cascade trained
specifically on anime-style faces. General face detectors (trained on
photographic faces) miss or misdetect anime faces because the proportions are
so different (huge eyes, tiny nose/mouth). Faces are returned left-to-right
for stable, predictable ordering across runs on the same image.

Tested end-to-end on the real EPUB cover for "My Quiet Blacksmith Life in
Another World Vol. 4" (`OEBPS/Images/Cover.jpg`, extracted straight from the
`.epub` zip, not a pre-cropped asset) — correctly found all 3 characters
(protagonist + two background NPCs) on the first try.

### Results: three rounds, and what actually moved the needle

All three rounds used the same character (the blacksmith cover's red-haired
protagonist — red hair, red eyes, dark leather armor with buckles, green
cape) and the same three test scenes (forge, tavern, forest) or an expression
set, to isolate what each change actually did.

**v1 — raw full cover as reference, scale 0.6:** loose "vibe" only. Red hair
carried over; eye color drifted every time (amber → green → purple across the
three scenes); the reference's specific outfit (buckles, green cape, red
boots) was replaced by a different scene-appropriate outfit each time; hair
*style* (the reference's side braid) didn't transfer either.

**v2 — face-detected crop + scale 0.85:** meaningfully better. Eye color hit
2/3 (vs. 0/3), all three picked up the buckled/strapped dark-leather
*aesthetic* even where the exact garment differed, hair color was closer to
the reference's shade. New tradeoff surfaced: at 0.85 the forge scene's
camera angle started echoing the reference's own dynamic tilted pose, not
just its identity — pushing scale further trades "new scene" for "closer
copy," it doesn't just tighten identity for free.

**v3 — chain off a same-style baseline (not the cover) + scale 0.85:** the
big win. Generate one clean portrait first (animagine-native style,
IP-Adapter-conditioned on the face crop, scale 0.75), then use *that
generated portrait* — not the original EPUB cover — as the reference for
every subsequent variant. Result: consistent red hair, consistent red eyes,
and the same green-cape-plus-buckled-corset outfit held across all five test
images (1 baseline + 4 expressions), each expression clearly distinct
(happy/angry/sad/surprised all correctly legible). The insight: the model was
spending its "identity budget" bridging the EPUB cover's painterly
light-novel style to animagine's native anime style on *every single
generation* in v1/v2. Do that bridging once (cover → baseline), then every
downstream variant stays within animagine's own style space where the
reference and target distributions actually match — dramatically less for
the model to reconcile per generation.

**Practical rule:** for any character-consistency work, generate a same-style
baseline first (even if it's IP-Adapter-conditioned on a rougher EPUB
source), then always reference the baseline for variants — never the raw
source repeatedly.

### Character expression variants — reviving `expression_sprites.py`

[server/images/expression_sprites.py](../server/images/expression_sprites.py)
already has real logic for this: `collect_character_expressions()` scans a
book's actual dialogue lines (via `infer_expression_from_text`) to figure out
which expressions (`sad`, `angry`, `whisper`, `yell`, `happy`, `surprised`) a
given character actually needs portraits for, and
[server/images/generate.py:318-347](../server/images/generate.py#L318) already
calls the image backend per-expression with `"Same character, same outfit and
hair as reference."` It never had a local backend with a real adherence
mechanism to plug into — cloud img2img/reference support was the only option,
with the same weak-consistency problems this doc opens with.

`POST /generate_expression_set` is that backend. It mirrors
`EXPRESSION_PROMPTS` **exactly** (same six keys, same phrasing — don't let
these drift apart) and reuses the same consistency-instruction sentence:

```bash
curl -X POST http://127.0.0.1:7860/generate_expression_set \
  -H "Content-Type: application/json" \
  -d '{
    "character_description": "1girl, red hair, red eyes, blacksmith adventurer, dark leather armor with buckles, green cape",
    "reference_image_b64": "<base64 of the BASELINE portrait, not the raw EPUB source>",
    "expressions": ["happy", "angry", "sad", "surprised"],
    "model": "animagine-xl",
    "ip_adapter_scale": 0.85
  }'
```

Generates sequentially (not batched — `animagine-xl`'s `max_batch_size=2`
would reject a 4-6 expression set anyway; see the batching section above),
each expression its own `/generate`-equivalent call sharing one loaded
reference. On this machine: ~93-104s per expression for `animagine-xl`
(28 steps), so a full 6-expression set is roughly 10 minutes — plan
per-chapter generation accordingly, this is not an interactive-speed
operation on `animagine-xl`. `sd15-anime-lcm` (6 steps) would be
substantially faster per variant if quality is acceptable at that tier;
not yet benchmarked for the full expression-set path specifically.

### One reference across a batch — not yet wired

`/generate_batch`'s `prompt=[...]` accepts a list, but the correct
`ip_adapter_image` shape for "one reference conditions N different batched
prompts" wasn't verified — rather than guess, reference-image support was
scoped to `/generate` (sequential) only. `/generate_expression_set` gets you
the same outcome (multiple variants, one reference) without that ambiguity,
just without batch-level tensor fusion. Worth revisiting if expression-set
generation time becomes a real bottleneck.

## Setup

Full install list for a fresh machine — everything needed for every feature
in this doc (base generation, batching, reference-image conditioning, face
cropping):

```bash
source venv/bin/activate
pip install torch diffusers transformers accelerate peft
pip install "opencv-python-headless==4.10.0.84"  # pinned — see Bugs below, do not install unpinned
pip install pip-system-certs  # macOS/Homebrew Python only — see Bugs below

# Anime face cascade for detect_and_crop_faces.py (~500KB, one-time):
mkdir -p scripts/local-image-server/models
curl -s -o scripts/local-image-server/models/lbpcascade_animeface.xml \
  https://raw.githubusercontent.com/nagadomi/lbpcascade_animeface/master/lbpcascade_animeface.xml

python3 scripts/local-image-server/server.py
# Exposes /health, /models, /generate, /generate_batch, /generate_expression_set on :7860
```

Set in root `.env`:
```bash
LOCAL_IMAGE_URL=http://127.0.0.1:7860
LOCAL_IMAGE_MODEL=sdxl-turbo   # or animagine-xl / sd15-anime-lcm
```

First use of each model downloads its weights on demand (no pre-fetch step):
SDXL-Turbo ~7GB, Animagine XL ~7GB, Counterfeit-V2.5 (SD1.5) ~2GB,
IP-Adapter SDXL (weights + image encoder) ~4.5GB, IP-Adapter SD1.5 ~1.7GB.
All cached under `~/.cache/huggingface/hub/` after first run — nothing
re-downloads on restart.

## Bugs hit and fixed getting here (for the next person)

- **`variant="fp16"` fails for non-Stability SDXL checkpoints.** Only base
  Stability AI repos publish a separate `fp16` variant folder — community
  fine-tunes like `cagliostrolab/animagine-xl-3.1` don't, and requesting it
  raises `ValueError: no such modeling files are available`. Fixed via the
  `has_fp16_variant` field on `ModelProfile` (`False` for Animagine); the
  model still loads in fp16 via `torch_dtype`, just without the variant
  subfolder lookup.
- **Missing `transformers`.** `diffusers`'s SDXL pipeline needs it directly;
  it's not pulled in automatically by `pip install diffusers` alone.
- **Missing `peft`.** `pipe.load_lora_weights()` (used for the LCM-LoRA)
  raises `ValueError: PEFT backend is required for this method` without it.
- **SSL cert verification failing for *any* HTTPS from Python** (even
  `google.com`), despite `curl` working fine — Homebrew Python doesn't read
  the macOS Keychain trust store the way `curl`/Safari do. Fixed with
  `pip install pip-system-certs`, which patches Python's `ssl` module to use
  the OS trust store automatically (no code changes, no explicit import
  needed — it hooks in via a `.pth` file at interpreter startup).
- **`opencv-python-headless` 5.0 has no `cv2.CascadeClassifier`.** OpenCV 5.x
  dropped the legacy Haar/LBP cascade `objdetect` API entirely in favor of
  the DNN-based `cv2.FaceDetectorYN` (YuNet) — but YuNet is trained on
  photographic human faces and performs poorly on anime art, the opposite of
  what `lbpcascade_animeface.xml` needs. Fixed by pinning
  `opencv-python-headless==4.10.0.84`, the last line that still ships
  `CascadeClassifier`. Don't upgrade this package without re-verifying.

## References

| Topic | File(s) |
|---|---|
| Server implementation | [scripts/local-image-server/server.py](../scripts/local-image-server/server.py) |
| Character-crop tool | [scripts/local-image-server/detect_and_crop_faces.py](../scripts/local-image-server/detect_and_crop_faces.py) |
| Production contract this backs | [worker/_shared/freemium-image.js](../worker/_shared/freemium-image.js) (`tryLocalSd`), [server/images/backends.py](../server/images/backends.py) (`_try_local_http`) |
| Dormant expression-variant logic this revives | [server/images/expression_sprites.py](../server/images/expression_sprites.py), [server/images/generate.py:318-347](../server/images/generate.py#L318) |
| Env vars | [.env.example](../.env.example) |
| General setup | [SETUP.md](../SETUP.md) |
| The analogous Ollama/LLM local-extraction benchmark | [LOCAL_LLM_EXTRACTION.md](LOCAL_LLM_EXTRACTION.md) |
| Future: route local-LLM needs (extraction + image gen) through War Council instead | [ECOSYSTEM_INTEGRATION.md](ECOSYSTEM_INTEGRATION.md) |
