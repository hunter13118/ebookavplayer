# HANDOFF.md — contract for finishing on the host machine

**2026-06-17:** MVP scaffold complete in repo (`e87b143`). Host verification **not
done** on the owner's Windows machine yet. Start with [`CURSOR_HANDOFF.md`](CURSOR_HANDOFF.md)
for current status; this file is the full contract.

Target: Cursor (or Copilot) on the owner's machine — Windows, network, Gemini API,
Edge TTS, optional Cloudflare deploy via MilkMan Portfolio embed.

Product brief: [`visual-audiobook-brief.md`](visual-audiobook-brief.md)  
Host steps: [`docs/HOST_CHECKLIST.md`](docs/HOST_CHECKLIST.md)

## Environment used for the build session (and its limitations)

- Linux sandbox, Python 3.10+, **all network egress blocked** (PyPI, npm, Edge TTS,
  Gemini all unreachable).
- Consequences:
  - **`pip install` / `npm install` could not run.** Source, tests, and schemas are
    complete but unverified on a real host until you install deps.
  - **Live Gemini and Edge TTS impossible** in sandbox even with keys.
  - **Playwright browsers not downloaded** in sandbox.
- Verified in sandbox without deps: EPUB parse logic, pydantic schema AST/shape checks,
  voice assignment math, timing.js pure functions, JSX/component structure, sample
  playback JSON validity.

On the host: copy `.env.example` → `.env`, fill `GEMINI_API_KEY`, install deps, run
the checklist.

## Repo map

```
server/                 FastAPI backend (port 8600)
  analyze/              Gemini mega-pass prompt + schema + client
  epub/parse.py         EPUB → chapters, body text, embedded image bytes
  images/generate.py    Gemini image gen + stock-pool + gradient fallback
  playback/compile.py  BookAnalysis → PlaybackBook (client JSON)
  playback/library.py   Catalog, sidecars, resume, progressive media
  audio/edge_tts.py     Edge TTS (tee from Gyōkan parallel-reader)
  audio/voices.py       Per-character voice + pitch de-collision
  app.py                /tts, /books, /ingest, /progress
web/                    React + Vite client (port 5173)
  src/audio/            orchestrator.js (timing authority), playSpeech.js, timing.js
  src/components/       Library, Player, Stage, sprites, dialogue boxes, controls
  tests/e2e/            41 Playwright specs (mocked API + stubbed Audio)
data/books/             Per-book sidecars + compiled playback JSON
scripts/smoke_extract.py  Minimal Gemini smoke (extract ± one image)
docs/                   HOST_CHECKLIST, integration explorations, ART_STYLES design
```

## Stub / seam registry

### analyze.gemini.analyze_book()
- **Status:** WRITTEN-NOT-RUN (no network / no `google-genai` in sandbox)
- **Contract:** One request per book → JSON validating as `BookAnalysis`; auto-repair
  pass on malformed JSON (hands model its bad output + validation error, one retry)
- **Tests:** `tests/test_compile.py` (sample analysis → playback compile);
  live: `scripts/smoke_extract.py BOOK.epub`
- **Env:** `GEMINI_API_KEY`, `GEMINI_MODEL` (default `gemini-2.5-flash`),
  `GEMINI_MAX_CHARS` (default 120000)
- **First prompt:** "Set GEMINI_API_KEY, run `scripts/smoke_extract.py` on a short
  EPUB, fix any model JSON drift, then POST `/ingest` and poll until done."

### images.generate.generate_media() / _gen_one()
- **Status:** WRITTEN-NOT-RUN live; gradient placeholders work without a key
- **Contract:** Primary chars + non-reused backgrounds via Gemini image model;
  secondary chars → `/media/stock/{g}{nn}.png`; `on_item` callback streams progress
- **Fallback seams:** Cloudflare FLUX / Hugging Face / local SD — **not wired** (comments in module)
- **Tests:** `--image` flag on smoke_extract; full path via `/ingest` (non-dry-run)
- **First prompt:** "Run ingest on a light novel with embedded images; confirm reference
  images reach the prompt; drop generic PNGs in `data/media/stock/` or accept gradients."

### audio.edge_tts (server + web playSpeech.js)
- **Status:** WRITTEN-NOT-RUN live network; contract tests exist
- **Contract:** `POST /tts {text, voice, pitch?, rate?} → audio/mpeg`; client fires
  one request per line; `seqToken` cancels in-flight on Next/Restart
- **Tests:** `tests/test_edge_tts_contract.py`; e2e `playback-order.spec.js`,
  `controls.spec.js`
- **Host smoke:**
  ```python
  from server.audio.edge_tts import synthesize_edge_mp3_sync as s
  open("out.mp3","wb").write(s("Hello.", "en-US-AndrewMultilingualNeural"))
  ```

