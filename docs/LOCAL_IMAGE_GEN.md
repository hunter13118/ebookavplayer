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

### Known failure mode: "character sheet" mosaics (2026-07-10)

Occasionally (observed on `animagine-xl`) a character portrait generation
comes back as a tiled grid of several small faces instead of one centered
portrait — a classic SDXL "character sheet"/turnaround artifact. It's
stochastic, so it can't be fully eliminated — only made less likely and,
since this fix, caught and retried automatically.

A self-reinforcing loop made this far worse than the base stochastic rate:
`worker/_shared/reference-images.js`'s `referenceTargetsForCharacter` falls
back to a character's own **current live sprite** as its top-priority
IP-Adapter reference whenever no explicit reference crop is assigned. If
that sprite was already a broken grid, every subsequent regen conditioned
on it and reproduced another grid — confirmed live, this meant a character
could never recover no matter how many times the user regenerated. Fixed at
`/generate` (`server.py`): it now runs `_looks_like_grid` (below) against
any incoming reference image and drops it (falls back to unconditioned
generation) if flagged, rather than trusting the caller's choice of
reference. `/generate_expression_set` hard-rejects instead, since that
endpoint has no sensible fallback without a reference.

Prevention (reduces frequency, doesn't eliminate it):
- **The root-cause lever (2026-07-12): the booru tag `solo` in the positive
  prompt.** animagine-xl-3.1 is Danbooru-tag-trained — it steers on tags, not
  prose. The worker's natural-language framing ("single character, one person
  only") is the language a *prose* model wants; this model barely responds to
  it, which is why Anne (below) kept gridding through every prose-side
  mitigation. `animagine-xl`'s profile now carries
  `portrait_prompt_prefix="solo, upper body, "` (`server.py`), prepended in
  `_generate_with_retry` **only on the single-character portrait path**
  (`check_quality=True`) — scenes/backgrounds reach `_run` directly and must
  keep their legitimate multiple subjects, so they never get `solo`. `solo`
  is the model's trained signal for "exactly one character in frame" and is
  the positive-prompt counterpart to the negative terms below; this is the
  lever that actually moved the needle, not the prose or the negatives.
- Added `multiple views, character sheet, turnaround, reference sheet,
  grid, collage, tiled, multiple people, multiple faces, split screen,
  comic panel, duplicate, clone, two heads` to `_ANIME_NEGATIVE_PROMPT`
  (`server.py`). Necessary but, alone, **not sufficient** — negatives suppress
  without a positive anchor to pull toward; `solo` is that anchor.
- Reinforced the positive prompt: `SUBJECT_FRAMING.character.pre`
  (`worker/_shared/freemium-image.js`) now explicitly says "of a single
  character, one person only". Helps prose-native providers (pollinations,
  gemini) but under-steers the booru-trained local model — hence the `solo`
  tag injected server-side for `animagine-xl` specifically.
- Bad reference *inputs* also feed this: if a character's IP-Adapter
  reference crop is itself a busy multi-face or text-heavy image (see
  `_crop_is_text_heavy` above), IP-Adapter faithfully reproduces that
  layout. Keep reference crops to single clean faces.

