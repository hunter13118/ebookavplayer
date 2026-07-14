# Architecture — current state

The one living doc for "how is this actually built today." Everything else
under `docs/` is either a deep-dive on one subsystem or a point-in-time
snapshot (roadmaps, plans, historical handoffs) — if something here conflicts
with an older doc, this file wins. Keep it live: update it in the same
session as any change to a backend, pipeline stage, or default (see
`.claude/CLAUDE.md`).

## Two backends exist; one is deployed

> **`worker/` (Cloudflare Workers) is the current, actively developed and
> deployed backend.** `server/` (Python/FastAPI) is **not dead code** — it's
> a large, actively-tested local package (192+ passing tests under `tests/`)
> that a real body of dev/ops tooling still imports directly:
> `scripts/audit_expression.py`, `scripts/validate_extract.py`,
> `scripts/smoke_extract.py`, `scripts/purge_white_background.py`,
> `scripts/build_e2e_test_epub.py`, plus `scripts/local-align-server/` (which
> re-exports `server/align/forced_aligner.py`). Treat `server/` as **local
> library + test infrastructure**, not as a service anyone runs in
> production. Nothing in the deployed path imports it — `VAE_API_ORIGIN`
> (the one wire that could connect a live FastAPI origin to the Worker) is
> unset in both this repo's `worker/wrangler.toml` and the production
> `milkman-webapp-portfolio` repo's config, so the Worker's origin-proxy
> fallback (`worker/_shared/proxy-fetch.js`) is a dead-end safety net that
> always 503s, not a live tier.

Production deploy: handlers under `worker/` are copied into
`milkman-webapp-portfolio/worker/ebookavplayer/` at build time and served
from Cloudflare Workers (R2 for pack storage, KV for job state, Queues for
background extraction/imaging, a Durable Object for job event streaming).
See [`CLOUDFLARE_BACKEND.md`](CLOUDFLARE_BACKEND.md) and
[`CLOUDFLARE_DEPLOY.md`](CLOUDFLARE_DEPLOY.md) for the deploy-shape detail.

## Repo map

```
worker/                 Cloudflare Workers backend — the deployed API
  worker.js               routes /api/v1/* → handlers
  api/v1/                 books, ingest, characters, tts, voices, media, progress...
  _shared/                 extraction pipeline, compile, voice-assign, character-merge,
                           pipeline-registry.js (freemium provider chain config)
  queue/                   pack-build-consumer, chapter-imaging-consumer
  durable-objects/         job/queue coordination (JobEventHub)
  wrangler.toml            R2 + KV + Queue bindings, dev port 8600

server/                 Python package — local test/tooling infra, NOT deployed
  align/forced_aligner.py   live consumer: scripts/local-align-server/
  pipeline/registry.py      Python-side mirror of worker/_shared/pipeline-registry.js
  analyze/, epub/, images/, playback/, audio/  original mega-pass pipeline,
                            covered by tests/test_*.py (192+ passing)

web/                     React + Vite client
  src/audio/               orchestrator.js (timing authority — do not touch lightly),
                           playSpeech.js, sharedAudioSource.js, lineAt.js
  src/timing/              alignment strategies: fromContainer, registry,
                           whisperxAlignerClient, slides
  src/offline/             offline pack cache, alignment cache
  src/components/          Library, Player, Stage, Sprite, dialogue boxes,
                           CharacterManager, GapNavSheet, Controls...

scripts/local-align-server/  Local WhisperX forced-alignment bridge (dev tool)
scripts/                 Dev/ops tooling — several scripts import server.* (see above)
data/books/               per-book sidecars (.analysis/.media/.status/.progress)
tests/                    root node tests/*.test.mjs + python tests/test_*.py
web/tests/e2e/            Playwright specs against the Vite client
```

## Architecture guardrails (do not drift)

From `visual-audiobook-brief.md`, still binding:

- **One Gemini mega-pass per book** — don't split analysis into many calls
  without updating rate-limit docs.
- **Client stays dumb** — the backend compiles playback JSON; the
  orchestrator (`web/src/audio/orchestrator.js`) is the single timing
  authority.
- **Edge TTS server-side** — browsers can't set Edge WS headers; `/tts` runs
  on the Cloudflare edge Worker (`worker/api/v1/tts.js`), not FastAPI.
- **Per-character voice routing** — never key voices off sprite screen
  position.
- **Progressive ingest** — analysis makes a book playable before images
  finish; don't block playback on art.
- **`$0` ceiling** — no new paid dependency crosses it; the freemium
  provider chain (`worker/_shared/pipeline-registry.js`) exists specifically
  to keep this true under provider rate limits.

## Running the test suite

One command from the repo root:

```bash
npm test
```

Runs every `tests/*.test.mjs` (root, no per-file script needed — new test
files are picked up automatically by `scripts/run-all-tests.mjs`) followed by
`npm --prefix web test` (Vitest, 49 files / 400+ tests). The Python suite
(`tests/test_*.py`, `server/`-backed) is separate — run with
`python -m pytest tests -q` from a `venv` with `requirements.txt` installed;
it's not wired into `npm test` because it exercises `server/` tooling paths,
not the deployed Worker.

Note: this environment's Node (26.x) ships an experimental native
`globalThis.localStorage` that shadows Vitest's jsdom implementation unless
disabled — `web/package.json`'s `test`/`test:watch` scripts set
`NODE_OPTIONS=--no-experimental-webstorage` for this reason. If you invoke
`vitest` directly instead of through `npm test`, set that env var yourself
or localStorage-touching tests will fail with a misleading
`Cannot read properties of undefined` error.

## Where things are decided

- **Provider chain / freemium fallback order:** `worker/_shared/pipeline-registry.js`
  (KV-persisted config at `pipeline:config`). See [`LOCAL_LLM_EXTRACTION.md`](LOCAL_LLM_EXTRACTION.md)
  for the local-vs-cloud extraction story.
- **Expression taxonomy → prosody/visuals:** `worker/_shared/expression-bucket.js`,
  `expression-prosody.js`, `expression-repass.js`; see
  [`EXPRESSION_SENSITIVITY_PLAN.md`](EXPRESSION_SENSITIVITY_PLAN.md) (fully implemented).
- **Character reference art:** `worker/_shared/illustration-character-match.js`
  (in-book embedded plates first) with `worker/_shared/external-refs.js` as
  the web-search fallback for books without embedded plates.
- **Timing/sync engine:** `web/src/timing/` — four tiers including a local
  WhisperX forced-alignment tier (`scripts/local-align-server/`).

## Historical docs (do not treat as current)

[`CURSOR_HANDOFF.md`](../CURSOR_HANDOFF.md) and [`HANDOFF.md`](../HANDOFF.md)
are point-in-time snapshots from 2026-06-17, before the Cloudflare Workers
port — both are now banner-marked historical at the top of the file. Prefer
this document for current architecture.
