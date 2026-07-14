# Visual Audiobook Engine (EbookAVPlayer)

Turn an EPUB you own into a procedurally generated **visual audiobook** — a
game-style reading experience where characters speak in their own voices over
scene backgrounds, with typewriter text synced to the audio. A visual aid for
*listening* (treadmill / study / passenger seat), not a movie.

See [`visual-audiobook-brief.md`](visual-audiobook-brief.md) for the full design brief.

## Which backend do I use?

There is **one** backend: `worker/` (Cloudflare Workers) — start with
`npm run dev:worker`. An earlier Python/FastAPI implementation is archived at
`legacy/server/`, kept for reference and because a few dev tools still import
individual modules from it. Don't start it with `uvicorn` unless you have a
specific reason to.

## Quick start (current stack)

```bash
npm install                    # root: wrangler, fflate, pngjs, jpeg-js
cd web && npm install && cd .. # web client deps

cp .env.example .env           # add GEMINI_API_KEY (free tier via AI Studio)
```

Two terminals:

```bash
npm run dev:worker             # terminal 1 — Worker API on :8600 (wrangler dev)
cd web && npm run dev          # terminal 2 — Vite client on :5173
```

Open **http://localhost:5173**. With the worker running you get real ingest +
voiced playback; with no backend reachable, the client falls back to the
embedded demo (*The Silver Gate*) so the UI is always demonstrable.

For the full walkthrough (env vars, every test target, troubleshooting,
Claude Code setup), see **[SETUP.md](SETUP.md)**.

## What's here

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the living current-state
doc (guardrails, test-running, where things are decided). Quick map:

```
worker/                 Cloudflare Workers backend (current)
  worker.js              routes /api/v1/* → handlers
  api/v1/                books, ingest, characters, tts, voices, media, progress...
  _shared/                extraction pipeline, compile, voice-assign, character-merge (48 modules)
  durable-objects/        job/queue coordination
  wrangler.toml           R2 + KV bindings, dev port

legacy/server/           Archived FastAPI backend (reference only; see note above)
  align/forced_aligner.py  dead — backed a removed timing-UI option
  analyze/, epub/, images/, playback/, audio/  original mega-pass pipeline;
                           still imported by a few scripts/*.py dev tools
  app.py                  original /tts, /voices/edge, /books, /ingest routes

web/                     React + Vite client
  src/audio/               orchestrator.js (timing authority), playSpeech.js,
                           sharedAudioSource.js, lineAt.js
  src/timing/              alignment strategies: fromContainer, registry,
                           whisperxAlignerClient, slides
  src/offline/             offline pack cache, alignment cache
  src/components/          Library, Player, Stage, Sprite, dialogue boxes,
                           CharacterManager, GapNavSheet, Controls...

scripts/local-align-server/  Local WhisperX forced-alignment bridge (dev tool)
data/books/              per-book sidecars (.analysis/.media/.status/.progress)
tests/                   node + python tests; web/tests/e2e Playwright specs
```

## Landing page & library

The app opens on a **library**: a grid of book covers (real title always
beneath). A book still being processed shows a spinner + live progress instead
of a cover; a book you've started shows a reading-progress bar and a Resume
chip. Below the grid is an **upload tray** — drop an EPUB and it kicks off the
extraction pipeline, appearing immediately as a processing placeholder that
polls to ready.

Because extraction is atomic, a book becomes **playable the moment analysis
finishes** (gradient placeholders for art). Opening it then shows a **pinned
top progress bar**, and generated character/scene art streams in live via
polling, upgrading placeholders without interrupting playback. Resume position
(book / chapter / scene / line) is saved to localStorage and synced to the
progress endpoint.

## Ingest a book

`POST /api/v1/ingest` with an EPUB (multipart `file`, optional `art_style`,
`narrator_gender`) returns a `job_id`; poll its progress endpoint. The job runs
extraction, image generation, and compiles a playback book that the client
lists via the books endpoint.

## Status

Actively developed. Recent work: chapter-checkpointed extraction, character
management (merge/rename post-extraction), multi-backend image/extract
providers, and a four-tier audio↔script timing engine (including a local
WhisperX forced-alignment tier). See [`docs/HOST_CHECKLIST.md`](docs/HOST_CHECKLIST.md)
for the legacy Python-path host checklist.

**Historical handoffs (point-in-time status snapshots, not living docs):**
[`CURSOR_HANDOFF.md`](CURSOR_HANDOFF.md), [`HANDOFF.md`](HANDOFF.md) — both
predate the Workers port and describe the original FastAPI-only MVP.
