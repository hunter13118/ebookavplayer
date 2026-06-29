# Freemium image gallery probe

**When:** 2026-06-24T22:04:15.262Z
**Prompt:** young woman with dark hair, gentle smile, visual novel portrait

> Portrait bust character sprite, head and shoulders, large readable face, centered composition, expressive eyes and hair, front-facing or 3/4 view, young woman with dark hair, gentle smile, visual novel portrait character cutout on a fully transparent background (alpha channel), no backdrop, no floor shadow, no scenery, even lighting, face and hair fill most of the frame, thumbnail-friendly, visual novel dialogue portrait ready. Art style: clean digital illustration.

Open **[gallery.html](./gallery.html)** to compare all images side-by-side.

| Provider | Status | Time | Bytes | Model | Notes |
|----------|--------|------|-------|-------|-------|
| gemini_image | fail | 0.6s | — | — | gemini_image: all models failed (3) — gemini gemini-2.5-flash-image HTTP 429: {
  "error": {
    "code": 429,
    "message": "Your prepayment credits are depl |
| workers-ai | skip | 0.0s | — | — | no Workers AI binding in this Node process (edge-only) |
| cloudflare | fail | 0.1s | — | — | cloudflare: HTTP 400 {"success":false,"errors":[{"code":7000,"message":"No route for that URI"}],"messages":[],"result":null} |
| pollinations-anon | ok | 0.9s | 551173 | flux-free | pollinations-anon |
| pollinations-seed | ok | 1.2s | 551173 | flux-free | pollinations-seed |
| huggingface | fail | 0.1s | — | — | huggingface: HTTP 402 |
| cascade (no workers-ai) | ok | 1.9s | 551173 | flux-free | gemini_image → pollinations-seed |

## pollinations-anon

![pollinations-anon](images/pollinations-anon.png)

- **Model:** flux-free
- **Time:** 0.9s · **Size:** 551173 bytes

## pollinations-seed

![pollinations-seed](images/pollinations-seed.png)

- **Model:** flux-free
- **Time:** 1.2s · **Size:** 551173 bytes

## cascade (no workers-ai)

![cascade (no workers-ai)](images/cascade_no_workers-ai_.png)

- **Model:** flux-free
- **Time:** 1.9s · **Size:** 551173 bytes
