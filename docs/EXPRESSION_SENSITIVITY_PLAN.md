# Expression Sensitivity Plan — "Make It a Performance"

**Status:** fully implemented — Phases 0, 1a-1f, 2, 3a-3d, and Phase 4
(performance-mode dial, tension state machine, director's log overlay,
interrupted-dialogue continuity) are all landed (see file references inline
below). The cost-gated items (1d/1e's LLM re-pass, 3d's alt-sprite
generation) ship opt-in, exactly as designed.

**Update (2026-07-12):** 3d's alt-sprite generation (`generateExpressiveSprites`)
flipped from off-by-default to **on-by-default** at upload
(`web/src/components/Uploader.jsx`'s checkbox) — still gated to
primary-importance characters only (real cost control: 4 extra ~90-150s
local generations per primary character), but no longer requires the user to
know to check a box for it to show up at all. Also fixed a real bug: regen
(`worker/queue/imaging-regen-consumer.js`'s `handleImagingRegenMessage`)
never passed `generateExpressiveSprites` to `runEdgeImaging` at all, so it
silently defaulted to `false` on every regen regardless of the original
upload setting — expression sprites could never be (re)generated outside the
initial ingest. Now defaults to `true` on regen too, overridable via
`opts.generate_expressive_sprites: false`.

Also added a way to actually SEE the generated expression sprites, which
nothing in the UI rendered before: a new "Characters" toolbar button
(`web/src/components/Player.jsx`, next to "Illustrations") opens
`CharacterRosterSheet.jsx` — a read-focused browse view (distinct from
`EpubPlatesSheet`/`CharacterManager.jsx`'s heavier rename/merge/description
editing sheet, still reached from the settings menu). Lists every character
with a collapsible "Expressions" section reading `character.expressionSprites`
(`{bucket: url}`, populated by the fix above), thumbnail previews, and
click-to-enlarge via the same `ImageLightbox` already used for character
reference-picture previews.

**Update (2026-07-12, later same day) — the regen-default fix above still
left every primary character with no expression art, root-caused live:**
`runEdgeImaging`'s expression-sprite block requires `stored.promoted`
(`edge-imaging.js`), but `imaging-regen-consumer.js` defaults `compare` to
**`true`** (`opts.compare !== false`) — every regen through the UI's normal
review flow stages the base portrait for confirm rather than promoting it
immediately, so `stored.promoted` is always `false` at generation time and
the expression-sprite block is silently skipped, regardless of
`generateExpressiveSprites`. Confirming the staged portrait afterward
(`onMediaCommitPost`) doesn't help either — the check only ever ran once,
inline, during the original generation call. Net effect: confirmed live
against a real book, NONE of its primary characters (including ones imaged
after 3d shipped) had any `expressionSprites` — the default staged/compare
workflow made this a near-100%-miss path, not an edge case.

Fixed with a backfill trigger rather than changing the default imaging
behavior (staging-by-default is intentional, for review):
- `generateExpressionSpritesForCharacter()` extracted out of
  `edge-imaging.js`'s inline loop into a standalone exported function (same
  logic, now shared) — takes a character + base-image bytes and returns the
  generated `{bucket: url}` map.
- `onMediaCommitPost` (`worker/api/v1/book-actions.js`) — the "keep new"
  confirm action — now checks, right after a `kind: "characters"` commit:
  is this character `importance === "primary"` and still missing
  `expressionSprites`? If so it enqueues a new `kind: "expression-sprites"`
  job and returns its id as `expression_sprites_job_id` in the response.
- New consumer `worker/queue/expression-sprites-consumer.js` loads the
  now-live committed portrait from R2 as the reference, generates the 4
  buckets via the shared function, and patches both
  `character.expressionSprites` and any already-compiled scene lines'
  `sprite_url` for that character.
- **Model warmth:** the shared function pins `preferProvider` to
  `local_sd` by default (rather than re-running the full
  Gemini→freemium→local_sd cascade per bucket) — `orderTiersForPreference`
  (`freemium-image.js`) then tries `local_sd` first for all 4 calls, no
  retries/timeouts against unrelated providers in between. Separately
  confirmed the Python image server itself never needed a "keep warm" fix:
  `_PIPES` (`scripts/local-image-server/server.py`) caches the loaded
  pipeline for the life of the process with no idle-unload logic, and
  `/health`'s `ready` stayed `true` throughout a full 4-bucket generation.
- **Caveat:** this only fires on the staged/compare path (the default). A
  regen explicitly run with `compare: false` still generates expression
  sprites inline as before — untouched.
- Verified end-to-end live: staged regen of a primary character → commit →
  `expression_sprites_job_id` returned → job reaches `status: "done"` →
  `CharacterRosterSheet.jsx` shows all 4 expression thumbnails instead of
  "No expression art yet."

**Update (2026-07-12, later still) — regenerate ONE expression bucket:**
there was previously no way to redo a single bad expression variant without
regenerating the whole character (which would also silently skip expression
sprites again unless staging was bypassed — see above). Added:
- `POST /books/:id/characters/:characterId/expressions/regen` (body:
  `{ bucket }`, one of `DEFAULT_EXPRESSIVE_BUCKETS`) — `onExpressionSpriteRegenPost`
  in `book-actions.js`. Validates the character exists, is `importance:
  "primary"`, and already has a base portrait, then enqueues the same
  `kind: "expression-sprites"` job with a `buckets: [bucket]` override.
- `expression-sprites-consumer.js` now reads `message.body.buckets` and
  passes it through to `generateExpressionSpritesForCharacter`'s
  `expressiveBuckets` param when present, instead of always regenerating
  all 4 — so a single-bucket request only touches that one, leaving the
  other 3 untouched.
- UI: `CharacterRosterSheet.jsx` gained a second collapsible per primary
  character, "▸ Regenerate expression" — separate from the read-only
  "▸ Expressions" browse section above it (only rendered when
  `importance === "primary"` and a base sprite exists). Expanding it shows
  a bucket `<select>` (mirrors `REGENERATABLE_BUCKETS`, which must stay in
  sync with `DEFAULT_EXPRESSIVE_BUCKETS`) and a "Regenerate" button;
  progress is tracked via `subscribeJobEvents`/`jobEventToStatus` (the same
  generic job-SSE primitives every other regen action uses), and
  `Player.jsx` passes `onRefresh={refreshBook}` so the new thumbnail shows
  up automatically once the job reports `done` — no manual reload needed.
- Verified end-to-end live: regenerated `angry` then `sad` for a character
  that already had all 4 buckets — both got fresh cache-busted URLs while
  `happy`/`surprised` kept their original timestamps untouched, confirming
  the single-bucket scoping actually scopes.

**Update (2026-07-12, later still) — same control, also in "Replace art":**
the per-expression regen control only lived in `CharacterRosterSheet.jsx`
(the read-focused browse sheet). User asked for it in "the regenerate art
section too" — `ReplaceArtSheet.jsx`, the main art-picker/regen sheet
reached via `PlayerMenu.jsx`'s "Replace art…". Extracted the control out of
`CharacterRosterSheet.jsx` into its own file,
`web/src/components/ExpressionRegenControl.jsx` (exports the component plus
`REGENERATABLE_BUCKETS`/`bucketLabel`/`canRegenExpression`), and both sheets
now import it — no duplicated logic. In `ReplaceArtSheet.jsx`, each
`kind: "characters"` tile that passes `canRegenExpression` (primary +
already has a base portrait) gets wrapped in a `.vae-art-tile-wrap` div
containing the existing tile button plus the control stacked below it
(nested `<select>`/`<button>` can't live inside the tile's own `<button>`,
hence the wrapper instead of appending to it). Added
`.vae-art-tile-wrap`-scoped CSS overrides so the select/button stack
vertically rather than side-by-side — the art picker's grid columns are
96-140px, too narrow for the roster sheet's wider layout. Verified live:
"Regenerate expression" appears under Anne/Diana/Emperor's tiles (primary)
but not Boris's (secondary), and expanding it renders a working
select+button inside the narrow tile column.

**Goal:** right now `expression` is real (schema → extraction → compile → sprite CSS →
image prompts) but under-triggers, and even when it fires, over half of what the model
actually says is thrown away downstream. Target vibe: **highly expressive, almost
dramatic visuals and audio — the player should feel like it's staging a performance,**
not just reading text aloud over a static portrait. Especially: the character currently
*speaking* should visibly and audibly perform the line, not just stand there.

## Where this comes from

Verified by hand on `My Quiet Blacksmith Life in Another World, Vol. 05`, Chapter 1
("The Family Who Lives in the Forest"):

- The already-extracted book (cloud-provider pass) has **246/3,022 lines (8%)** tagged
  non-`"normal"` across the whole book, with **70+ distinct free-form values**
  (`angry`, `sad`, `smiling`, `embarrassed`, `reflective`, `excited`, …) — so the model
  *can* produce rich tags.
- But **Chapter 1 specifically got 100% `"normal"`** — 44/44 lines, and 0 `delivery`
  lines despite at least one explicit shout (`"No major injuries, please," I shouted at
  the two of them.`) in the source text.
- Re-ran Chapter 1 in isolation through **local Ollama `qwen2.5:7b`** (fully local, no
  cloud call) as its own single-chapter book (`blacksmith-vol5-ch1`) — same result:
  **100% `"normal"` on all 53 lines**, and the `"I shouted"` tag was never split into a
  `kind=delivery` line at all, despite `dialogue-rules.js` explicitly instructing that.
- So: this isn't a "cloud model good, local model bad" gap. Both under-tag. The
  instruction to tag expression is real but structurally weak, and there's no feedback
  loop that catches a chapter coming back flat.

## Root causes (four independent leaks)

1. **The expression instruction is one buried line.** The entire guidance for this
   field, in the ~150-line mega-prompt, is:
   `worker/_shared/dialogue-rules.js:116`
   ```
   - expression: normal|whisper|yell|sad|angry — match delivery when emotional.
   ```
   It's the second-to-last bullet in a rules block that's almost entirely about
   dialogue attribution and speaker resolution. No examples, no taxonomy beyond 4
   words, no instruction about *how often* to use it or what counts as "emotional
   enough." An LLM under instruction-density pressure will satisfy the loud,
   example-heavy rules (attribution, verbatim text) and silently default the quiet,
   example-free one.

2. **Extraction temperature is 0.2 everywhere**
   (`worker/_shared/freemium-extract.js:133,182,213`). Good for keeping JSON
   well-formed across a huge structural mega-pass; bad for a subjective/creative
   judgment call like "what is this character feeling" — low temperature collapses
   exactly the kind of ambiguous categorical choice expression-tagging is toward the
   single most common token, which is `"normal"`.

3. **No audit/repair loop.** `worker/_shared/dialogue-repair.js` already does a
   deterministic repair pass post-extraction (splitting mis-classified speech tags,
   normalizing delivery verbs) — but nothing similar exists for expression. A chapter
   can come back 100% flat and nothing downstream ever notices or retries it.

4. **Downstream consumption can't use what little variety does exist:**
   - `web/src/styles.css:65-68` only defines CSS for 4 of the ~70+ real values
     (`expr-angry`, `expr-sad`, `expr-whisper`, `expr-yell`). Everything else
     (`smiling`, `embarrassed`, `reflective`, `excited`, ...) resolves to an inert
     class with zero visual effect — **over half of all real non-normal tags produce
     no visible change today.**
   - `worker/api/v1/tts.js` never reads `expression` at all, even though
     `web/src/audio/playSpeech.js:68` already sends it in every request body. Delivery
     is emotionally flat regardless of tag, on the live Workers pipeline. (A legacy
     Python DSP module, `server/audio/voice_expression.py` /
     `server/audio/expression_dsp.py`, did this once — it's explicitly reference-only
     per `HANDOFF.md`, not on the active path.)
   - Sprites are one static image per character. There is no visual difference between
     a character delivering a throwaway narration beat and a character screaming.

The fix has two halves that reinforce each other: **make the model tag more, and
build somewhere for those tags to actually go.** Doing only the first wastes the
signal; doing only the second has nothing to render.

---

## Design goals

- **Bias toward expressive, not neutral.** `"normal"` should be the exception for
  dialogue, not the default. Silence/flatness is a choice the model should have to
  justify implicitly by everything else pointing that way, not fall into.
- **Speaking characters get the spotlight — literally.** The plan's title says
  "especially when a given character is speaking": prioritize the *currently-speaking*
  sprite for every dramatic treatment (visual + audio) over narration lines, which stay
  calmer by comparison. This contrast is what will sell the "performance" feeling —
  narration is the stage, dialogue is the actor stepping into the light.
- **Cheap wins before expensive ones.** Some of this is prompt/schema/CSS work
  (hours). Some is new image-gen and audio-SSML work (real cost/latency). Phase things
  so the free/deterministic tricks land first.
- **Provider-agnostic.** Whatever we build needs to work the same whether extraction
  ran on Gemini or on local Ollama — both under-tag today, both need the same fix.
- **Reversible / tunable.** Add a "how much drama" dial so this doesn't overshoot into
  self-parody for every reader by default.

---

## Phase 0 — Diagnostics (do this first, it's cheap and prevents flying blind)

Add a small standalone script, e.g. `scripts/audit_expression.py` (or a `.mjs`
twin next to the existing `scripts/validate_extract.py`), that:

- Loads a book's compiled `playback.json` (or hits `GET /books/:id`).
- Reports, per chapter: line count, % non-`"normal"`, distinct expression values used,
  and count of `kind=dialogue` lines with `expression=="normal"` next to a
  `delivery_verb` or exclamation-heavy punctuation (`!`, `?!`, ALL CAPS) — i.e. lines
  that *look* emotional in the raw text but got tagged flat anyway.
- Flags any chapter under a configurable threshold (start at 5%) as "suspiciously
  flat" — this is exactly what would have caught Chapter 1 automatically instead of
  us finding it by hand.

This becomes the regression fixture for everything else: re-run it against
`blacksmith-vol5-ch1` (already sitting in local `data/`/R2 from this session) before
and after each phase below. We have a known-bad baseline (100% normal, both providers)
to compare against for free.

---

## Phase 1 — Extraction sensitivity (get the signal in the first place)

### 1a. Rewrite the expression instruction as a first-class rule, not an afterthought

Replace `dialogue-rules.js:116`'s single line with something with the same density of
guidance as the dialogue-attribution rules above it. Sketch:

```
EXPRESSION (apply to every dialogue/delivery/thought line — be decisive, not cautious):
  Default to a SPECIFIC emotional read. "normal" is reserved for genuinely flat,
  matter-of-fact lines (plain exposition, routine logistics) — NOT the safe default
  when unsure. If dialogue carries ANY charge (a question, a tease, mild surprise,
  affection, irritation) tag it as such rather than falling back to normal.

  Canonical buckets (use these as your primary vocabulary; freeform is still allowed
  for flavor but MUST map conceptually onto one of these):
    yell, angry, whisper, sad, scared, surprised, happy, excited, embarrassed,
    smug, tender, nervous, sarcastic, determined, desperate, normal

  Signals that should almost always produce a non-normal tag:
    - Exclamation points, question marks stacked with exclamation ("?!"), ALL CAPS
      words → yell/angry/excited/scared depending on content.
    - A delivery verb already present (sang, shouted, whispered, sobbed, hissed,
      teased, snapped, growled...) → derive the bucket directly from the verb
      (see mapping table below) — do not separately re-guess and default to normal.
    - Endearments, compliments, physical affection described in the beat → tender/happy.
    - Self-deprecation, apology, hedging ("I guess", "maybe", trailing off) → nervous/
      embarrassed, not normal.
    - Direct insults, commands, clipped short sentences in a conflict beat → angry.

  intensity (0.0-1.0) is independent of the bucket: a "sad" line can be a quiet ache
  (0.3) or a full breakdown (0.9). Use the full range — do not cluster everything at
  0.5.
```

Also update `worker/_shared/extract-prompt.js:31-34`'s `SCHEMA_HINT.scenes[].lines[].expression`
string to list the full canonical bucket set (currently just
`"normal|whisper|yell|sad|angry"`), so the schema hint and the rules agree.

### 1b. Deterministic verb→expression inference (free, zero LLM calls, catches misses)

`dialogue-repair.js` already has `STYLIZED_VERBS` (sang, yelled, whispered, growled,
hissed, sneered, teased, grinned, wept, ...) and adverb-tail regexes
(`ADVERB_TAIL`: quietly, coldly, sharply, gently...). Add a
`inferExpressionFromDelivery(line, precedingDeliveryLine)` step in the same repair pass
that:

- If a `kind=delivery` line with a known `delivery_verb` immediately follows/precedes a
  `dialogue` line still tagged `normal`, overwrite the dialogue line's expression using
  a verb→bucket table (`yelled/shouted/screamed→yell`, `whispered/murmured→whisper`,
  `sobbed/wept→sad`, `growled/hissed/snapped→angry`, `laughed/chuckled/grinned→happy`,
  `stammered/stuttered→nervous`, `teased/smirked→smug`, ...).
  This alone would have fixed the one shout we found in Chapter 1 — the model correctly
  captured `"I shouted at the two of them"` as text (even though it failed to split it
  into a `delivery` line — see 1c), but a lighter regex pass over the dialogue line's
  own trailing tag text can catch this even when the LLM doesn't split kind correctly.
- If an adverb tail (`ADVERB_TAIL` match: "quietly", "coldly", "sharply"...) is
  attached to a speech tag, nudge intensity/bucket similarly (quietly→whisper/-0.2
  intensity, sharply→angry/+0.2 intensity).

This is pure post-processing — no extra LLM cost, no extra latency, works identically
regardless of which provider did the original extraction, and directly patches the
gap we found (verb correctly captured in text, but not translated into structured
signal).

### 1c. Fix the missed `kind=delivery` split (separate but related bug)

We independently found the local Ollama pass never emitted a single `kind=delivery`
line for the whole chapter, despite `"I shouted at the two of them"` being exactly the
pattern `dialogue-rules.js` step 2 describes. Worth a small dedicated fix/test in
`dialogue-repair.js` (or the extraction prompt's few-shot examples in
`DIALOGUE_EXAMPLES`) — this is upstream of expression accuracy since delivery-verb
inference (1b) depends on delivery lines/tags actually being segmented out.

### 1d. Focused second pass on dialogue lines only (bigger lever, real cost)

The mega-pass asks one model call to do structural segmentation, speaker attribution,
scene boundaries, AND emotional read, all at once, at temperature 0.2. Add an optional
second, narrow pass — same shape as `dialogue-repair.js` but LLM-backed instead of
regex-backed — that:

- Takes only the already-extracted `kind=dialogue` lines (small, cheap payload — no
  need to re-send the whole chapter text).
- Runs a single-purpose prompt: *"For each numbered line below, given the short context
  window around it, output ONLY {index, expression, intensity} using the canonical
  bucket list. Be decisive."*
- Can safely run at a higher temperature (0.5-0.6) than the structural pass, since
  malformed JSON risk is much lower for a flat `{index, expression, intensity}[]` shape
  than for the full nested scene/character tree.
- Works with any provider already wired in `freemium-extract.js`, including
  `ollama-7b` — this is a good candidate to *default* to the local model even when the
  main extraction used cloud, since it's cheap/fast/low-stakes and keeps recurring
  cost off Gemini.
- Wire this into `chapter-extract-pipeline.js` right after `attributeAnalysis()` and
  before `compileChapterPlayback()`, gated by an env flag
  (`VAE_EXPRESSION_REPASS=1`) so it can be toggled per environment while testing.

### 1e. Audit-triggered retry

Using the Phase 0 auditor's "suspiciously flat" signal: if a chapter comes back under
the threshold, automatically re-run 1d's focused pass on just that chapter (cheap,
since it's a small dialogue-only payload) before finalizing the checkpoint. This is
the automated version of what we did by hand this session.

### 1f. (stretch) Character emotional baseline

Add an optional `AnalysisCharacter.temperament` field (free text or a small enum:
`stoic`, `excitable`, `dry/sarcastic`, `warm`, `volatile`) — either inferred by the
mega-pass from how a character is introduced, or left blank and user-editable via the
existing `CharacterManager.jsx`. Feed it into the Phase 1d focused pass as context
("Rike is established as blunt and dry — her 'normal' baseline already reads flatter
than other characters, weight accordingly") so two characters saying similarly mild
lines don't necessarily get identically flat tags. This is what starts making the
performance feel *directed* rather than uniformly amplified.

---

## Phase 2 — Audio: close the TTS gap entirely (currently: zero effect, so this is pure upside)

`playSpeech.js:68` already sends `expression`, `environment`, and `intensity` in every
TTS request. `worker/api/v1/tts.js` currently ignores all three. Fix:

1. In `worker/api/v1/tts.js`, read `body.expression` and `body.intensity` and map to
   Edge-TTS prosody params (`synthesizeEdgeMp3` already accepts `rate`, `pitch`,
   `volume` per `worker/_shared/edge-tts.js`) via a bucket→prosody table, scaled by
   intensity:

   ```
   yell:      pitch +10~20%, rate +10~15%, volume +20~30%
   angry:     pitch  +5~15%, rate  +5~10%, volume +10~20%
   whisper:   pitch  -5~10%, rate  -5~15%, volume -30~45%
   sad:       pitch -10~15%, rate -10~20%, volume  -5~10%
   scared:    pitch +10~15%, rate +15~25%, volume  +0~10%
   excited:   pitch  +5~15%, rate +10~20%, volume  +5~15%
   tender:    pitch  -3~8%,  rate  -5~10%, volume  -5~10%
   normal:    no offset
   ```
   Scale the offset by `intensity` (0-1) rather than applying it flat — this is where
   the existing-but-unused `intensity` field earns its keep, and it's the difference
   between "audibly performed" and "randomly pitch-shifted."
   Combine additively with whatever per-character pitch/rate override already exists
   from `voice-assign.js` / `PlayerMenu.jsx`, don't replace it.

2. This is provider-agnostic and costs nothing extra per line (same Edge-TTS call,
   different SSML-ish params) — highest-value, lowest-cost item in this whole plan.

3. **(stretch, gate behind a setting)** Short stinger SFX layer: a very small library of
   3-4 generic, non-intrusive audio cues (soft chime for `surprised`, a low thud for
   `yell`/high-intensity `angry`, a hush/breath for `whisper`) mixed in at low volume
   under the TTS line, only above an intensity threshold (e.g. >0.75) so it's rare
   enough to land instead of becoming noise. Orchestrated from
   `web/src/audio/orchestrator.js` alongside the existing audio↔sprite↔text sync — this
   is the one file the repo's own guardrails say is the single source of truth for
   timing, so any new audio layer must hook in there, not duplicate timing logic
   elsewhere (see `CLAUDE.md`'s guardrails section).

4. **(stretch)** Ambient bed ducking tied to `intensity`: if/when background ambience
   exists for a scene, duck it further on high-intensity lines and let it breathe back
   on calm narration — cheap continuous variable, no new assets needed.

---

## Phase 3 — Visual: make the *speaking* sprite perform

### 3a. Expand the CSS taxonomy to match the canonical bucket list

`web/src/styles.css` currently has 4 rules. Extend to cover the full Phase 1a bucket
list, and make the treatments bigger/more "stage lighting" than the current subtle
scale/saturation tweaks — this is the "almost dramatic" part of the brief:

```css
.vae-sprite.expr-yell .vae-sprite-art img       { transform: scale(1.08); filter: contrast(1.15) saturate(1.1); animation: vae-punch-in .18s ease-out; }
.vae-sprite.expr-angry .vae-sprite-art img      { filter: saturate(1.15) contrast(1.1); animation: vae-shake .32s ease-in-out; }
.vae-sprite.expr-scared .vae-sprite-art img     { filter: saturate(.85) brightness(1.05); animation: vae-tremble .4s ease-in-out infinite; }
.vae-sprite.expr-sad .vae-sprite-art img        { filter: saturate(.75) brightness(.9); transition: filter .6s ease; }
.vae-sprite.expr-whisper .vae-sprite-art img    { transform: scale(.97); opacity: .92; filter: blur(.3px); }
.vae-sprite.expr-surprised .vae-sprite-art img  { animation: vae-punch-in .22s ease-out; }
.vae-sprite.expr-happy .vae-sprite-art,
.vae-sprite.expr-excited .vae-sprite-art        { animation: vae-bounce .5s ease-in-out; }
.vae-sprite.expr-embarrassed .vae-sprite-art img{ filter: saturate(1.05) hue-rotate(-4deg); animation: vae-wobble .4s ease-in-out; }
.vae-sprite.expr-tender .vae-sprite-art img     { filter: brightness(1.05) saturate(1.05); transition: filter .8s ease; }
.vae-sprite.expr-smug .vae-sprite-art img       { transform: rotate(-1.5deg) scale(1.02); }
```
Plus keyframes (`vae-punch-in`, `vae-shake`, `vae-tremble`, `vae-bounce`, `vae-wobble`)
— short (200-500ms), triggered once per line via the existing `key={character.sprite ||
character.character_id}` remount pattern already in `Sprite.jsx:46`, or a
line-index-keyed variant so the animation replays every time even if expression repeats
on consecutive lines by the same character.

Also add a normalization layer (`web/src/expressionBucket.js`, mirrored on the worker
side for the TTS mapping in Phase 2) so any of the 70+ freeform values the model
produces map onto one of the ~16 canonical CSS/audio buckets — e.g. `"giggling" |
"amused" | "delighted" → happy`, `"grimacing" | "furrowing eyebrows" → angry`,
`"murmuring" | "hushed" → whisper`. This is the same normalization
`worker/_shared/moment-inserts.js:14`'s `normalizeExpression()` already gestures at but
doesn't actually bucket — extend it into a real many-to-one map, shared between the
worker (audio) and web (visual) sides so they never disagree about what a given
freeform tag means.

### 3b. Speaking-sprite spotlight escalation

`Stage.jsx:75` already only passes `expression` to the currently-speaking sprite
(`p.character_id === speakerId ? curExpression : undefined`) — good, that scoping is
already right. Extend the *staging*, not just the per-sprite filter:
- On high-intensity dialogue (`intensity > 0.7`), briefly increase the speaker's
  `spotlight`/`dim` contrast against other present characters beyond what idle
  speaking already does — e.g. a faster dim-transition on everyone else, a very slight
  camera-zoom on the whole stage container (`transform: scale(1.02)` on `.vae-stage`
  for the animation's duration) so it reads as a push-in, not just a filter change.
- On `yell`/`angry` at high intensity, a very brief (1-2 frame) full-stage flash/shake
  — same idea as an anime "impact frame." Must be subtle enough to not be seizure-risk
  or obnoxious on repeat; this is exactly what the Phase 4 intensity dial should let
  users turn down or off.

### 3c. Dramatic text rendering for dialogue/subtitle

Wherever the current line's text is rendered (subtitle/dialogue box), react to
`expression`/`intensity` too, not just the sprite:
- `yell` → larger font-size step and/or a brief letter-spacing pop-in.
- `whisper` → smaller, slightly transparent, maybe a fade-in instead of the normal
  typewriter reveal speed (slower).
- High intensity → the existing typewriter reveal speed (already synced in
  `orchestrator.js`) could speed up for yelling / slow down for whispering, since
  reveal pace already exists as a mechanism — reuse it as a drama lever instead of
  adding a new one.

### 3d. (bigger stretch) Per-character alt-expression sprites — the infrastructure already exists and is unused

This is the single most "wow" item in the plan, and it turns out the data model
**already supports it end-to-end and nothing populates it**:
- `server/analyze/schema.py:85` — `PlaybackLine.sprite_url: Optional[str] = None`
  already exists.
- `web/src/components/Player.jsx:677-689` already reads `curLine.sprite_url` and
  builds a `lineSprites` map keyed by `character_id`.
- `web/src/components/Stage.jsx:19-21` already prefers `lineSprites[character_id]`
  over the character's default sprite when present.
- `web/src/components/Sprite.jsx` already renders whatever `character.sprite` resolves
  to.

**Nothing today ever sets `sprite_url` on a compiled line.** The whole chain from
schema to render is dormant, wired, and waiting.

Plan:
1. During imaging (`worker/_shared/edge-imaging.js`), after generating a primary
   character's base sprite, optionally generate 2-4 alt-expression variants for
   `primary`-importance characters only (cost control) — e.g. `happy`, `angry`,
   `sad`/`crying`, `surprised` — using the same prompt-composition path
   `moment-inserts.js`/`byoPrompts.js` already use for `expressionPromptSuffix()`, just
   applied to a character portrait instead of a full scene. Store as
   `characters[id].expressionSprites = { happy: url, angry: url, ... }`.
2. In `compile-playback.js` (both line-compile call sites,
   `compile-playback.js:102` and `:238`, per the earlier expression-passthrough
   grep), when a line's normalized bucket (3a's shared normalizer) has a matching
   entry in that character's `expressionSprites`, set `line.sprite_url` to it.
3. Gate this behind the "Generate art with AI" + a new checkbox in `AddBookSheet`
   ("Expressive character art (slower, more images)") since it multiplies image-gen
   cost by however many buckets are covered — should be opt-in, not default, at least
   initially.
4. Fallback stays exactly as today (CSS filter treatment from 3a) for
   secondary/background characters or when no alt-sprite exists for that bucket — so
   this degrades gracefully rather than being all-or-nothing.

**Status:** implemented, plus a same-day backfill fix for the staged/compare
regen path — see the "Update (2026-07-12, later same day)" note above. Net
behavior today: triggering a regen on primary characters does NOT
auto-generate their expression art hands-off — the default compare/staging
workflow still requires confirming ("Keep new") each character's base
portrait in the UI first, same as always. What changed is that confirming
now transparently kicks off expression-sprite generation in the background
for any primary character that doesn't have it yet, instead of that
character being permanently stuck with none. A regen explicitly passing
`compare: false` skips staging entirely and still generates expression art
inline, no confirm step needed.

---

## Phase 4 — Fun / experimental (explicitly asked for, not required for the core fix)

- **"Performance Mode" intensity dial** in Settings (alongside existing borders/pixel
  filter toggles) — a single slider from *Subtle* → *Balanced* → *Full Drama* that
  scales the magnitude of everything in Phases 2-3 (prosody offset %, animation
  amplitude, whether the stage-flash/shake fires at all, alt-sprite usage). This is
  the safety valve that makes "almost dramatic ... performance" a choice rather than a
  fixed assumption about every reader's taste.
- **Emotional momentum / scene state machine.** Track a lightweight per-scene "tension"
  value that accumulates across consecutive high-intensity lines and decays on calm
  narration, independent of any single line's tag. Let it modulate ambience/lighting
  (a very subtle background color-grade shift toward warmer/cooler as tension rises)
  so an escalating argument *builds* visually across several lines rather than each
  line reacting in isolation — closer to how a real scene is staged/lit than
  line-by-line reactivity alone.
- **"Director's log" debug overlay** (dev-only, toggle via existing `VAE_DEBUG` env):
  show the resolved `{expression, intensity, bucket, prosody offsets applied}` for the
  current line in a small corner readout while playing — makes tuning Phases 1-3
  actually observable instead of guessing from vibes, and doubles as a demo/debugging
  tool for whoever picks this plan up.
- **Callback/echo staging for interrupted dialogue**: when `dialogue-rules.js`'s
  "INTERRUPTED DIALOGUE" pattern fires (a line split across a narration tag), consider
  a brief continuity animation (the speaker sprite stays "mid-gesture" through the
  narration beat) rather than resetting to idle and re-triggering — small polish, but
  exactly the kind of detail that sells "performance" over "slideshow."

---

## Rollout notes

- **Schema is additive, not breaking.** `expression` stays a free string on the wire
  (per `schema.py`'s existing "(loose ok)" comment) — the canonical bucket list is a
  *vocabulary* the prompt and normalizer agree on, not a hard enum, so old already-
  extracted books (like the existing Vol. 4/05 in the local library right now) keep
  working unchanged. The normalizer (3a) is what makes old freeform tags render
  correctly under the new CSS/audio buckets without re-extracting anything.
- **No re-extraction required to ship Phases 2-3.** Both the TTS prosody mapping and
  the CSS taxonomy expansion work against whatever expression values already exist in
  already-compiled books, once normalized. Phase 1's extraction-quality fixes only
  affect *newly extracted* chapters (or ones explicitly re-run through 1e's audit
  retry).
- **Regression fixture:** `blacksmith-vol5-ch1` (built this session, both a
  cloud-Gemini full-book baseline and a from-scratch local-Ollama baseline exist,
  both 100%-flat) is a ready-made "before" case. Phase 0's auditor should go from
  flagging it red to green as Phase 1 lands.
- **Cost/latency awareness:** 1d (focused re-pass) and 3d (alt-sprites) are the two
  items that add real recurring cost/time. Both are explicitly gated/optional in this
  plan (env flag; opt-in checkbox) so the free wins (1a/1b/1c, all of Phase 2, 3a-3c)
  can ship without waiting on a cost decision.

## Open questions for whoever implements this

1. Canonical bucket list above is a first draft (16 buckets) — worth checking it
   against the *actual* 70+ freeform values already sitting in the existing Vol. 4/05
   data (`data/` or R2) to make sure the normalizer's many-to-one mapping doesn't lose
   anything important. Might want to derive the bucket list empirically from that data
   rather than guessing it fresh.
2. Edge-TTS's prosody control is fairly coarse (rate/pitch/volume, no true SSML
   `style=` expressiveness like full Azure Cognitive Speech). Worth a quick spike to
   confirm the offsets in Phase 2 are perceptible before over-building the mapping
   table — might need larger offsets than sketched above, or might clip/distort past a
   certain %.
3. Phase 3d's alt-sprite generation cost scales with (primary characters) × (buckets
   covered) × (art style). Worth deciding the initial bucket subset (suggest starting
   with just `happy`/`angry`/`sad`/`surprised` — 4 variants — before expanding) and
   confirming with whoever owns the image-gen budget before defaulting it on for
   anyone.
