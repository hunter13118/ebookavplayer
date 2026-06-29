# Cursor Handoff (2026-06-17)

**Bucket A: MVP scaffold shipped.** **Bucket B: host verification + polish.**

Read [`visual-audiobook-brief.md`](visual-audiobook-brief.md) for product intent, then
[`HANDOFF.md`](HANDOFF.md) for the full host contract.

## Bucket A results (done in repo)

| Area | Result |
|---|---|
| End-to-end wiring | Library → upload → Gemini ingest → playback JSON → voiced player |
| Backend | FastAPI: `/books`, `/ingest`, `/tts`, `/voices/edge`, resume progress |
| Frontend | React/Vite: library landing, player, 3 dialogue styles, orchestrator |
| Sample book | `data/books/the-silver-gate.json` + embedded offline demo |
| Edge TTS | Copied pattern from Gyōkan; routes by **character**, not screen position |
| Tests (written) | Python unit tests + **41** Playwright e2e specs (12 files, mocked backend) |
| Portfolio embed | Clerk auth gate + `VITE_BASE_PATH=/projects/ebookavplayer/` |
| Docs | `HOST_CHECKLIST.md`, `AUDIOBOOK_INTEGRATION.md`, `ECOSYSTEM_INTEGRATION.md` |

Built in sandbox with **no PyPI/npm install and no outbound network**. Pure logic,
schema shapes, EPUB parsing, voice assignment, and JSX structure were verified there.
Live Gemini, Edge TTS, `npm run build`, and Playwright browser runs are **host-only**.

## Bucket B (your machine — not green yet)

Run [`docs/HOST_CHECKLIST.md`](docs/HOST_CHECKLIST.md) top to bottom. On this Windows
host (2026-06-17): `pytest` and Playwright Chromium were **not installed** — e2e failed
with "Executable doesn't exist"; Python tests failed with "No module named pytest".

Priority order:

1. `pip install -r requirements.txt pytest` → `python -m pytest tests -q`
2. `cd web && npm install && npm run build`
3. `npm run test:install && npm run test:e2e` (sets `localStorage vae-e2e=1` to bypass Clerk)
4. Gemini smoke: `python scripts/smoke_extract.py path/to/book.epub [--image]`
5. Full ingest on a real EPUB (light novel with embedded images ideal)
6. Resolve known UI seam: in-player art-style toggle writes a pref nothing reads (ingest-only today)

## Quick commands (PowerShell)

```powershell
cd D:\EbookAVPlayer
pip install -r requirements.txt pytest
python -m pytest tests -q

# Backend + frontend (two terminals)
uvicorn server.app:app --host 0.0.0.0 --port 8600 --reload
cd web; npm install; echo "VITE_API_BASE=http://localhost:8600" > .env.local; npm run dev

# E2E
cd web; npm run test:install; npm run test:e2e

# Local edge worker (same routes as production CF deploy)
cd ebookavplayer
copy worker\.dev.vars.example worker\.dev.vars   # add GEMINI_API_KEY etc.
npm install
npm run dev:worker    # http://127.0.0.1:8600/projects/ebookavplayer/api/health

# Bridge deployed SPA → local edge (same machine)
# https://hunterthemilkman.com/projects/ebookavplayer/?localApi=1
# Or Settings → Developer → Local backend bridge

# Gemini smoke (needs GEMINI_API_KEY in .env or env)
python scripts/smoke_extract.py path\to\book.epub
python scripts/smoke_extract.py path\to\book.epub --image
```

Copy `.env.example` → `.env` and add `GEMINI_API_KEY`. Edge TTS needs **no key**.

## Architecture guardrails (do not drift)

From [`visual-audiobook-brief.md`](visual-audiobook-brief.md):

- **One Gemini mega-pass per book** — do not split analysis into many calls without updating rate-limit docs.
- **Client stays dumb** — server compiles playback JSON; orchestrator is the single timing authority.
- **Edge TTS server-side** — browsers can't set Edge WS headers; keep `/tts` on FastAPI.
- **Per-character voice routing** — never key voices off sprite screen position.
- **Progressive ingest** — analysis makes a book playable before images finish; do not block playback on art.
- **Phase 2 is out of scope** unless asked: offline caching, cave-echo FX, full multi-style swap (`docs/ART_STYLES.md`).

## Still open

- [ ] Host checklist all green (see above)
- [ ] Sample EPUB with embedded images for reference-image extraction QA (brief open item)
- [ ] Stock sprite pool under `data/media/stock/` (or accept gradient placeholders)
- [ ] Wire or remove in-player art-style toggle (no e2e until decided)
- [ ] `docs/ART_STYLES.md` — design only; untracked; multi-style swap not built
- [ ] VoxNovel hybrid (`script.json` + `timing.json`) — exploratory in `docs/AUDIOBOOK_INTEGRATION.md`
- [ ] Cloudflare Workers port: swap in-memory `JOBS` dict for a queue; keep background ingest thread pattern

## Exact first prompt for the next Cursor agent

> You are continuing the Visual Audiobook Engine (EbookAVPlayer). Read
> `visual-audiobook-brief.md`, then `HANDOFF.md`, then `docs/HOST_CHECKLIST.md`.
> The MVP scaffold is complete; your job is to run the host checklist until green,
> fix anything that only surfaces with real deps (Gemini JSON shape, Edge TTS,
> npm build, Playwright), and ingest one real EPUB. Do not change the architecture
> guardrails in CURSOR_HANDOFF.md. After the checklist is green, pick the highest-
> value open item from HANDOFF.md (art-style toggle seam or ART_STYLES foundation).
