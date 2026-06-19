# HANDOFF — Two Features to Integrate

> **For the AI agent reading this (Cursor / Claude Code):**
> This package contains two **finished, tested reference modules** plus their design rationale, produced in a prior planning session. They are written to be dropped in, not rewritten. Your job is **integration, not redesign.** Do not re-architect the fallback ordering, the provider list, the expression-tag schema, or the "Edge can't do express-as" constraint — those are deliberate decisions explained in `DESIGN.md`, and several are non-obvious (they came from live API testing). If something looks "wrong," check `DESIGN.md` before changing it; it is probably load-bearing.
>
> **What you must supply** is glue: env/secrets wiring, the HTTP/DSP/TTS backends the modules call out to, and connecting these to the existing app's data flow. Both modules are **pure** — they do no I/O of their own beyond `fetch` (image module) and return plain instruction objects (voice module).

---

## TL;DR — what these two features are

1. **`freemiumImageGen.js`** — Generate character sprites and background art for the game by cascading through **free, no-credit-card** image APIs (Cloudflare Workers AI → Pollinations → Hugging Face), falling to the next on any failure. Subject-aware (character vs background) ordering, art-style templating, and seed+provider pinning for consistent character sprites. **Status: complete and tested.**

2. **`voiceExpression.js`** — Turn per-line "expression tags" (emitted by the Gemini ebook-extraction step) into concrete synthesis + DSP instructions, so a TTS engine that has **no native whisper/yell** can still produce them. Primary engine is the free **Edge** read-aloud voices; **XTTS v2** is a future/offline backend behind the same tag interface. **Status: complete and tested as a pure mapping layer; needs the app to supply the actual TTS + DSP execution.**

Both are CommonJS (`module.exports`). Convert to ESM if the host app uses it — that's a mechanical change, no logic impact.

---

# FEATURE 1 — `freemiumImageGen.js`

### What it does
`freemiumImageGen(description, options)` composes a final prompt from an extracted description + chosen subject/style, then tries providers in a subject-appropriate order and returns the first success.

### Public API
```js
const { freemiumImageGen } = require('./freemiumImageGen');

const result = await freemiumImageGen(description, {
  subjectType,     // 'character' | 'background'   (default 'character')
  style,           // 'realistic' | 'anime' | 'pixel' | 'comic' | <loose string>
  seed,            // integer, optional — for reproducibility/consistency
  preferProvider,  // 'cloudflare' | 'pollinations-seed' | 'pollinations-anon' | 'huggingface'
});
// result => { provider, model, prompt, subjectType, style, seed, bytes:Uint8Array, contentType }
```
Throws `AggregateError` (with `.errors[]`) if **all** providers fail.

Also exported: `composePrompt`, `normalizeStyle`, `normalizeSubject`, `buildChain`,
`STYLE_TEMPLATES`, `SUBJECT_FRAMING`, `PROVIDERS`, `CHARACTER_CHAIN`, `BACKGROUND_CHAIN`, `PROVIDER_CHAIN`.

### Integration checklist (do these in order)