Detection + retry (`_generate_with_retry`, `server.py`) — controlled by a
`check_quality` flag (defaults to `reference_image is not None` if the
caller doesn't set it explicitly), up to `MAX_MULTI_FACE_RETRIES` extra
attempts. Two things had to be true at once here, confirmed live both ways:
- Running the check unconditionally on every generation fired the
  (expensive, Ollama-backed) grid check on background/scene generations
  that have nothing to do with this artifact, burning 3x their generation
  time on pointless retries — backgrounds never pass `reference_image_b64`
  at all, so gating on that is correct and cheap for them.
- But `/generate`'s reference-rejection guard (above) sets `reference_image`
  back to `None` for a character portrait whose reference got flagged as a
  broken grid — inferring `check_quality` from `reference_image is not
  None` at that point would skip the gate on exactly the request that
  needs it most. `/generate` passes `check_quality=` explicitly, based on
  whether a reference was originally *requested*, not whether one ended up
  being used. Needed because animagine-xl has its own base-model tendency
  toward multi-character "character sheet" compositions independent of
  IP-Adapter — confirmed live, a fully unconditioned generation (reference
  rejected) still came back as a 5-face "queen and four attendants"
  illustration.
- `_face_count` — the same anime-face cascade used for cropping, run once
  against the whole output. Cheap, but **confirmed unreliable alone**: on a
  real captured 8-tile grid it detected only 1 face (detectMultiScale
  suppresses overlapping/adjacent boxes and wasn't trained on tightly-
  cropped grid tiles), so a still-broken image can score "clean" here.
- `_looks_like_grid` — the actual catch for what `_face_count` misses. Two
  pixel-only approaches were tried and rejected before this: per-cell face
  cascade (same recall problem as above, 1/9 cells detected on a real
  9-tile grid) and row/column edge-projection periodicity (inconsistent
  across real examples — different grids have different tile-background
  contrast, so a fixed threshold that caught one missed another). Instead
  this asks the local Ollama vision model (`gemma3:27b`, same one used for
  plate-to-character matching — see `illustration-character-match.js`) a
  direct yes/no: does this look like a tiled grid of faces rather than one
  portrait? Validated against 6 real captured examples (4 broken grids, 2
  clean portraits) with zero misclassifications. Needs Ollama reachable at
  `OLLAMA_BASE_URL`/`OLLAMA_MODEL_VISION` — fails open (treats as clean,
  same as `_face_count`) if it isn't.

An attempt is accepted only if **both** checks pass. If every one of the
`MAX_MULTI_FACE_RETRIES + 1` attempts is still flagged broken,
`_generate_with_retry` raises `GenerationQualityError` and `/generate`
converts that to HTTP 502 — this used to instead "always return an image,
even the last still-broken attempt" (best-effort, on the theory that
diffusion is stochastic and shipping something beats hanging the request).
Reversed (2026-07-11) after confirmed live: a specific character ("Anne")
reliably produced a 15-tile grid on EVERY one of 3 attempts, twice in a row
across separate regen jobs, and the old behavior committed that straight to
the user's book with no error anywhere in the pipeline. A 502 (not 500 —
this is the model's output failing our own bar, not a server bug) lets
`worker/_shared/freemium-image.js`'s `generateImage` provider-fallback
chain do what it already does for any other `local_sd` failure: try the
next configured provider instead of silently shipping known-broken art.
There still isn't a guaranteed-clean output for a genuinely stubborn
character/prompt combination — if every configured provider fails the same
way, the compare modal's "Keep previous" / regenerate remains the manual
escape hatch.

**Update (2026-07-12): Anne's actual fix was the `solo` positive tag, not
the 502.** A regen job for Anne (job `f7db988e`) ran the full retry loop,
correctly 502'd on all 3 grid attempts, then failed end-to-end anyway — the
502 fallback tier (`pollinations-i2i`) is dead in local dev because
`PUBLIC_MEDIA_ORIGIN` is unset, so Pollinations has no public URL to fetch
the `/media/` reference from. The 502 machinery worked exactly as designed;
it just had no working provider to fall through to. Two takeaways: (1) the
grid check + 502 is a *safety net*, not the fix — the fix is making
`local_sd` produce a clean image in the first place, which is what the `solo`
tag does; (2) if you want the 502 fallback to actually catch, set
`PUBLIC_MEDIA_ORIGIN` in `worker/.dev.vars` to a base URL Pollinations can
reach `/media/` on (it's only commented out in `.env.example` today).

**Inspecting failures frame-by-frame:** the retry loop used to discard every
rejected attempt in memory, so a failing character left nothing to look at.
`_generate_with_retry` now saves each attempt's raw generation to
`scripts/local-image-server/debug/attempts/` (gitignored), named
`<epoch>_<seq>_<model>_<slug>_attemptNofM_<verdict>.png` so a whole failing
job sorts chronologically and each file's verdict (`grid` / `facesN` /
`clean`) is in the name. On by default; set `SAVE_RETRY_ATTEMPTS=0` to skip
the writes. The per-attempt log line also now carries generation time and the
saved path.

### Known failure mode: concurrent requests corrupt the scheduler (2026-07-10)