### ingest dry_run
- **Status:** DONE
- **Behavior:** `dry_run=true` on `/ingest` (or "Extract only" in upload tray) runs
  parse + mega-pass, marks book **playable** with gradient placeholders, **skips images**
- **Use:** Preview script before spending image quota; re-ingest without flag for art

### portfolioAuth / Clerk embed
- **Status:** DONE (needs keys on deploy)
- **Files:** `web/src/lib/portfolioAuth.jsx`, `web/src/main.jsx`
- **Env:** `VITE_CLERK_PUBLISHABLE_KEY` (optional — app runs open without it)
- **Base path:** `VITE_BASE_PATH` default `/projects/ebookavplayer/` in `vite.config.js`
- **E2E bypass:** Playwright sets `localStorage['vae-e2e']='1'` when Clerk key is set

### In-player art-style toggle
- **Status:** KNOWN GAP — pref written, **no playback component reads it**
- **Today:** Art style only affects `/ingest art_style` at upload time
- **Decision needed:** Wire live swap (see `docs/ART_STYLES.md`) or remove toggle from player
- **Tests:** None until decided (`HOST_CHECKLIST.md` §3b)

### VoxNovel / script.json hybrid
- **Status:** DESIGN ONLY — `docs/AUDIOBOOK_INTEGRATION.md`, `docs/ECOSYSTEM_INTEGRATION.md`
- **Not built:** `POST /api/generate-from-script`, `timing.json`, M4B chapter markers on VoxNovel side
- **Join key:** stable `line idx` in `PlaybackBook`

### Phase 2 (explicitly deferred per brief)
- Offline book caching (images + audio clips)
- Audio post-FX (cave echo)
- Full multi-art-style swap + on-demand generation (`docs/ART_STYLES.md`)
- Cloudflare Workers queue replacing in-memory `JOBS` dict

## Manual verification checklist

- [ ] `pip install -r requirements.txt pytest` → `python -m pytest tests -q`
- [ ] Edge TTS smoke → `out.mp3` plays
- [ ] `cd web && npm install && npm run build`
- [ ] `npm run test:install && npm run test:e2e` → 41 pass
- [ ] `python scripts/smoke_extract.py BOOK.epub` → character/scene/line counts print
- [ ] `python scripts/smoke_extract.py BOOK.epub --image` → one PNG in `./smoke_out/`
- [ ] Full `/ingest` on real EPUB; open mid-processing → pinned bar + live art upgrade
- [ ] Manual QA: play/pause/next, 3 box styles, group-scene spotlight, checkpoint overlay
- [ ] Portfolio embed: Clerk sign-in, base path, API proxy to `:8600`

## Recommended host-machine order

**Start with [`docs/HOST_CHECKLIST.md`](docs/HOST_CHECKLIST.md)** — same steps, more detail.

1. `cd D:\EbookAVPlayer`
2. `pip install -r requirements.txt pytest` → `python -m pytest tests -q`
3. Copy `.env.example` → `.env`; set `GEMINI_API_KEY`
4. Edge TTS smoke (see registry above)
5. `python scripts/smoke_extract.py path\to\short.epub` then `--image`
6. `cd web && npm install && npm run build && npm run dev` — click through demo + backend
7. `npm run test:install && npm run test:e2e`
8. `uvicorn server.app:app --port 8600` + ingest a real book; verify progressive art
9. Optional: `SERVE_WEB_DIST=./web/dist` to co-host built client from FastAPI
10. Optional: deploy at portfolio subpath with Clerk + `VITE_API_BASE` pointing at API

## Exact first prompt for the next agent

> You are continuing the Visual Audiobook Engine (EbookAVPlayer). Read
> `visual-audiobook-brief.md`, then this HANDOFF.md, then `docs/HOST_CHECKLIST.md`.
> The MVP scaffold is complete; your machine has network and the real toolchain.
> Work through the host checklist until all items are green, fixing anything that
> only surfaces with real dependencies (Gemini payload shapes, Edge TTS, npm build,
> Playwright). Do not split the Gemini mega-pass or move timing logic out of
> `orchestrator.js`. When the checklist is green, resolve the in-player art-style
> toggle seam (wire it or remove it) before starting Phase 2 or VoxNovel integration.

## Related docs

| Doc | Purpose |
|---|---|
| `CURSOR_HANDOFF.md` | Short Cursor status + guardrails |
| `docs/HOST_CHECKLIST.md` | Step-by-step host verification |
| `docs/AUDIOBOOK_INTEGRATION.md` | VoxNovel hybrid / script.json deep dive |
| `docs/ECOSYSTEM_INTEGRATION.md` | Whole toolkit map (Gyōkan, portfolio, etc.) |
| `docs/ART_STYLES.md` | Multi-style design (not implemented) |
