# Host checklist — what to verify on your machine

> **This checklist covers the archived Python/FastAPI backend, now at
> `legacy/server/` (was `server/` when this doc was written).**
> For the current Cloudflare Workers stack (`worker/`, `npm run dev:worker`),
> see [`../SETUP.md`](../SETUP.md) instead. This doc predates the Workers port.

The build sandbox has **no PyPI/npm install and no outbound network to the Edge
endpoint**, so the items below could not be exercised here and need a quick pass
on your host. Everything else (pure logic, schema shapes, EPUB parsing, voice
assignment, JSX brace/structure, JSON validity) was verified in-session.

## 1. Backend deps + live TTS
```bash
pip install -r requirements.txt
python3 -m pytest tests -q          # runs the pydantic-gated tests too (test_compile.py)
# Smoke the real Edge voice (this is the network call we couldn't make):
python3 -c "from server.audio.edge_tts import synthesize_edge_mp3_sync as s; \
open('out.mp3','wb').write(s('Hello from the visual audiobook engine.', \
'en-US-AndrewMultilingualNeural')); print('wrote out.mp3')"
```
Expect a few seconds of speech in `out.mp3`. Try a pitch shift:
`s('test', 'en-US-AndrewMultilingualNeural', pitch='-30Hz')`.

## 1b. Simplest-form Gemini smoke test (the current priority)
Confirms the two host-only, risky pieces — the mega-pass and image gen — in
under a minute, without running the whole pipeline:
```bash
export GEMINI_API_KEY=...
python3 scripts/smoke_extract.py path/to/book.epub            # extraction only
python3 scripts/smoke_extract.py path/to/book.epub --image    # + one test image
```
Step 1 parses the EPUB; step 2 runs ONE Gemini request and validates it against
`BookAnalysis` (prints character/scene/line counts); `--image` generates a single
cover into `./smoke_out/`. Current model defaults: text `gemini-2.5-flash`
(Gemini 3.5 also works), image `gemini-3.1-flash-image` (Nano Banana 2). Use a
short book or rely on `GEMINI_MAX_CHARS` (default 120k) for the first run.

If the mega-pass returns malformed JSON, `analyze_book` **re-asks once**
automatically (hands the model its bad output + the validation error). If it
still fails after the repair pass, the error propagates — check the model id and
that JSON mode is supported.

**Dry-run ingest (preview the script before spending image quota).** Add
`dry_run=true` to `/ingest` (or tick "Extract only" in the upload tray): the job
parses + runs the mega-pass, marks the book ready/playable with gradient
placeholders, and **skips image generation entirely**. Re-ingest without the flag
(or a future `/generate-media`) to add art once the script looks right.

## 2. Compile the sample through the real pipeline (pydantic)
```bash
python3 -m server.sample.build_sample      # rebuilds data/books/the-silver-gate.json
```
This exercises `analyze/schema.py` + `playback/compile.py`, which the sandbox
could only AST-check (no pydantic available).

## 3. Frontend build + render
```bash
cd web && npm install && npm run build      # confirms JSX compiles (no babel here)
npm run dev                                  # click through the demo
```
Manual QA:
- Play / pause / next / restart, speed 0.75–2×, auto vs click-through advance.
- Typewriter finishes ~as each line's audio ends (sync). Click reveals the rest.
- Box styles: pixel / smooth / subtitle. Art toggle, light/dark, sprite borders.
- Scene change between scene-0001 and scene-0002; in the 3-character courtyard
  scene the speaker is spotlighted and extras dim.
- Set `checkpointEvery` (voicePrefs) low to see the "Still listening?" overlay.

## 3b. Playwright e2e (mocked backend — validates invocation order)
```bash
cd web
npm install
npm run test:install          # one-time: downloads the Chromium build
npm run test:e2e              # starts vite, runs all specs headless
# npm run test:e2e:ui         # interactive runner
```
These never hit the real network: `/books`, `/books/:id`, and `/tts` are mocked,
and `Audio` is stubbed deterministically so we assert the **order and timing of
invocations**, not audio decode. Coverage (`web/tests/e2e/`):
- `playback-order` — one `/tts` per line, in scene order, each with the correct
  **per-character** voice/pitch (proves routing isn't keyed off screen position).
- `sequencing-ui` — speaker label + sprite spotlight + scene background follow
  the current line; group scene dims non-speakers; progress runs to `done`.
- `controls` — Pause stops further `/tts`; Next cancels the in-flight line and
  advances without duplicating; **click-through mode fires nothing until you
  advance**; Restart replays from line 0 and cancels the prior run.
- `checkpoint` — playback halts every N lines and resumes only on Continue.
- `fallback` — unreachable catalog → embedded demo; empty catalog → empty
  library + uploader; `/tts` errors don't hang the sequence.
- `library` — a card per book with the real title beneath; processing books show
  a spinner + progress, ready books show a cover; clicking opens the player.
- `resume` — opening a book jumps to the saved line; position persists to
  localStorage as it plays; a fresh book starts at line 0.
- `processing` — opening a still-processing book shows the pinned top bar and
  plays the already-available lines; progress climbs via polling and the bar
  clears when done.
- `upload` — picking an EPUB POSTs `/ingest`, shows an optimistic processing
  placeholder, and polls the catalog until it flips to ready (spinner clears);
  the "Extract only" toggle sends `dry_run=true`.
- `controls-extra` — sprite-borders toggle, speed reaches the audio element,
  narrator-gender persists, click-to-skip-typewriter, dialogue-click advance.
- `library-card` — reading bar + Resume chip on a started book, resume opens at
  the saved line, Back returns to the library.

Total: 41 tests / 12 spec files. **Known gap:** the in-player art-style toggle
writes a pref no playback component reads (it only affects ingest) — decide
whether to wire live art-swap or drop it from the player; it has no test until
that's resolved.

If a spec is flaky on a slow machine, raise `clipMs` in the per-test
`bootPlayer({ audio: { clipMs } })` call or the `expect` timeout in
`playwright.config.js`.

**Screenshots.** `screenshots.spec.js` writes named PNGs to
`web/tests/screenshots/` (smooth/pixel/subtitle boxes, light theme, group-scene
spotlight, checkpoint overlay). Failures also auto-capture (config
`screenshot: "only-on-failure"`) into `playwright-report/` — open it with
`npx playwright show-report`. To display any of these in chat, hand the PNG
path back to Claude and it'll show them as image cards (markdown image links
don't render inline here).

## 4. Ingest a real EPUB (needs GEMINI_API_KEY)
```bash
curl -F file=@yourbook.epub -F art_style=semi-real http://localhost:8600/ingest
curl http://localhost:8600/ingest/<job_id>     # poll until status=done
```
Provide a light novel with embedded images to validate image-reference
extraction (brief open item). Watch the Gemini mega-pass JSON validates against
`BookAnalysis`; if a model returns stray prose, `gemini.py:_strip_code_fence`
handles fenced output, but verify with your chosen `GEMINI_MODEL`.

## 5. Known seams / not-yet-wired (by design, per brief MVP scope)
- Image gen `_gen_one` targets the Gemini image model; Cloudflare FLUX / HF /
  local-SD fallbacks are stubbed seams.
- Stock-pool sprites resolve to `/media/stock/*.png` — drop a generic pool there
  (or they fall back to gradient placeholders).
- Audio post-FX (cave echo) and offline caching are Phase 2.
- Cloudflare Workers port: `/ingest` already runs the long Gemini pass in a
  background thread so the request returns immediately (avoids the ~10s CPU
  limit); swap the in-memory job dict for a queue when porting.
