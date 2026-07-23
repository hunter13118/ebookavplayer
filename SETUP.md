# Setup: EbookAVPlayer on a Fresh Machine

Quick reference for bringing up the full stack locally. Every command and path
cited directly from the repo.

## Which backend?

One backend: **`worker/` (Cloudflare Workers, via `wrangler dev`)**, and
that's what every command below uses by default. The original Python/FastAPI
implementation is archived at `legacy/server/` — kept for reference and
because a few dev scripts still import individual modules from it. It's
covered separately at the end, marked optional.

## Prerequisites

- **Node.js 18+** (for `wrangler` + web dev; [package.json:4](package.json#L4))
- **npm** (ships with Node)
- **Git** (to clone)
- **Python 3.10+** — only needed for the archived `legacy/server/app.py` path
  or the local WhisperX align server; skip it for normal web/worker development.

## 1. Clone & install

```bash
git clone <this-repo> && cd ebookavplayer
npm install                          # root devDeps: wrangler, fflate, pngjs, jpeg-js
cd web && npm install && cd ..       # web dependencies
```

Verify:
```bash
npm run test:character-merge         # should print "character-merge: all assertions passed"
node --version                       # v18+
npx wrangler --version               # confirms wrangler installed
```

## 2. Env setup

```bash
cp .env.example .env
# Edit .env: set GEMINI_API_KEY (free tier via Google AI Studio — see
# .env.example's top comment block for the signup link/notes)
```

File refs:
- [.env.example](.env.example) — every toggle and key, most commented out with defaults
- `API_PORT=8600` is the local worker/server port both stacks assume

`worker/.dev.vars` is loaded automatically from root `.env` by
[scripts/sync-dev-vars.mjs](scripts/sync-dev-vars.mjs) — **edit `.env`, not
`worker/.dev.vars` directly**, or your edits get overwritten on next `npm run dev:worker`.

## 3. Run locally

One command, both services:
```bash
npm run start:local
# Checks Ollama reachability, then starts worker + web together, prefixed
# logs from both. Ctrl+C kills the whole tree (including wrangler's own
# workerd runtime child) — see scripts/start-local.mjs.
```

Or two terminals, if you want to restart one side independently:

Terminal 1 — Worker API at :8600 ([worker/wrangler.toml:12](worker/wrangler.toml#L12)):
```bash
npm run dev:worker
# Runs scripts/sync-dev-vars.mjs, then `wrangler dev`.
# Emulates R2 + KV locally with `.wrangler/state/` files.
```

Terminal 2 — Web client at :5173:
```bash
cd web && npm run dev
# Vite dev server; proxies /api/* to :8600 — see web/vite.config.js
```

Open **http://localhost:5173**.

## 4. Tests

### Worker/pipeline logic — no server needed (Node, run from repo root)

```bash
npm run test:character-merge
npm run test:character-reconcile
npm run test:illustration-refs
npm run test:external-refs
npm run test:compile-chapter-playback
npm run test:ordered-drain
```

Full list of `test:*` targets: [package.json](package.json). Each maps 1:1 to
a file in [tests/](tests/).

### Web unit tests (Vitest)

```bash
cd web
npm run test          # vitest run — NOT Playwright, despite the name
```

### Web end-to-end (Playwright — needs both dev servers running)

```bash
cd web
npm run test:install  # one-time: downloads Chromium
npm run test:e2e      # headless run against localhost:5173 + :8600
# npm run test:e2e:ui   # interactive runner
```

Specs live in [web/tests/e2e/](web/tests/e2e/). Most mock the API and stub
`Audio` to assert invocation order/timing rather than real audio decode; a few
(`m4b-progressive-align.spec.js`) exercise real alignment against
[test_assets/e2e/demo-clip.m4b](test_assets/e2e/demo-clip.m4b).

### Production build check

```bash
cd web && npm run build
```

## Character management (settings → Characters tab)

Fixes a mis-attributed character retroactively (e.g. "Unnamed male
protagonist" that's really "Eizo"):

- **UI:** Settings (⚙ in player) → Characters tab. Rename in place, or pick
  "Merge into…" to fold one character into another.
- **Effect:** rewrites all past scenes/lines (id, sprite, voice); the alias is
  persisted so future chapters land on the same canonical ID.
- **API:** [worker/api/v1/characters.js](worker/api/v1/characters.js) —
  `PATCH /books/:id/characters/merge {from, to}`,
  `PATCH /books/:id/characters/rename {id, name}`,
  `PATCH /books/:id/characters/temperament {id, temperament}`
- **Logic:** [worker/_shared/character-merge.js](worker/_shared/character-merge.js)
  (merges across analysis.json + playback.json); alias applied at extraction
  time via [chapter-extract-pipeline.js:99-101](worker/_shared/chapter-extract-pipeline.js#L99)
- **Temperament** (docs/EXPRESSION_SENSITIVITY_PLAN.md Phase 1f): a baseline
  emotional register (stoic, excitable, dry/sarcastic, warm, volatile — free
  text) fed into the expression re-pass as context, not a display field —
  same tab, per-character.

## Tweaking parallel chapter extraction

[worker/_shared/chapter-extract-pipeline.js:138](worker/_shared/chapter-extract-pipeline.js#L138)
reads `VAE_EXTRACT_CONCURRENCY` (default **3**) — how many chapters the worker
extracts at once, regardless of which provider is handling extraction. Set it
in root `.env`.

**If extraction is running through a cloud provider** (Cerebras/Groq/Mistral/
OpenRouter/etc.), raising this is likely a straightforward win — those aren't
bottlenecked by your machine's compute, only by their own rate limits. Not
benchmarked in this repo; increase and watch for 429s.

**If extraction is running through Ollama** (see
[docs/LOCAL_LLM_EXTRACTION.md](docs/LOCAL_LLM_EXTRACTION.md)), **more
concurrency is not free and may not help at all** — see the benchmark there.
On the machine this was tested on (M4 Pro, 48GB), parallel Ollama decode was
*slower in aggregate* than running requests one at a time, so both
`VAE_EXTRACT_CONCURRENCY` and `OLLAMA_NUM_PARALLEL` are set to **1**. Don't
assume a bigger number is better here without re-running the benchmark on
your own hardware first.

## Troubleshooting

| Issue | Fix |
|---|---|
| `wrangler dev` fails with "port 8600 in use" | `lsof -i :8600 \| kill -9 <pid>`, or override with `PORT=8601 npm run dev:worker` |
| Tests fail with "module not found" | Re-run `npm install` at root **and** in `web/` |
| Web dev server proxy errors | Check `target` in [web/vite.config.js](web/vite.config.js) points at `:8600` |
| `web/src/timing/whisperxAlignerClient` calls fail | The local align bridge isn't running — see [scripts/local-align-server/server.py](scripts/local-align-server/server.py) (Python, standalone WhisperX ASR server, separate from both the worker and `legacy/server/`) |
| The align server exits at startup with `SSLCertVerificationError` reaching `huggingface.co` | The MDM intercepts TLS, so the HF model-metadata fetch fails even though the model is already cached locally. Start it with `HF_HUB_OFFLINE=1 .venv/bin/python server.py` — it uses the cached model and skips the network check |
| The local **image** server (`scripts/local-image-server/server.py`) exits with `ModuleNotFoundError: No module named 'torch'` | It's being launched with a Python that has no `torch` — it needs its own env with `torch`/diffusers installed. This only gates live art *generation*; embedded-image extraction and everything in the reader/character path is worker-side and unaffected |
| An attached `.m4b` never plays/syncs and there's no error | Fixed — the failure used to be swallowed silently (`m4bStatus.error` was set but never rendered). The player now shows a red banner with a **Retry** button. The usual cause is the align server being down (start it, then Retry) or no align connection configured (add `http://127.0.0.1:7861` in Settings › Backends) |
| Reader text from a BookNLP-extracted book shows words cut in half (`Badlan|ds`), scattered quote marks, or `�` | Fixed — `_verbatim_span` sliced BookNLP's **character** offsets out of raw UTF-8 **bytes**, so every multibyte char (curly quotes, em-dashes) shifted the window and could split mid-character. It now slices the decoded string. An already-extracted book keeps its old corrupted text until re-ingested |
| A BookNLP-extracted book proposes ~200 "characters", many gibberish/onomatopoeia | Fixed — `consolidateCharacters` ([worker/_shared/booknlp-consolidate.js](worker/_shared/booknlp-consolidate.js)) culls the roster to the cast that actually carries the book (by whole-book line count, higher bar for anonymous `unnamed-*` buckets) and drops interjections mis-tagged as names, reassigning dropped speakers' lines to the narrator. Runs at finalize for the BookNLP path only. Thresholds are tunable in that module |
| A book with `VAE_BOOKNLP_URL` set stalls or falls straight through to the LLM path | The local BookNLP server isn't running, or crashed on this chapter — check `scripts/local-booknlp-server/server.py`'s logs; the pipeline treats a BookNLP failure as "fall back to the LLM from here," not a hard error, so the book still finishes, just without the mechanical pass past that point |
| `.env` edits don't take effect in `dev:worker` | You're editing `worker/.dev.vars` directly — edit root `.env` instead, `sync-dev-vars.mjs` regenerates it |
| Character merge doesn't persist | Confirm the KV binding in [worker/wrangler.toml:31](worker/wrangler.toml#L31) is configured |
| A book is stuck showing "Processing" with no progress (e.g. after a dev server restart or crash mid-extraction) | Library → **⋯** → select the book → **Cancel processing**. Can't interrupt an already-running queue consumer invocation (no cancel primitive), but it marks the dead job terminal and resets the book to "partial" (resumable, if any chapters finished) or "error" — see `onCancelProcessingPost` in [worker/api/v1/book-actions.js](worker/api/v1/book-actions.js) |
| Opening a book that's *actively* extracting (`status: "processing"`) shows a "Caching…" spinner that never resolves | Fixed 2026-07-08 — `openBook` in `web/src/App.jsx` used to always try to build a fresh offline pack first, which queues behind the still-running extraction job (same shared-queue issue as the row above) with no way to finish. Now skipped entirely for a still-processing book — reads directly from the live connection instead, no offline pack needed. See `needsOfflineCache` in [web/src/offline/bookSource.js](web/src/offline/bookSource.js) |
| Graphify bootstrap fails | Install Ollama locally, or use `--backend web` (needs an API key) |
| Local Ollama extraction feels slow with `VAE_EXTRACT_CONCURRENCY` > 1 | Expected on Apple Silicon per the benchmark above — lower it to 1, don't raise it |
| Uploading a new book while another is actively extracting leaves the new one stuck at "queued 0%" for a long time, and a companion `.m4b` picked alongside it doesn't seem to attach | Same shared-`vae-jobs`-queue issue as the two rows above, one level earlier: one ingest/continue-extract message runs its WHOLE book (every chapter, incl. BookNLP/annotate/LLM fallback) before acking, so a second message queues fully behind it — `worker/wrangler.toml`'s `[[queues.consumers]]` for `vae-jobs` sets `max_concurrency = 4` for this reason, but `wrangler dev`'s local queue emulation appears to still process one message at a time regardless (confirmed by testing — a second upload's mechanical baseline never starts while another book's extraction is running, even with this set); the setting is real Cloudflare Queues behavior once actually deployed. For local testing, either wait for the running book to finish/pause it, or expect a fresh upload's "open almost instantly" promise to only hold when the queue is otherwise idle. The `.m4b` itself is never lost, though — `App.jsx`'s `handleEpubUpload` now calls `storeM4b` durably the moment the file is picked (before waiting on the book), and `Player.jsx`'s `loadM4b`-on-mount effect auto-attaches it whenever the book is eventually opened, even across a reload |

---

## Optional: archived Python/FastAPI backend

Only needed if you're working on `legacy/server/` itself or a dev script
that still imports individual modules from it (`scripts/audit_expression.py`,
`scripts/validate_extract.py`, `scripts/smoke_extract.py`,
`scripts/purge_white_background.py`, `scripts/build_e2e_test_epub.py`,
`scripts/test_freemium_providers.py`). It carries no test coverage anymore
and isn't wired to the Worker in any way — `scripts/local-align-server/`
(the WhisperX bridge) is a separate, unrelated standalone server and does
**not** import from it.

```bash
pip install -r requirements.txt
export GEMINI_API_KEY=<key>
uvicorn legacy.server.app:app --port 8600 --reload --reload-dir legacy/server
```

See [legacy/server/app.py](legacy/server/app.py) for the FastAPI app, and
[docs/HOST_CHECKLIST.md](docs/HOST_CHECKLIST.md) for its full host-verification
checklist (pytest, live Edge TTS smoke, Gemini smoke script) — historical,
predates the Workers port and does not cover `worker/`.

## Optional: local LLM extraction (Ollama)

The worker can run the EPUB extraction mega-pass against a locally-running
Ollama model instead of Gemini/cloud fallbacks — free, offline, no rate limit.
This also covers pointing any frontend (including the deployed production
site) at your local worker via the "local API bridge." Full writeup:
[docs/LOCAL_LLM_EXTRACTION.md](docs/LOCAL_LLM_EXTRACTION.md).

## Optional: character enrichment (Phase 3)

Off by default. Set `VAE_CHARACTER_ENRICH=true` in root `.env` to have the
worker look up each named character on Fandom / MyAnimeList after extraction
and fold canonical attributes (hair/eye color, build, outfit, speech
register/cadence) into that character's image-gen prompt and voice
assignment. Keyless, free public APIs only — no signup, no key to manage.
Full design: [docs/CHARACTER_ENRICHMENT.md](docs/CHARACTER_ENRICHMENT.md).

## Optional: local WhisperX align server

Backs the `whisperx-local` timing tier ([web/src/timing/whisperxAlignerClient.js](web/src/timing/whisperxAlignerClient.js))
**and** the M4B-first flow's speech-to-text ([docs/M4B_FIRST_FLOW.md](docs/M4B_FIRST_FLOW.md)).

WhisperX pulls torch, which has **no Python 3.14 wheels** — this repo's `venv/`
is 3.14, so the align server gets its own **3.12** venv via `uv`:

```bash
cd scripts/local-align-server
UV_SYSTEM_CERTS=1 uv venv --python 3.12 .venv
UV_SYSTEM_CERTS=1 uv pip install --python .venv/bin/python whisperx fastapi "uvicorn[standard]" python-multipart
HF_HUB_OFFLINE=1 .venv/bin/python server.py
# GET /health, POST /align (whisperx-local timing), POST /transcribe (M4B-first) on :7861
```

`UV_SYSTEM_CERTS=1` is required on this machine — the MDM intercepts TLS, so uv
must trust the macOS keychain root. `HF_HUB_OFFLINE=1` on the **run** command is
required for the same reason: once the ASR model is cached, the startup
model-metadata fetch to `huggingface.co` still fails TLS verification and would
abort the server (`SSLCertVerificationError`) — offline mode uses the cache and
skips that check. The `libtorchcodec` warning on startup is harmless (WhisperX
decodes via the ffmpeg CLI). Add `http://127.0.0.1:7861` as a connection in
Settings > Backends.

Tested by [tests/test_local_align_server.py](tests/test_local_align_server.py).

## Optional: local BookNLP server (mechanical dialogue attribution)

A purely mechanical (zero-LLM-cost) alternative to the freemium LLM
extraction pass for character/dialogue/narration splitting and speaker
attribution — real coreference resolution + a small BERT classifier, not a
language model call. Full design: the plan this implements,
`~/.claude/plans/declarative-plotting-flamingo.md` ("BookNLP mechanical pass
(Slice 1)").

BookNLP pulls torch (same "no Python 3.14 wheels" reason as the align server
above), so it gets its own **3.12** venv via `uv` too:

```bash
cd scripts/local-booknlp-server
UV_SYSTEM_CERTS=1 uv venv --python 3.12 .venv
UV_SYSTEM_CERTS=1 uv pip install --python .venv/bin/python booknlp "setuptools<81" truststore fastapi "uvicorn[standard]" python-multipart
UV_SYSTEM_CERTS=1 uv pip install --python .venv/bin/python "en-core-web-sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl"
.venv/bin/python server.py
# GET /health, POST /process (per-chapter mechanical dialogue attribution) on :7862
```

Three real environment issues, all handled by the server itself (see
`server.py`'s module docstring for the full why):
- `UV_SYSTEM_CERTS=1` is required for the same MDM-intercepted-TLS reason as
  the align server, but it only covers `uv`'s own installs — BookNLP's OWN
  model-download bootstrap (plain `urllib`) needs `truststore` instead
  (already installed above; `server.py` calls `truststore.inject_into_ssl()`
  before importing `booknlp`).
- `setuptools<81` — newer setuptools dropped `pkg_resources`, which BookNLP
  still imports directly.
- spaCy's own `en_core_web_sm` model needs installing via its direct wheel
  URL (above), not `python -m spacy download` — that command's own
  compatibility check hits the same MDM/TLS wall and can't be routed through
  `truststore`.

Unlike the align server, this is **not** browser-driven — the worker calls
it directly from `chapter-extract-pipeline.js` (chapter text already lives
on the worker; there's no on-device blob to route through the client). Set
`VAE_BOOKNLP_URL=http://127.0.0.1:7862` in root `.env` (synced to
`worker/.dev.vars` — see the `.env` troubleshooting row below) to actually
use it for new/resumed extractions; leaving it unset keeps today's
mechanical-then-LLM pipeline unchanged. Optionally also add
`http://127.0.0.1:7862` as a connection in Settings > Backends purely for
health-check visibility — it has no "role" to assign there, unlike the align
server's Audiobook-sync picker.

Tested by [tests/test_local_booknlp_server.py](tests/test_local_booknlp_server.py)
(pure string helpers only — run via the server's own venv:
`scripts/local-booknlp-server/.venv/bin/python -m pytest tests/test_local_booknlp_server.py`).

### Annotate-in-place LLM enrichment (Phase 2)

For chapters BookNLP doesn't reach (or when `VAE_BOOKNLP_URL` is unset
entirely), set `VAE_ANNOTATE_LLM=true` to have the LLM enrich chapters
WITHOUT regenerating text: it only declares the
character roster and assigns a speaker to each already-split mechanical
dialogue line by idx, on the exact verbatim lines `mechanical-script.js`
already produced (including its own quote-boundary splitting — a sentence
like `Kosuke said, "Let's go."` arrives at the LLM already split into a
narration line and a dialogue line; the model never re-splits or rewrites
either). Full per-chapter fallback order: **BookNLP** (if `VAE_BOOKNLP_URL`
is set) → **annotate** (if `VAE_ANNOTATE_LLM=true`) → **full-regeneration**
extraction (today's original behavior, always the last resort) — each tier
stops cleanly at the first chapter it can't handle so the next tier resumes
exactly where it left off. Off by default, same as `VAE_BOOKNLP_URL`.

## Optional: local image gen server (`local_sd` tier)

Backs the `local_sd` image tier — a self-contained server, no cloud key and
no dependency on another project (earlier revisions of this repo pointed at
a War Council-hosted endpoint; that's gone, see
[docs/ECOSYSTEM_INTEGRATION.md](docs/ECOSYSTEM_INTEGRATION.md) for why).
Three interchangeable model profiles (turbo-fast-but-not-anime,
anime-native-but-slow, anime-native-and-fast), device auto-detection
(CUDA/MPS/CPU), a real batched-generation endpoint, IP-Adapter reference-image
conditioning for character consistency (with a per-character face-crop tool
for group EPUB illustrations), a revived character-expression-variant
pipeline, and the batching benchmark results (including a hard MPS crash
ceiling worth knowing about before raising batch sizes) are all covered in
**[docs/LOCAL_IMAGE_GEN.md](docs/LOCAL_IMAGE_GEN.md)** — start there.

Quick start (base generation only — see LOCAL_IMAGE_GEN.md for the full
install list needed for reference-image conditioning and face cropping):
```bash
source venv/bin/activate  # or your Python env
pip install torch diffusers transformers accelerate peft
python3 scripts/local-image-server/server.py
# Exposes GET /health, GET /models, POST /generate, POST /generate_batch,
# POST /generate_expression_set
# set LOCAL_IMAGE_URL=http://127.0.0.1:7860 in .env
```

On macOS with Homebrew Python, first startup may fail with
`CERTIFICATE_VERIFY_FAILED` even though `curl`/browsers work fine — see
[docs/LOCAL_IMAGE_GEN.md](docs/LOCAL_IMAGE_GEN.md#bugs-hit-and-fixed-getting-here-for-the-next-person)
for the fix (`pip install pip-system-certs`).

---

## Claude Code setup

This repo's Claude-specific config (skills, hooks, key-file map) lives in
[.claude/CLAUDE.md](.claude/CLAUDE.md) and [.claude/settings.json](.claude/settings.json) —
edit those directly rather than duplicating their contents elsewhere. Quick
pointers:

- **graphify** (codebase Q&A via knowledge graph): bootstrap once with
  `graphify extract . --backend ollama` (local, free, no API key), then query
  with `/graphify <question>`.
- **context-mode**: use for processing large test/log output so raw text
  doesn't fill the conversation — see `.claude/CLAUDE.md` for the pattern.

---

## Next steps

1. **First time:** `npm install` (root + `web/`), `npm run test:character-merge`,
   then `npm run start:local`.
2. **Writing code:** edit, save, hot-reload in browser or watch test output.
3. **Before committing:** run the relevant `test:*` targets above plus
   `cd web && npm run build` to catch compile errors.

## References

| Topic | File(s) |
|---|---|
| Character management | [characters.js](worker/api/v1/characters.js), [character-merge.js](worker/_shared/character-merge.js), [CharacterManager.jsx](web/src/components/CharacterManager.jsx) |
| Script extraction | [chapter-extract-pipeline.js](worker/_shared/chapter-extract-pipeline.js), [freemium-extract.js](worker/_shared/freemium-extract.js) |
| Voice assignment | [voice-assign.js](worker/_shared/voice-assign.js), [PlayerMenu.jsx](web/src/components/PlayerMenu.jsx) |
| Playback compilation | [compile-playback.js](worker/_shared/compile-playback.js) |
| Timing/alignment | [orchestrator.js](web/src/audio/orchestrator.js), [timing/registry.js](web/src/timing/registry.js), [whisperxAlignerClient.js](web/src/timing/whisperxAlignerClient.js) |
| Local LLM extraction (Ollama) | [docs/LOCAL_LLM_EXTRACTION.md](docs/LOCAL_LLM_EXTRACTION.md) |
| Local image generation | [docs/LOCAL_IMAGE_GEN.md](docs/LOCAL_IMAGE_GEN.md) |
| Web UI | [Player.jsx](web/src/components/Player.jsx), [vite.config.js](web/vite.config.js) |
| Tests | [tests/](tests/) directory, [package.json](package.json) scripts |
| Environment | [.env.example](.env.example), [worker/wrangler.toml](worker/wrangler.toml) |