- [ ] **1. Provide secrets (server-side only).** The module reads `process.env`:
  - `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (Workers AI permission)
  - `POLLINATIONS_TOKEN` (an `sk_...` secret key from auth.pollinations.ai)
  - `HF_TOKEN` (read token from huggingface.co/settings/tokens)
  Any provider whose keys are missing is **auto-skipped**, so the module runs with whatever subset is configured. Pollinations-anon needs no key and always works.
- [ ] **2. NEVER expose keys to the browser.** The target deploy is Cloudflare Pages (static). Put this module behind a **Pages Function** (e.g. `/functions/api/image.js`) that reads from `context.env` and proxies. Frontend calls *your* endpoint, never the providers directly. (Swap `process.env.X` → `context.env.X` for the Pages Function runtime.)
- [ ] **3. Decide the response contract** of your endpoint. The module returns raw `bytes` (Uint8Array) + `contentType`. Stream those back, or base64-encode for JSON, your call.
- [ ] **4. Wire seed + provider pinning for characters** (see "Consistency" below). Persist `result.provider` and `result.seed` per character so later poses re-pin.
- [ ] **5. (Recommended) Add a one-retry-with-backoff** around each provider for transient 429s before the chain advances. Not built in; intentionally left to the app's retry policy.

### Consistency rule for sprites (IMPORTANT — don't skip)
A seed is only stable **within one provider+model**. The same seed on Cloudflare vs Pollinations produces *different* images. So for a character that gets regenerated (new poses/expressions):
1. First generation: pick a stable per-character seed (e.g. hash the character id). Store the returned `provider` AND `seed`.
2. Later generations: pass `{ seed: storedSeed, preferProvider: storedProvider }`. The preferred provider is tried first; the rest remain as fallback.
- **Caveat:** pinning is a *soft* preference. If the pinned provider is down, the chain falls through and the look won't match. If you need matched-or-nothing for characters, add a `strictPin` behavior (throw instead of fall through). See `DESIGN.md` §Pinning.

### Free-tier facts you must respect (these define the design)
- The ONLY genuinely free + no-card + recurring providers are the four used. Everything else (fal, Replicate, Leonardo, Vertex, NVIDIA) is **trial credit** and was deliberately excluded — do not "helpfully" add them.
- On Pollinations, only `flux` (and `zimage`) are free/unlimited. All other models (klein, gptimage, seedream, nanobanana, etc.) cost Pollen. The module hardcodes `model=flux` for this reason. Do not switch the model.
- $0 ceiling is enforced structurally by **never attaching a payment method** to Cloudflare/Pollinations/HF — not by a setting. Keep it that way.

---

# FEATURE 2 — `voiceExpression.js`

### What it does
`buildExpressionPlan(tag, engine)` converts one extraction tag into an **engine-specific instruction object**. It is a PURE MAPPING — it does not synthesize audio or run DSP. The app executes the plan.

### The expression tag (what Gemini should emit per dialogue line)
```js
{
  text: "Stay close to me.",   // required
  character: "mira",            // for per-character voice / reference-clip lookup
  expression: "whisper",        // normal|whisper|yell|sad|angry (loose string ok:
                                //   "she screamed"->yell, "he muttered"->whisper)
  environment: "cave",          // open|indoor|hall|cave (cave => echo)
  intensity: 0.8                // 0..1 — how strong (Gemini infers from caps/!!!/narration)
}
```

### Public API
```js
const { buildExpressionPlan } = require('./voiceExpression');
const plan = buildExpressionPlan(tag, 'edge'); // 'edge' (primary) | 'xtts' | 'azure'
```
Returns (edge example):
```js
{
  engine: 'edge', text, character, expression, intensity,
  ssml: { rate, pitch, volume },   // send via your edge-tts client (single prosody tag)
  dsp:  [ ...ordered filter atoms... ],  // apply to returned audio, in array order
  notes: "..."
}
```
Also exported: `normalizeExpression`, `normalizeEnvironment`, `ENGINE_CAPS`,
`PROSODY_PRESETS`, `DSP_PRESETS`, `ENVIRONMENT_PRESETS`, `AZURE_STYLE_FOR_EXPRESSION`.

### THE critical constraint (do not violate)
**The free Edge endpoint cannot do emotional styles.** Microsoft strips any SSML beyond a single `<voice>`+`<prosody>` tag, so `mstts:express-as` (whispering/shouting) is **unavailable** on the free loophole. Native Edge control = **rate, pitch, volume only**. Therefore whisper/yell timbre on Edge is reconstructed **entirely in DSP**. `ENGINE_CAPS.edge.expressAs` is `false` and **must stay false**. (express-as only works on real keyed Azure — `engine:'azure'`, off by default.)

### Integration checklist (do these in order)

- [ ] **1. Supply an Edge TTS client** (e.g. `edge-tts` Python or `msedge-tts` Node) that accepts `rate`/`pitch`/`volume`. Feed it `plan.ssml`. This produces *dry, neutral* audio.
- [ ] **2. Supply a DSP stage** that can execute `plan.dsp` (an ordered list of filter atoms). Recommended backend: **ffmpeg filtergraph** (server) or **Web Audio API** (browser). Each atom has a `type` + params + a `desc` explaining intent. Map atoms → your backend's equivalent:
  - `highpass`/`lowpass`/`highshelf` → EQ filters
  - `gain` → volume
  - `compressor` → dynamics compressor (`acompressor` in ffmpeg)
  - `saturation` → soft drive/overdrive (sells the yell — this is the strain cue)
  - `noise_blend` → mix a `pink`/`white` noise source **gated to the speech amplitude envelope** (sells the whisper — biggest single cue)
  - `delay` / `reverb` → environment FX (already appended to `plan.dsp`)
- [ ] **3. Apply `plan.dsp` in array order.** Order matters (e.g. compress → saturate → gain for yell).
- [ ] **4. Run a per-voice capability probe ONCE** (see `DESIGN.md` §Voice probe) and store which voices honor pitch — some neural voices silently ignore it. Use the map at runtime.
- [ ] **5. Leave XTTS stubbed.** `engine:'xtts'` returns a `referenceClipKey` + `sampling.temperature`. When you implement it later: maintain a per-character reference-clip library (neutral/whisper/yell takes), resolve `referenceClipKey` to a file, pass `sampling` to your XTTS runner. XTTS is ALSO the **offline failover** when Edge rate-limits. The tag interface is identical, so the swap is mechanical.

### Environment FX are engine-agnostic
`plan.dsp` already includes the environment chain (e.g. cave = discrete slap-back delay + long reverb tail — the early reflections are what make the brain hear a hard enclosed space). Build the reverb/delay stage once; it serves all engines.

### Tuning note (expected, not a bug)
`PROSODY_PRESETS` and `DSP_PRESETS` are **starting points**. Pixel-perfect whisper/yell needs per-voice tuning (high-pass corner depends on the voice's pitch range). The `intensity` param scales them at runtime. A "whisperization" vocoder (replace harmonic excitation with noise while keeping formants) is a better whisper than `noise_blend` if your DSP backend has one — noted as a TODO in the code.

---

## Suggested file placement
```
/lib/imagegen/freemiumImageGen.js
/lib/voice/voiceExpression.js
/functions/api/image.js        <- Pages Function wrapper you write (proxies + holds keys)
```

## Pipeline data flow (how the two features connect to extraction)
```
ebook --> Gemini extraction -->  { character desc, background desc, dialogue lines + expression tags }
                                       |                    |                         |
                                       v                    v                         v
                          freemiumImageGen(character)  freemiumImageGen(bg)   buildExpressionPlan(tag,'edge')
                                       |                    |                         |
                                   sprite png            backdrop png          ssml + dsp plan
                                                                                      |
                                                                          edge-tts --> DSP --> audio clip
```

See `DESIGN.md` for the full rationale behind every decision above.
