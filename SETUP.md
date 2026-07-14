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
| `.env` edits don't take effect in `dev:worker` | You're editing `worker/.dev.vars` directly — edit root `.env` instead, `sync-dev-vars.mjs` regenerates it |
| Character merge doesn't persist | Confirm the KV binding in [worker/wrangler.toml:31](worker/wrangler.toml#L31) is configured |
| A book is stuck showing "Processing" with no progress (e.g. after a dev server restart or crash mid-extraction) | Library → **⋯** → select the book → **Cancel processing**. Can't interrupt an already-running queue consumer invocation (no cancel primitive), but it marks the dead job terminal and resets the book to "partial" (resumable, if any chapters finished) or "error" — see `onCancelProcessingPost` in [worker/api/v1/book-actions.js](worker/api/v1/book-actions.js) |
| Opening a book that's *actively* extracting (`status: "processing"`) shows a "Caching…" spinner that never resolves | Fixed 2026-07-08 — `openBook` in `web/src/App.jsx` used to always try to build a fresh offline pack first, which queues behind the still-running extraction job (same shared-queue issue as the row above) with no way to finish. Now skipped entirely for a still-processing book — reads directly from the live connection instead, no offline pack needed. See `needsOfflineCache` in [web/src/offline/bookSource.js](web/src/offline/bookSource.js) |
| Graphify bootstrap fails | Install Ollama locally, or use `--backend web` (needs an API key) |
| Local Ollama extraction feels slow with `VAE_EXTRACT_CONCURRENCY` > 1 | Expected on Apple Silicon per the benchmark above — lower it to 1, don't raise it |

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

Backs the `whisperx-local` timing tier ([web/src/timing/whisperxAlignerClient.js](web/src/timing/whisperxAlignerClient.js)):

```bash
python3 scripts/local-align-server/server.py
# Exposes GET /health, used by the whisperx-local timing strategy
```

Tested by [tests/test_local_align_server.py](tests/test_local_align_server.py).

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
