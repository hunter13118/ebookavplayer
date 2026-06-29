# Visual Audiobook Engine (EbookAVPlayer)

Turn an EPUB you own into a procedurally generated **visual audiobook** — a
game-style reading experience where characters speak in their own voices over
scene backgrounds, with typewriter text synced to the audio. A visual aid for
*listening* (treadmill / study / passenger seat), not a movie.

See [`visual-audiobook-brief.md`](visual-audiobook-brief.md) for the full design
brief. This repo is the MVP scaffold built against it.

## What's here

```
server/                 FastAPI backend (does the heavy lifting; client stays dumb)
  audio/edge_tts.py      Edge neural TTS — copied to a tee from the Gyōkan
                         parallel-reader (Communicate.stream pattern)
  audio/voices.py        per-CHARACTER voice assignment + pitch de-collision
  analyze/prompt.py      the single Gemini mega-pass prompt (one call per book)
  analyze/schema.py      analysis + playback pydantic schemas
  analyze/gemini.py      Gemini client (mega-pass)
  epub/parse.py          EPUB -> chapters/text/embedded-image bytes
  images/generate.py     Gemini image gen (primary chars/bg) + stock-pool fallback
  playback/compile.py    analysis -> lightweight playback JSON the client consumes
  app.py                 /tts, /voices/edge, /books, /ingest (background job)
  sample/                sample analysis + host builder
web/                     React + Vite client
  src/App.jsx                view router: Library landing <-> Player
  src/library.js             resume / reading-progress (localStorage + server sync)
  src/audio/playSpeech.js    Edge playback — copied to a tee (seqToken cancel,
                             one /tts call per line, routed by character)
  src/audio/orchestrator.js  single timing authority (audio + sprite + typewriter)
  src/audio/timing.js        pure pacing math (unit-tested)
  src/components/            Library, BookCard, Uploader, ProcessingBar,
                             Stage, Sprite, DialogueBox (3 styles), Controls, ...
data/books/              per-book sidecars (.analysis/.media/.status/.progress)
                         + compiled sample
tests/                   python + node tests; web/tests/e2e Playwright specs

## Landing page & library

The app opens on a **library**: a grid of book covers (real title always
beneath). A book still being processed shows a spinner + live progress instead
of a cover; a book you've started shows a reading-progress bar and a Resume
chip. Below the grid is an **upload tray** — drop an EPUB and it kicks off the
Gemini pipeline, appearing immediately as a processing placeholder that polls
to ready.

Because the Gemini mega-pass is atomic, a book becomes **playable the moment
analysis finishes** (gradient placeholders for art). Opening it then shows a
**pinned top progress bar**, and generated character/scene art streams in live
via polling, upgrading placeholders without interrupting playback. Resume
position (book / chapter / scene / line) is saved to localStorage and synced to
`/books/{id}/progress`.
```

## Quick start

Backend (Python 3.10+):

```bash
pip install -r requirements.txt
cp .env.example .env          # add GEMINI_API_KEY for ingest; TTS needs no key
uvicorn server.app:app --host 0.0.0.0 --port 8600 --reload --reload-dir server
```

Frontend:

```bash
cd web
npm install
echo "VITE_API_BASE=http://localhost:8600" > .env.local
npm run dev                   # http://localhost:5173
```

Open the client. With the backend running you get **voiced** playback (Edge TTS);
with no backend it plays the embedded demo (`The Silver Gate`) as text + sprites
with silent timed reveal, so the UI is always demonstrable.

## Ingest a book

`POST /ingest` with an EPUB (multipart `file`, optional `art_style`,
`narrator_gender`) returns a `job_id`; poll `GET /ingest/{job_id}`. The job runs
the single Gemini mega-pass, image generation, and compiles a playback book into
`data/books/`. The client lists it at `GET /books`.

## How the Edge TTS matches the parallel-reader

`server/audio/edge_tts.py` and `web/src/audio/playSpeech.js` are copied from the
Gyōkan project's proven implementation. The only adaptation: Gyōkan routed
voices by **language**; here every playback line carries its own
character voice/pitch/rate, so we route by **character** and never by screen
position. `pitch`/`rate` are passed through to `edge-tts` for collision
de-duplication (deeper male / higher child) per the brief.

## Status

MVP scaffold. End-to-end path is wired and verified except where a host is
required (live TTS network, `npm run build`, Gemini API). See
[`docs/HOST_CHECKLIST.md`](docs/HOST_CHECKLIST.md). Phase 2 (per the brief):
character art variants, offline caching, advanced audio effects (cave echo).

**Cursor / host handoff:** [`CURSOR_HANDOFF.md`](CURSOR_HANDOFF.md) (short status +
guardrails), [`HANDOFF.md`](HANDOFF.md) (full contract + stub registry).