`_PIPES` caches one loaded pipeline object per model profile across
requests — but every `/generate*` route is a sync `def`, which FastAPI runs
in a thread-pool worker, so two concurrent requests for the same profile
really can call `pipe()` on that same cached object from two different
threads at once. diffusers schedulers aren't reentrant: an overlap corrupts
the scheduler's internal `step_index`, and whichever request loses the race
crashes with an unrelated-looking `IndexError: index 29 is out of bounds
for dimension 0 with size 29` in `scheduling_euler_ancestral_discrete.py` —
confirmed live, twice. Fixed with a single global `threading.Lock` (`_run`,
`server.py`) serializing every `pipe()` call. A single device (MPS here)
has nothing to gain from "concurrent" generation anyway, so this is a pure
correctness fix with no real throughput cost.

### Known failure mode: a second, unrelated staleness watchdog (2026-07-11)

`worker/_shared/imaging-lock.js`'s `jobLooksStuck` has two independent
staleness checks: the provider-wait branch (`PROVIDER_STALE_MS`, tuned
above for local_sd's real timing) and a separate `atCap`/`highProgress`
branch with its own hardcoded 4-minute threshold, meant to catch a stall
*after* generation returns (e.g. stuck finalizing/writing). `step_total` on
a regen job is the ITEM count (characters/scenes/cover), not a diffusion
step count — so for the extremely common case of regenerating exactly ONE
character, `step_index (1) >= step_total (1)` is true for that item's
*entire* duration, not just once it's actually finalizing. Confirmed live:
a one-character local_sd job force-unlocked at ~7m44s — past the old
4-minute `atCap` threshold, well under the 16-minute `PROVIDER_STALE_MS` —
while the server was still legitimately retrying underneath. The job
wasn't stuck; it was killed by a second timeout nobody had touched when
`PROVIDER_STALE_MS` got bumped. Fixed by skipping the `atCap`/
`highProgress` branch whenever the provider-wait branch already owns the
staleness call for that job's `detail` string (`waitingOnProvider`) — the
two branches are for different failure modes and shouldn't both apply to
the same "still waiting on the provider" state.

### Known failure mode: explicit regen of a "stock" character (2026-07-12)

Characters split into two pools before imaging (`generic-sprites.js`'s
`planCharacterImaging` / `useStockSprite`): **custom** (AI-generated portrait)
vs **stock** (a deterministic pooled sprite at `/media/stock/…png`). A
character with fewer than `VAE_CUSTOM_SPRITE_MIN_LINES` (default 3) attributed
dialogue lines — or importance `background` — goes to the stock pool and is
never sent to any generator. This saves compute on side characters during
bulk/auto imaging.

Two bugs surfaced when a user *explicitly* selected a stock character to
regenerate (e.g. Eizo — a protagonist, but with almost no attributed lines in
a volume whose prologue barely features him):

1. **The explicit selection was ignored.** `runImaging` (`edge-imaging.js`)
   applied the stock heuristic *before* the user's filter, so a deliberately
   picked stock character just got re-assigned the same pooled sprite —
   `{ok:0, fail:0, stock:1}`, no generation, done in ~6ms. Fixed with
   `applySelectionStockOverride` (`edge-imaging.js`, unit-tested in
   `tests/selection-stock-override.test.mjs`): a `scope:"selected"` regen now
   promotes the chosen ids out of `fromStock` into `toGenerate`, so an explicit
   click always generates a real portrait (through `local_sd` etc.). The stock
   heuristic still governs bulk/auto imaging, where no one picked a specific
   character.
2. **A misleading "missing API key" error.** `imaging-regen-consumer.js`
   threw `All N image(s) failed to generate — set GEMINI_API_KEY …` whenever
   `ok === 0`, ignoring `stock`. A stock-only regen (which *succeeded*) tripped
   it, blaming an API key that was never relevant and pointing away from the
   real cause. Fixed to require `ok === 0 && stock === 0` before throwing,
   mirroring the guard `chapter-extract-pipeline.js` already used.

### Known failure mode: CLIP's 77-token limit silently ate the character's own description (2026-07-12)

`animagine-xl` (like all SDXL models here) runs through diffusers' default
CLIP text encoder, hard-capped at **77 tokens** — and diffusers truncates by
simply dropping whatever doesn't fit off the END of the prompt, with zero
prioritization. This was already a latent problem before today (the full
prose prompt — `SUBJECT_FRAMING.character.pre` + description +
`postTransparent` + the `Art style:` tag — measured **108 tokens**, already
over budget, silently losing the art-style tag and part of the transparent-
background clause on every character generation). Adding the `solo, upper
body,` prefix and the `CHARACTER_AESTHETIC_BOOST` text (below) made it much
worse: the full prompt for "Rike" measured **143 tokens**, and truncation now
cut into the middle of her OWN DESCRIPTION — the model never saw what she
actually looks like, on top of never seeing the art-style tag. Confirmed via
`transformers.CLIPTokenizer` against the real prompt strings (matches the
`"input truncated because CLIP can only handle sequences up to 77 tokens"`
warning already visible in the server's stdout on every generation, which had
gone unnoticed until now).

Fixed with a **compact prompt path used only for `local_sd`**:
`composeImagePrompt(desc, { ..., compact: true })` (`freemium-image.js`)
drops the verbose composition framing (redundant with server.py's own
`solo, upper body,` prefix) and the transparent-background clause (not
load-bearing — `postProcess`'s `ensureCharacterSpriteTransparency` /
`purgeSpriteBackground` forces a clean cutout afterward regardless of what
the model paints), keeping only a short aesthetic-tag list + the character's
own description + a short style tag. Measured at **39 tokens** total
(including the server-side `solo, upper body,` prefix) for Rike's
description — comfortably under budget with headroom for longer
descriptions. `generateImage`'s new `localPrompt` option carries this
variant; the `local_sd` tier branch uses `localPrompt || prompt` while every
other tier still gets the full cloud-oriented prose prompt (no CLIP-77
constraint on Gemini/Pollinations, and the fuller prose is a better fit for
those providers anyway). Regression-tested in `tests/freemium-image.test.mjs`.

**Known gap, not yet fixed:** `moment-generate-consumer.js`'s per-line
"moment insert" path builds its own, often much longer prompt
(`momentDescription` — location + full cast list + story-beat text) and does
NOT compute a `localPrompt`, so it still hits this same truncation class if
routed through `local_sd`. Lower priority than the character-portrait path
since moment inserts are a newer, less-used feature, but worth the same
compact treatment if `local_sd` moment generation becomes common.

### Aesthetic boost for "anime"-style character portraits (2026-07-12)

The plain `STYLE_TEMPLATES.anime` phrase ("anime cel-shaded, bold outlines,
vibrant colors") produces functionally correct but visually flat character
designs — fine for a neutral-tone book, under-selling one whose genre (e.g.
harem/romance-adjacent light novels) expects idealized, attractive
bishoujo/bishounen character art as a baseline.

`composeImagePrompt` (`freemium-image.js`) now injects a gendered aesthetic
boost — `CHARACTER_AESTHETIC_BOOST[gender]`, keyed `female`/`male`/`default`
— right after the framing preamble, gated to `subjectType === "character"`
**and** `artStyleKey(style) === "anime"` specifically:
- Never applied to backgrounds/covers (those never pass a character gender
  and shouldn't get "beautiful anime girl" boilerplate).
- Never applied to `realistic`/`pixel`/`comic`/custom styles — the tag
  phrasing here is tuned for anime character design specifically.
- Gender-aware because generic "beautiful anime girl" tags forced onto a male
  character read as a mismatch, not a compliment; `default` (gender unset)
  gets a neutral "attractive, striking features" boost instead of nothing.

Callers pass `gender: c.gender` from the character record
(`edge-imaging.js`'s per-character portrait and expression-sprite call
sites). The multi-character "moment" insert path
(`moment-generate-consumer.js`) intentionally does NOT pass a gender — a
scene can have mixed-gender cast present, so it falls through to the neutral
`default` boost rather than gendering incorrectly.

Reinforced server-side too: `_ANIME_NEGATIVE_PROMPT` (`server.py`) gained
`asymmetrical face, unattractive, plain looking, dull eyes, deformed face` —
on a booru-tag model like `animagine-xl`, the matching negative term does
real work that the positive tag alone doesn't guarantee.

Regression-tested in `tests/freemium-image.test.mjs` (gender selects the
right boost; ungated for backgrounds and non-anime styles).

### Known failure mode: noisy local_sd backdrops silently skipped transparency (2026-07-12)

`ensureCharacterSpriteTransparency` (`freemium-image.js`) does two purge
passes: an initial `maybePurgeFreemiumImage` (default `minEdgeDominance`
0.35 — the border must have one clearly dominant color), then a "forced"
retry if the result still isn't transparent enough. The forced retry used to
call `purgeSpriteBackground` with the **exact same options** as the first
pass — a no-op fallback: if the first pass failed because the border had no
single dominant color (throws `"edge background ambiguous"`), the identical
retry fails for the identical reason and silently gives up, leaving a noisy
backdrop. Confirmed as a real gap on `local_sd`/`animagine-xl`, which
sometimes paints a textured or gradient backdrop instead of a flat one
(unlike cloud providers, which tend to produce cleaner flat backdrops on the
character-portrait framing prompt).

Fixed: the forced retry now genuinely loosens its parameters —
`minEdgeDominance` down to 0.12, `tolerance` up to at least 40, `softness` up
to at least 20, wider edge-sampling `border` (4px) — so a noisy backdrop
still gets a clean transparent cutout on the second pass instead of being
left as-is. Regression-tested in `tests/sprite-bg-purge.test.mjs` (a
synthetic jittered-gray border that fails the strict first pass but resolves
on the loosened retry).

### Known failure mode: live sprite silently displaced an explicit reference (2026-07-12)

`referenceTargetsForCharacter` (`reference-images.js`) resolves reference
sources in priority order — `char.reference_images` (explicit crop/upload) →
external refs → `illustration_ref` → the character's current live sprite as a
last-resort fallback. But the live-sprite block used to `unshift` its bytes
**unconditionally**, regardless of whether a higher-priority source had
already resolved something. Since `tryLocalSd` (`freemium-image.js`) only
ever sends `referenceImages[0]` as IP-Adapter conditioning, whichever source
lands at index 0 is the *only* one that matters — and the live sprite always
won that slot.

Confirmed live: "Rike" had a clean, explicitly-assigned reference crop
visible in Character settings, but every regen still conditioned on her
current live sprite instead — which was itself a broken "character sheet"
grid. The grid reference then failed `_looks_like_grid`'s rejection check
(server.py), generation fell back to fully unconditioned, and the result had
no relation to her actual design (the `description` field alone, e.g. "A
smaller, tan toned dwarf who looks both beautiful and strong", isn't enough
signal on its own — see the `solo` tag section above for why prose-only
prompts underperform on this model). The explicit reference was sitting right
there the whole time; it just never reached the request.

Fixed by only running the live-sprite fallback when `bytes.length === 0`
after the higher-priority sources — i.e. it's a true last resort now, not a
guaranteed override. Regression-tested in `tests/reference-images.test.mjs`
(two cases: explicit reference wins when both exist; live sprite still used
when nothing else resolved).

### Known failure mode: staged/compare regens permanently skipped expression sprites (2026-07-12)

`worker/_shared/edge-imaging.js`'s expression-sprite block only fires when
`stored.promoted` is true — but `imaging-regen-consumer.js` defaults
`compare` to `true` (`opts.compare !== false`), so every regen through the
UI's normal review flow stages the result instead of promoting it
immediately. `stored.promoted` is therefore always `false` on a regen, and
the expression-sprite block silently never runs, independent of the
`generateExpressiveSprites` flag. Confirmed live: not one primary character
in a real multi-chapter book had `expressionSprites`, despite the feature
being on-by-default.

Fixed by adding a backfill trigger at the one later point that knows the
portrait actually went live: `onMediaCommitPost` (`book-actions.js`, the
"Keep new" confirm action) now enqueues a `kind: "expression-sprites"` job
whenever the just-committed character is `importance: "primary"` and still
has no `expressionSprites`. New consumer
(`worker/queue/expression-sprites-consumer.js`) loads the committed
portrait from R2 and calls the (newly extracted, shared)
`generateExpressionSpritesForCharacter()` — same generation logic the main
imaging loop uses, pinned to `preferProvider: "local_sd"` by default so all
4 buckets skip the freemium cascade and go straight to the tier that just
produced the base portrait. Doesn't change default staging behavior — a
character's expression art now generates on confirm instead of never.

Separately verified this doc's "model stays warm between requests" claim
(see the retry-button comment in `ArtCompareSheet.jsx`) against the actual
failure mode: `_PIPES` (`server.py`) never unloads on idle, and `/health`'s
`ready` stayed `true` for the whole duration of a 4-image expression-set
generation. The warmth was never actually at risk on the Python side; the
bug above was purely about the JS orchestration never reaching the
generation code path in staged/compare mode.

### Known failure mode: "cancel processing" left a bulk regen looking permanently stuck (2026-07-12)

Two compounding bugs, confirmed live against a real 16/16-chapter book
whose bulk character regen the user cancelled:

1. **`onCancelProcessingPost` assumed every cancelled job was
   extraction-phase.** It always stamped `stage: "extracting"` (or
   `"error"` with 0 chapters) regardless of what was actually running —
   cancelling a stuck `imaging-regen` job on a fully-extracted book left it
   reporting "needs extraction" instead of going back to `ready`. Fixed by
   branching on the job's `kind` (`POST_EXTRACTION_JOB_KINDS` in
   `book-actions.js`: `imaging-regen`, `expression-sprites`,
   `expression-repass`, `illustration-character-match`,
   `moment-generate`) — but the job record is frequently already gone by
   the time cancel runs (see #2), so `chapters_ready >= total_chapters` is
   used as an equally reliable, race-proof fallback signal: a book with
   every chapter already extracted couldn't have been running an
   extraction-phase job in the first place.
2. **Cloudflare Queues has no cancel primitive**, so a running consumer
   invocation (mid bulk-regen, generating character N of many) keeps
   running to completion on its own — "cancel" only ever marked the KV job
   record terminal, which does nothing to the actual in-flight loop still
   generating characters N+1, N+2, etc. Worse: `imaging-lock.js`'s passive
   staleness reconciliation (runs on every `GET /books` poll) can itself
   clear `active_job_id` and stale-mark the job in the background, so by
   the time a user's cancel click lands, the book record may have nothing
   left pointing at the job at all — a real, confirmed-live race, which is
   also why fix #1 needed the chapters-ready fallback rather than trusting
   the job lookup alone.

   Fixed with an explicit `cancelled: true` marker
   (`markJobStale`'s new option, `imaging-lock.js`) plus two check points:
   - `dispatch.js` checks it before routing ANY queued message to its
     consumer — a message still purely queued (never started) when
     cancelled now no-ops instead of doing the work anyway.
   - `runEdgeImaging` / `generateExpressionSpritesForCharacter`
     (`edge-imaging.js`) take an optional `checkCancelled` callback, polled
     between characters/backgrounds/expression buckets — wired from
     `imaging-regen-consumer.js` and `expression-sprites-consumer.js` via
     `isJobCancelled(env, job_id)`. A cancelled job stops picking up NEW
     items instead of grinding through its entire remaining plan; whatever
     item was already mid-generation still finishes (an in-flight
     `fetch`/generation call can't be aborted either), and everything
     generated before the cancel is kept, not thrown away.

   This is as close to "clear the queue" as a queue-based architecture
   without a true kill switch gets — genuinely instant cancellation would
   need a different execution model (e.g. Durable Object-driven polling
   instead of Queues), out of scope here.

### Manual override: force a reference the auto-guard rejected

`_looks_like_grid` (the vision-model classifier) is a heuristic, not
infallible. If you've looked at a character's current image and are
confident it's actually fine — the guard flagged a false positive, or you
specifically want continuity with a known-imperfect image over the
auto-guard's judgment — check "Force current image as reference" in the
Replace Art sheet before regenerating that character. This sets
`force_reference: true` on the request, which flows
`ReplaceArtSheet.jsx` → `selectionToGenerateBody` → `generate-media` body →
`imagingFilterFromOpts` (`imaging-regen-consumer.js`) → `generateImage`'s
`forceReference` option (`edge-imaging.js`, `freemium-image.js`) →
`/generate`'s `force_reference` field (`server.py`), where it skips the
`_looks_like_grid` check on the incoming reference entirely. Only meaningful
for a targeted character selection (IP-Adapter conditioning is
character-specific) — the checkbox is hidden for a backgrounds/cover-only
selection.

## Endpoints

```
GET  /health
-> {"status", "default_model", "device", "device_reason", "ready"}

GET  /models
-> {"default": str, "profiles": {id: {repo_id, steps, guidance_scale, default_width, default_height, loaded}}}

POST /generate
body: {"prompt": str, "width"?: int, "height"?: int, "model"?: str,
       "reference_image_b64"?: str, "ip_adapter_scale"?: float,
       "force_reference"?: bool}
-> 200, image/png, raw bytes
-> 502, if every quality-gate retry attempt still shows the character-sheet
   grid artifact (see GenerationQualityError) — the worker's provider
   fallback chain treats this like any other local_sd failure
(force_reference skips the broken-grid reference-rejection guard — see
"Manual override" above)
(this is the contract worker/_shared/freemium-image.js's tryLocalSd and
legacy/server/images/backends.py's _try_local_http actually call — the production
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

POST /crop_faces
body: {"image_b64": str, "max_faces"?: int}
-> {"count": int, "crops": [base64 PNG, ...]}
(wraps detect_and_crop_faces.py's crop_faces_from_bytes — used by
worker/queue/illustration-character-match-consumer.js's
cropAndStoreReference to turn a matched EPUB plate into a tight
head+upper-body reference crop per character, stored to
media/{bookId}/character-refs/{charId}/ and fed back into generation via
tryLocalSd's reference_image_b64. Best-effort: 0 detected faces just returns
an empty crops list, not an error.)

POST /ocr_faces
body: {"image_b64": str}
-> {"count": int, "matches": [{"label": str, "bbox": [x,y,w,h], "crop_b64": str}, ...]}
(some plates caption each pictured character's name directly on the image —
a labeled group shot. Runs Tesseract OCR to find name-like captions, pairs
each with its nearest detected face via crop_named_faces_from_bytes, and
returns one crop per confidently-paired face. Used by
illustration-character-match-consumer.js's ocrNamedCropsForPlate, which
fuzzy-matches each label against the book's character roster and stores a
match directly as that character's reference image — lets a single
multi-character captioned plate map straight to several character profiles
at once, instead of the usual one-plate-one-character whole-plate match.
Requires the system `tesseract` binary — `brew install tesseract` — plus
`pytesseract` in the venv. Best-effort: no OCR text, no faces, or no
confident label/face pairing all just return an empty matches list.)
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

[legacy/server/images/expression_sprites.py](../legacy/server/images/expression_sprites.py)
already has real logic for this: `collect_character_expressions()` scans a
book's actual dialogue lines (via `infer_expression_from_text`) to figure out
which expressions (`sad`, `angry`, `whisper`, `yell`, `happy`, `surprised`) a
given character actually needs portraits for, and
[legacy/server/images/generate.py:318-347](../legacy/server/images/generate.py#L318) already
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

**Note:** the actual edge-worker caller
(`edge-imaging.js`'s `generateExpressionSpritesForCharacter()`, see
`docs/EXPRESSION_SENSITIVITY_PLAN.md`'s 3d section) does **not** call this
`/generate_expression_set` batch route — it calls `generateImage()` (→
`/generate`) once per bucket through the normal freemium provider chain,
pinned to whichever provider produced the base portrait. Same real
generation cost either way (both are sequential single-image calls under
the hood), but it means this endpoint is currently only reachable directly
via curl/testing, not from the live product. Worth unifying onto this route
later if the per-call freemium-chain overhead (still just a tier lookup
when pinned, not a real cascade) ever matters.

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

# OCR for /ocr_faces (in-image name-caption -> character-crop matching):
brew install tesseract
pip install pytesseract

python3 scripts/local-image-server/server.py
# Exposes /health, /models, /generate, /generate_batch, /generate_expression_set, /crop_faces, /ocr_faces on :7860
```

Set in root `.env`:
```bash
LOCAL_IMAGE_URL=http://127.0.0.1:7860
LOCAL_IMAGE_MODEL=animagine-xl   # sdxl-turbo has no IP-Adapter profile — needed for character-reference/crop matching
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
| Production contract this backs | [worker/_shared/freemium-image.js](../worker/_shared/freemium-image.js) (`tryLocalSd`), [legacy/server/images/backends.py](../legacy/server/images/backends.py) (`_try_local_http`) |
| Dormant expression-variant logic this revives | [legacy/server/images/expression_sprites.py](../legacy/server/images/expression_sprites.py), [legacy/server/images/generate.py:318-347](../legacy/server/images/generate.py#L318) |
| Env vars | [.env.example](../.env.example) |
| General setup | [SETUP.md](../SETUP.md) |
| The analogous Ollama/LLM local-extraction benchmark | [LOCAL_LLM_EXTRACTION.md](LOCAL_LLM_EXTRACTION.md) |
| Future: route local-LLM needs (extraction + image gen) through War Council instead | [ECOSYSTEM_INTEGRATION.md](ECOSYSTEM_INTEGRATION.md) |
