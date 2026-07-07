# Setup: EbookAVPlayer on a Fresh Machine

Quick reference for bringing up the full stack locally. Every command and path
cited directly from the repo.

## Which backend?

Two backends exist. **`worker/` (Cloudflare Workers, via `wrangler dev`) is
current and what every command below uses by default.** `server/` (Python
FastAPI) is legacy — kept for reference and because `scripts/local-align-server`
still imports `server/align/forced_aligner.py`. It's covered separately at the
end, marked optional.

## Prerequisites

- **Node.js 18+** (for `wrangler` + web dev; [package.json:4](package.json#L4))
- **npm** (ships with Node)
- **Git** (to clone)
- **Python 3.10+** — only needed for the legacy `server/app.py` path or the
  local WhisperX align server; skip it for normal web/worker development.

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

## 3. Run locally (two terminals)

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
  `PATCH /books/:id/characters/rename {id, name}`
- **Logic:** [worker/_shared/character-merge.js](worker/_shared/character-merge.js)
  (merges across analysis.json + playback.json); alias applied at extraction
  time via [chapter-extract-pipeline.js:99-101](worker/_shared/chapter-extract-pipeline.js#L99)

## Troubleshooting

| Issue | Fix |
|---|---|
| `wrangler dev` fails with "port 8600 in use" | `lsof -i :8600 \| kill -9 <pid>`, or override with `PORT=8601 npm run dev:worker` |
| Tests fail with "module not found" | Re-run `npm install` at root **and** in `web/` |
| Web dev server proxy errors | Check `target` in [web/vite.config.js](web/vite.config.js) points at `:8600` |
| `web/src/timing/whisperxAlignerClient` calls fail | The local align bridge isn't running — see [scripts/local-align-server/server.py](scripts/local-align-server/server.py) (Python, separate from the worker) |
| `.env` edits don't take effect in `dev:worker` | You're editing `worker/.dev.vars` directly — edit root `.env` instead, `sync-dev-vars.mjs` regenerates it |
| Character merge doesn't persist | Confirm the KV binding in [worker/wrangler.toml:31](worker/wrangler.toml#L31) is configured |
| Graphify bootstrap fails | Install Ollama locally, or use `--backend web` (needs an API key) |

---

## Optional: legacy Python/FastAPI backend

Only needed if you're working on `server/` itself or a tool that imports it
(e.g. the local align server needs `server/align/forced_aligner.py`, but only
that one module — you don't need the FastAPI app running for it).

```bash
pip install -r requirements.txt
export GEMINI_API_KEY=<key>
uvicorn server.app:app --port 8600 --reload --reload-dir server
```

See [server/app.py](server/app.py) for the FastAPI app, and
[docs/HOST_CHECKLIST.md](docs/HOST_CHECKLIST.md) for its full host-verification
checklist (pytest, live Edge TTS smoke, Gemini smoke script). That checklist
predates the Workers port and does not cover `worker/`.

## Optional: local LLM extraction (Ollama)

The worker can run the EPUB extraction mega-pass against a locally-running
Ollama model instead of Gemini/cloud fallbacks — free, offline, no rate limit.
This also covers pointing any frontend (including the deployed production
site) at your local worker via the "local API bridge." Full writeup:
[docs/LOCAL_LLM_EXTRACTION.md](docs/LOCAL_LLM_EXTRACTION.md).

## Optional: local WhisperX align server

Backs the `whisperx-local` timing tier ([web/src/timing/whisperxAlignerClient.js](web/src/timing/whisperxAlignerClient.js)):

```bash
python3 scripts/local-align-server/server.py
# Exposes GET /health, used by the whisperx-local timing strategy
```

Tested by [tests/test_local_align_server.py](tests/test_local_align_server.py).

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
   then `npm run dev:worker` + `cd web && npm run dev`.
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
| Web UI | [Player.jsx](web/src/components/Player.jsx), [vite.config.js](web/vite.config.js) |
| Tests | [tests/](tests/) directory, [package.json](package.json) scripts |
| Environment | [.env.example](.env.example), [worker/wrangler.toml](worker/wrangler.toml) |
