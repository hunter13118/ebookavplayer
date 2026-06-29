# DESIGN.md — Rationale & Decisions

> Companion to `HANDOFF.md`. This explains **why** the two modules are built the
> way they are, so an implementing agent doesn't "fix" deliberate choices. Each
> section ends with a **DO NOT** note where a tempting change would break intent.

---

## 1. Image generation: provider selection

### Hard requirements that drove the list
The goal was image generation that is **(a) free, (b) callable via API key from an app, and (c) carries zero money-exchange risk** — no "sign up with a credit card, get $X credit" trials, no path that silently rolls into paid billing. The user wants a `$0` hard ceiling, ideally enforced structurally.

### What survived the filter (the four providers in the module)
| Provider | Why it qualifies | Role |
|---|---|---|
| **Cloudflare Workers AI** | Recurring free tier (~10,000 neurons/day ≈ ~230 FLUX-schnell images/day), no card required, returns clean base64, account-controlled | **Primary** — highest free volume, no watermark |
| **Pollinations (Seed)** | `flux` is free & unlimited; "no credit card required"; Seed tier auto-assigned on first login | Breadth / card-free secondary |
| **Pollinations (Anon)** | No key at all; just hit the URL | Zero-config fallback (rate-limited ~1 req/15s, may watermark) |
| **Hugging Face Inference Providers** | ~$0.10 credits/month, refreshes monthly, no card to start | Small monthly extra / tail |

### What was deliberately EXCLUDED (and must not be re-added)
- **fal, Replicate, Leonardo, Google Vertex, NVIDIA NIM** — all **trial credit**: a one-time pool that does not renew, and several roll into paid once exhausted (money risk). NVIDIA's "free credits" are a grant, not a recurring bucket. These fail requirement (c).
- **Gemini / OpenAI image APIs** — no free image tier (Google cut its free image-gen route in Nov 2025; OpenAI never had one).

**DO NOT** add trial-credit providers "for more fallbacks." The user explicitly culled them. More providers ≠ better here; the constraint is *zero money risk*, not maximum redundancy.

### Pollinations model constraint
Pollinations exposes many image models, but **only unauthenticated `flux` is the
0-pollen tier** (rate-limited, may watermark). Authenticated `sk_` keys spend
pollen on `flux`, `zimage`, and everything else — even when FAQ text still calls
flux "free." With zero balance, the module falls back to **no-auth `flux`**.

**DO NOT** switch the free-tier fallback to klein/gptimage/zimage-with-auth — those
are pollen-metered.

### How $0 is actually enforced
Not by a billing setting — by **never attaching a payment method** to Cloudflare/Pollinations/HF. With no payment rail, there is no overage to bill into. Staying on Cloudflare's Workers Free plan (no card) is the ceiling.

---

## 2. Image generation: fallback ordering

Ordering principle: **cost-safety first, then quality/consistency, then reliability** — but the two subject types weight these differently, so they get **separate chains**.

### Characters (`CHARACTER_CHAIN`): `cloudflare → pollinations-anon → pollinations-seed → huggingface`
Sprites are regenerated in matched sets (poses, expressions), so **visual consistency dominates**. Anonymous Pollinations is **before seed** so 0-pollen anon is tried before authed seed spends pollen. Cloudflare leads: highest volume, no watermark, account-controlled.

### Backgrounds (`BACKGROUND_CHAIN`): `cloudflare → pollinations-anon → pollinations-seed → huggingface`
Backgrounds are usually one-and-done; consistency barely matters. Anon (free flux) floats **above** seed so pollen is not spent unless anon fails.

**DO NOT** merge these into one chain. The split is the point.

### Seed + provider pinning (consistency mechanism)
A seed is reproducible only **within one provider+model** — the same seed yields different images across providers (different model builds / sampling). So sprite consistency needs BOTH a pinned seed AND a pinned provider:
- Store `result.provider` + `result.seed` on first generation.
- Replay them via `{ seed, preferProvider }` for later poses.
- `buildChain(subjectType, preferProvider)` moves the preferred provider to the front, keeping the rest as fallback.

**Pinning is soft by design** — if the pinned provider is down, the chain falls through (a mismatched sprite rather than a hard failure). If the app wants matched-or-nothing for characters, add a `strictPin` option that throws when the preferred provider fails instead of falling through. (Left to the app because "mismatched but present" vs "fail and retry later" is a product decision.)

### Free-tier ceiling on consistency
Even with seed+provider pinned, FLUX consistency across *different prompts* (idle vs attack pose) is "visually close," not pixel-identical — palette/design stay stable, fine facial details can drift. True sprite-sheet consistency needs image-to-image/reference conditioning, which on the free stack would be Pollinations `kontext` — but that's **Pollen-metered**, so it's out under the $0 rule. Accept "close" as the free ceiling.

---

## 3. Prompt composition (image)

