# Workers AI — limits & pipeline fit

## What you get free

| Limit | Value |
|-------|--------|
| Daily neurons (free + paid base) | **10,000 / day** |
| Reset | **00:00 UTC** |
| Over quota | HTTP **4006** — hard stop until reset |
| Paid overage | **$0.011 / 1,000 neurons** (Workers Paid plan) |

Neurons are **shared across all Workers AI models** in your account — images,
text, TTS, embeddings, everything draws from the same daily pool.

## Rough neuron costs (planning)

| Use | Approx neurons / call | ~10k/day gets you |
|-----|----------------------|-------------------|
| FLUX-1-schnell image | ~40–50 | **~200 images** |
| SDXL-class image | ~300–500 | ~20–30 images |
| Llama 3.1 8B extract chunk | ~15–80+ (size-dependent) | **~100–300 chunks** |
| Llama 70B extract chunk | much higher | dozens of chunks |
| Aura TTS line | varies | competes with images |

Community reports: text burns neurons **10–50× faster** than tiny embedding
calls; a full-book mega-pass can exhaust 10k neurons in **minutes**.

## Where Workers AI fits in VAE today

| Stage | Primary | Workers AI role |
|-------|---------|-----------------|
| **EPUB extraction** (mega-pass) | **Gemini** (multimodal, 120k+ chars, JSON mode) | **Late fallback only** — `freemium_extract` chain ends with `cloudflare` |
| **Moment / insert LLM tweaks** | Gemini | Optional small Workers AI call |
| **Character / BG images** | Gemini → freemium chain | **Primary freemium** — FLUX-1-schnell (`worker/_shared/freemium-image.js`; original prototype at `legacy/server/images/freemium.py`) |
| **Pack audiobook TTS** | Edge TTS (Microsoft, free) | Not Workers AI — Aura TTS would burn neurons |
| **Offline packs** | Client IndexedDB + optional R2 | No AI |

### Should you use Workers AI for extraction?

**Not as primary.** Gemini wins for your pipeline because:

1. **Multimodal** — EPUB plates, cover art, and HTML context in one pass.
2. **Context** — whole-book mega-pass (up to `GEMINI_MAX_CHARS`) vs 8B/70B limits.
3. **Structured JSON** — native JSON mode + repair pass; smaller CF models need more babysitting.
4. **Separate quota** — Gemini free tier (~500 images/day) doesn't compete with FLUX neurons.

**Workers AI extract is useful when:**

- Gemini quota is exhausted mid-ingest.
- You want a **no-Google** path for text-only re-chunking.
- Small auxiliary tasks (moment prompt polish, single-scene re-extract).

It is wired as the **last** provider in the extract chain so FLUX image budget
isn't accidentally spent on text first.

```text
extract: gemini → cerebras → groq → mistral → openrouter → cloudflare (Workers AI)
images:  gemini_image → cloudflare (FLUX) → pollinations → huggingface
```

Configure:

```env
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...          # Workers AI permission
CLOUDFLARE_EXTRACT_MODEL=@cf/meta/llama-3.1-8b-instruct
```

## What to watch

1. **One bucket** — FLUX backgrounds + extract fallback share 10k neurons. A
   heavy imaging day can block extract fallback that night.
2. **Dashboard lag** — community reports 4006 while dashboard still shows 0;
   treat 4006 as ground truth.
3. **No card = hard ceiling** — staying off Workers Paid means no surprise bills,
   but also no burst overage when you hit the wall.
4. **TTS on Workers AI** — Aura models exist but would be expensive in neurons
   vs Edge TTS (free, already integrated). Don't route pack audiobook builds
   through Workers TTS.

## Practical budget strategy (personal use)

| Priority | Spend neurons on | Keep on |
|----------|------------------|---------|
| 1 | FLUX character/BG art when Gemini images thin | Gemini extract |
| 2 | — | Edge TTS playback + pack audio |
| 3 | Workers AI extract only if Gemini + Groq/Cerebras fail | War Council local (future) |

For a typical book (~50 scenes, ~100 images): FLUX alone can use **~5,000**
neurons — half your daily free pool. Plan imaging days accordingly.

## Paid tier math

If you upgrade to Workers Paid ($5/mo base):

- First 10k neurons/day still free.
- Extra at $0.011/1k → **~$0.11 per 10k extra neurons**.
- 100k neurons/day overage ≈ **$0.99/day** — still cheap for experiments, but
  scales if you automate full-book imaging + extract on CF only.

## Bottom line

- **Yes, integrate Workers AI** — you already do for images; extract fallback is now wired.
- **No, don't replace Gemini** with Workers AI for the main extraction spine.
- **Be concerned** about the shared 10k/day cap if you image heavily; monitor
  4006 errors and keep Gemini + Edge TTS as the workhorses.
