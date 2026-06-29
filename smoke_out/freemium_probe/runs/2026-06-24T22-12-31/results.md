# Freemium image gallery probe

**When:** 2026-06-24T22:12:31.130Z
**Prompt:** young woman with dark hair, gentle smile, visual novel portrait

> Portrait bust character sprite, head and shoulders, large readable face, centered composition, expressive eyes and hair, front-facing or 3/4 view, young woman with dark hair, gentle smile, visual novel portrait character cutout on a fully transparent background (alpha channel), no backdrop, no floor shadow, no scenery, even lighting, face and hair fill most of the frame, thumbnail-friendly, visual novel dialogue portrait ready. Art style: clean digital illustration.

Open **[gallery.html](./gallery.html)** to compare all images side-by-side.

| Provider | Status | Time | Bytes | Model | Notes |
|----------|--------|------|-------|-------|-------|
| gemini_image | fail | 0.8s | — | — | gemini_image: all models failed (3) — gemini gemini-2.5-flash-image HTTP 429: {
  "error": {
    "code": 429,
    "message": "Your prepayment credits are depl |
| workers-ai | skip | 0.0s | — | — | edge-only: Workers AI needs env.AI binding (deployed portfolio worker or globalThis.__WRANGLER_AI__ in wrangler dev) |
| cloudflare | ok | 2.4s | 414795 | @cf/black-forest-labs/flux-1-schnell | cloudflare |
| pollinations-anon | ok | 1.4s | 551173 | flux-free | pollinations-anon |
| pollinations-seed | ok | 1.6s | 551173 | flux-free | pollinations-seed |
| huggingface | fail | 0.2s | — | — | huggingface: HTTP 402 — Inference Provider credits exhausted for black-forest-labs/FLUX.1-schnell. You have depleted your monthly included credits. Purchase pre-paid credits to continue using Inference Providers. Alternatively, subscribe to PRO to get 20x more included usage. |
| cascade (no workers-ai) | ok | 2.0s | 551173 | flux-free | gemini_image → pollinations-seed |

## cloudflare

![cloudflare](images/cloudflare.png)

- **Model:** @cf/black-forest-labs/flux-1-schnell
- **Time:** 2.4s · **Size:** 414795 bytes

## pollinations-anon

![pollinations-anon](images/pollinations-anon.png)

- **Model:** flux-free
- **Time:** 1.4s · **Size:** 551173 bytes

## pollinations-seed

![pollinations-seed](images/pollinations-seed.png)

- **Model:** flux-free
- **Time:** 1.6s · **Size:** 551173 bytes

## cascade (no workers-ai)

![cascade (no workers-ai)](images/cascade_no_workers-ai_.png)

- **Model:** flux-free
- **Time:** 2.0s · **Size:** 551173 bytes