Two independent axes combine: `subjectType` (framing) × `style` (look).
- `SUBJECT_FRAMING.character` forces full-body, centered, **transparent cutout by default** (so scene backgrounds show through). Pass `spriteBackground` only when you explicitly want a baked-in backdrop (e.g. plain white for previews). After generation, **`maybe_purge_sprite_background`** runs for character outputs when the bytes are JPEG/other opaque formats (or PNG without meaningful alpha): it samples the **dominant edge color** and keys that solid fill to alpha.
- `SUBJECT_FRAMING.background` forces wide establishing scene, no characters, layered depth.
- Composition order is `framing-intro → extracted description → framing-outro → style descriptor`. Style is **last** because trailing terms anchor the overall render; framing brackets the description so the model treats extraction text as the subject, not the whole instruction.
- `normalizeStyle` fuzzy-matches loose input ("Anime / cel-shaded", "photoreal", "PIXEL") and falls back to a `neutral` style for anything unknown (per the user's choice).

Pixel-art note: FLUX/zimage tend to produce "pixel-art-flavored" smooth images, not true pixel grids. If the game applies its own pixel filter, you may want a *clean-lineart* template for filter-bound sprites rather than asking the model for pixels at 1024px — generate clean, downscale later.

---

## 4. Voice: engine roles

| Engine | Native expression mechanism | Role |
|---|---|---|
| **Edge** (free read-aloud loophole) | **rate / pitch / volume only** | **PRIMARY** |
| **XTTS v2** (offline, Coqui) | **reference audio clip** + sampling temperature | Future feature + **offline failover** |
| **Azure** (real, keyed) | **mstts:express-as** styles | Optional; only path where whisper/shout styles are real |

### THE load-bearing constraint
The free Edge endpoint **strips any SSML that real Edge couldn't generate** — it permits only a single `<voice>` + single `<prosody>`. So `mstts:express-as` (whispering/shouting/emotional styles) is **not available on the free path at all.** This was verified against the edge-tts/msedge-tts library docs. Consequence: **whisper and yell on Edge are reconstructed entirely with DSP**, since the engine gives only rate/pitch/volume.

`ENGINE_CAPS.edge.expressAs = false` and must stay false. express-as lights up only under `engine:'azure'` with a real key (off by default).

**DO NOT** try to send express-as / emotional-style SSML to the Edge engine. It will be stripped, silently, and you'll think it "didn't work" for mysterious reasons.

---

## 5. Voice: reconstructing expression from acoustic correlates

Whisper and yell are **bundles of measurable signal changes**, not single knobs. We rebuild the bundle with DSP. (All values in `DSP_PRESETS` are starting points scaled by `intensity`.)

### Whisper signature — suppress the voiced fundamental, emphasize breath
A real whisper has **no pitch** (vocal folds don't vibrate; it's shaped turbulent airflow). Lowering volume alone = "quiet talking," not whisper. Recipe:
- aggressive **high-pass** (~1200Hz) to kill chest/body resonance
- **high-shelf boost** (~4kHz) to lift the breathy air band
- moderate **gain reduction** (timbre, not just level, carries it)
- **envelope-gated pink-noise blend** — the airy turbulence layer; **the single biggest cue that sells a fake whisper**
- *Advanced alternative:* a "whisperization"/phase-vocoder effect that swaps harmonic excitation for noise while preserving formants. Better than noise-blend if available. (TODO in code.)

### Yell signature — strained + bright + dynamically flat (NOT just loud)
A clean loud signal still sounds calm. The strain is what reads as yelling. Recipe:
- raise pitch (handled in prosody)
- **hard compression** then **make-up gain** (loud AND flat — already at the ceiling)
- **saturation/drive** for harsh upper harmonics = vocal strain — **this sells it more than raw volume**
- **high-shelf** to brighten / push energy upward
- optional soft-clip at extreme intensity

### Pitch & formants (general)
Naive pitch-shift drags formants → chipmunk/giant artifacts. Preserve formants when shifting pitch (e.g. Rubber Band's formant flag) to keep "same person, different pitch."

### `intensity` (0..1)
Scales prosody strings and DSP magnitudes on Edge; maps to a temperature-like sampling knob on XTTS. Gemini infers it from punctuation, capitalization, and narration cues ("she screamed", "he muttered").

---

## 6. Voice: environment FX (engine-agnostic)

Applied to **dry** speech after expression DSP, identical for every engine — build once.
- **cave** deliberately pairs a **long reverb tail WITH discrete slap-back delays.** The early reflections (slap-back) are what make the brain localize a hard enclosed space; reverb alone reads as "big room," not "cave." Both atoms are in `ENVIRONMENT_PRESETS.cave` and order matters.

---

## 7. Voice: per-voice capability probe (recommended one-time step)

The catalog *claims* support; only a probe tells the truth for a specific voice. Some Edge neural voices silently ignore `pitch`. Build a one-time script that runs each candidate character voice through a pitch test (and, if you ever add Azure, through `whispering`/`shouting`) and records what actually took. Store the capability map; have the expression layer consult it at runtime. This mirrors the Pollinations lesson: the dashboard/catalog can't be trusted for capability/cost — verify empirically.

---

## 8. Cross-cutting: prosody/timing is the one thing DSP can't fake

DSP rebuilds **timbre**, not **rhythm**. A whisper slows and softens its attacks; a yell has sharp emphatic timing. Post-processing can't insert pauses/stress that weren't in the audio. The clean split:
- **Engine handles timing** (Edge `rate` / SSML breaks; XTTS via reference clip).
- **DSP handles timbre** (the filter chains above).
If DSP-only output sounds "off," the missing ingredient is usually timing — fix it at the synthesis layer, not with more filters.

---

## 9. Consistency theme across BOTH features

Same lesson in two places: **different backends produce different-sounding/looking output for the same input.** Different image providers → different sprites; different TTS engines → different voices for the same character. So:
- Pin a character to one image provider (+ seed) for matched sprites.
- Pin a character's voice to one engine for a consistent voice; don't mix Edge and XTTS within one playthrough/character.
The stable interface in both cases is the **tag/options object** — keep it identical across backends so swapping (or failing over) is mechanical.
