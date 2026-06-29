# Freemium image gallery probe

**When:** 2026-06-24T22:11:27.086Z
**Prompt:** young woman with dark hair, gentle smile, visual novel portrait

> Portrait bust character sprite, head and shoulders, large readable face, centered composition, expressive eyes and hair, front-facing or 3/4 view, young woman with dark hair, gentle smile, visual novel portrait character cutout on a fully transparent background (alpha channel), no backdrop, no floor shadow, no scenery, even lighting, face and hair fill most of the frame, thumbnail-friendly, visual novel dialogue portrait ready. Art style: clean digital illustration.

Open **[gallery.html](./gallery.html)** to compare all images side-by-side.

| Provider | Status | Time | Bytes | Model | Notes |
|----------|--------|------|-------|-------|-------|
| gemini_image | fail | 0.7s | — | — | gemini_image: all models failed (3) — gemini gemini-2.5-flash-image HTTP 429: {
  "error": {
    "code": 429,
    "message": "Your prepayment credits are depl |
| workers-ai | skip | 0.0s | — | — | edge-only: Workers AI needs env.AI binding (deployed portfolio worker or globalThis.__WRANGLER_AI__ in wrangler dev) |
| cloudflare | ok | 2.6s | 410522 | @cf/black-forest-labs/flux-1-schnell | cloudflare |
| pollinations-anon | ok | 1.3s | 551173 | flux-free | pollinations-anon |
| pollinations-seed | ok | 1.4s | 551173 | flux-free | pollinations-seed |
| huggingface | fail | 0.4s | — | — | huggingface: HTTP 400 {"error":"Model not supported by provider fal-ai"} |
| cascade (no workers-ai) | ok | 1.9s | 551173 | flux-free | gemini_image → pollinations-seed |

## cloudflare

![cloudflare](images/cloudflare.png)

- **Model:** @cf/black-forest-labs/flux-1-schnell
- **Time:** 2.6s · **Size:** 410522 bytes

## pollinations-anon

![pollinations-anon](images/pollinations-anon.png)

- **Model:** flux-free
- **Time:** 1.3s · **Size:** 551173 bytes

## pollinations-seed

![pollinations-seed](images/pollinations-seed.png)

- **Model:** flux-free
- **Time:** 1.4s · **Size:** 551173 bytes

## cascade (no workers-ai)

![cascade (no workers-ai)](images/cascade_no_workers-ai_.png)

- **Model:** flux-free
- **Time:** 1.9s · **Size:** 551173 bytes
