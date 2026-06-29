# Freemium image gallery probe

**When:** 2026-06-24T22:03:30.662Z
**Prompt:** young woman with dark hair, gentle smile, visual novel portrait

> Portrait bust character sprite, head and shoulders, large readable face, centered composition, expressive eyes and hair, front-facing or 3/4 view, young woman with dark hair, gentle smile, visual novel portrait character cutout on a fully transparent background (alpha channel), no backdrop, no floor shadow, no scenery, even lighting, face and hair fill most of the frame, thumbnail-friendly, visual novel dialogue portrait ready. Art style: clean digital illustration.

Open **[gallery.html](./gallery.html)** to compare all images side-by-side.

| Provider | Status | Time | Bytes | Model | Notes |
|----------|--------|------|-------|-------|-------|
| gemini_image | ok | 3.3s | 551173 | flux-free | gemini_image → pollinations-seed |
| workers-ai | skip | 0.0s | — | — | no Workers AI binding in this Node process (edge-only) |
| cloudflare | ok | 1.6s | 551173 | flux-free | cloudflare → pollinations-seed |
| pollinations-anon | ok | 0.7s | 551173 | flux-free | pollinations-anon |
| pollinations-seed | ok | 1.2s | 551173 | flux-free | pollinations-seed |
| huggingface | ok | 1.5s | 551173 | flux-free | huggingface → pollinations-seed |
| cascade (no workers-ai) | ok | 1.7s | 551173 | flux-free | gemini_image → pollinations-seed |

## gemini_image

![gemini_image](images/gemini_image.png)

- **Model:** flux-free
- **Time:** 3.3s · **Size:** 551173 bytes

## cloudflare

![cloudflare](images/cloudflare.png)

- **Model:** flux-free
- **Time:** 1.6s · **Size:** 551173 bytes

## pollinations-anon

![pollinations-anon](images/pollinations-anon.png)

- **Model:** flux-free
- **Time:** 0.7s · **Size:** 551173 bytes

## pollinations-seed

![pollinations-seed](images/pollinations-seed.png)

- **Model:** flux-free
- **Time:** 1.2s · **Size:** 551173 bytes

## huggingface

![huggingface](images/huggingface.png)

- **Model:** flux-free
- **Time:** 1.5s · **Size:** 551173 bytes

## cascade (no workers-ai)

![cascade (no workers-ai)](images/cascade_no_workers-ai_.png)

- **Model:** flux-free
- **Time:** 1.7s · **Size:** 551173 bytes
