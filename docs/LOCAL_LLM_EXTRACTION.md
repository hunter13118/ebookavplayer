# Local LLM extraction (frontend → local backend, no cloud API)

Extraction is the step that turns raw EPUB text into the mega-pass JSON
(characters, scenes, dialogue). Normally that mega-pass call goes to a cloud
LLM (Gemini, or a freemium fallback like Groq/Cerebras). This doc covers
running that same extraction against an **LLM on your own machine** via
[Ollama](https://ollama.com), and — separately — pointing a frontend (even the
deployed production site) at your local backend so it actually uses it.

These are two independent pieces that combine:

```
┌─────────────┐        ┌──────────────────────┐        ┌──────────────┐
│  Frontend    │  API   │  Worker (local        │  HTTP  │  Ollama       │
│  (any host)  │──────▶ │  `wrangler dev`, :8600)│──────▶ │  (:11434)     │
└─────────────┘  calls  └──────────────────────┘  calls └──────────────┘
     ^ "local API bridge"        ^ "ollama-7b / ollama-14b" extract provider
       (Part 2)                    (Part 1)
```

- **Part 1** makes the *worker* capable of extracting with a local model instead of a cloud one.
- **Part 2** makes *any* frontend — including `localhost:5173` or the deployed site — talk to *your* local worker instead of the production one.

If you're just doing normal local dev (`npm run dev:worker` + `cd web && npm run dev`, both on `localhost`), you only need Part 1 — the frontend already talks to your local worker by default. Part 2 is for using the hosted UI (or a teammate's machine) against your local Ollama setup.

## Part 1 — Ollama as the extraction provider

### Prerequisites

```bash
# Install Ollama: https://ollama.com/download
ollama serve                 # runs on :11434 by default; leave this running
ollama pull qwen2.5:7b       # required — the default local extract model
ollama pull qwen2.5:14b      # optional — higher quality, slower, disabled by default
```

### Enable it

Add to root `.env` (see [.env.example](../.env.example)):

```bash
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL_7B=qwen2.5:7b
OLLAMA_MODEL_14B=qwen2.5:14b
```

`npm run dev:worker` runs [scripts/sync-dev-vars.mjs](../scripts/sync-dev-vars.mjs)
before starting `wrangler dev`, which copies these three keys from `.env` into
`worker/.dev.vars` automatically. **Edit `.env`, not `worker/.dev.vars`** — the
sync script overwrites the latter on every `dev:worker` run.

### What happens once it's set

- [worker/api/v1/ingest.js:11](../worker/api/v1/ingest.js#L11) — if `OLLAMA_BASE_URL`
  is set, new ingest jobs default their extraction provider to `ollama-7b`
  instead of Gemini.
- [worker/_shared/pipeline-registry.js:157-158](../worker/_shared/pipeline-registry.js#L157)
  — the default extract chain is
  `["ollama-7b", "ollama-14b", "gemini", "cerebras", "groq", "mistral", "openrouter", "cloudflare"]`,
  with `ollama-14b` disabled by default (enable it in pipeline config if you
  want the bigger model tried before falling through to cloud providers).
- [worker/_shared/pipeline-registry.js:181-184](../worker/_shared/pipeline-registry.js#L181)
  — the inverse also holds: **if `OLLAMA_BASE_URL` is empty, both Ollama stages
  are force-disabled.** This is a hard gate, not just a default — Ollama only
  ever runs against a local dev server, never in production, because
  `localhost:11434` isn't reachable from Cloudflare's edge.
- [worker/_shared/freemium-extract.js:168-195](../worker/_shared/freemium-extract.js#L168)
  (`ollamaExtract`) — calls Ollama's native `/api/chat` (not the OpenAI-compat
  endpoint, so it can set `num_ctx` directly), with a 16384-token context
  window ([:150](../worker/_shared/freemium-extract.js#L150)) and a 20-minute
  timeout ([:166](../worker/_shared/freemium-extract.js#L166)) — local
  inference on CPU/consumer GPU is slow but has no rate limit, hence the long
  timeout.

### Forcing a specific provider for one ingest

`POST /api/v1/ingest` accepts a `prefer_provider` form field
([worker/api/v1/ingest.js:47](../worker/api/v1/ingest.js#L47)) — set it to
`ollama-7b`, `ollama-14b`, or `gemini` to override the default chain for that
one upload, without changing global config.

### Verifying it's actually being used

```bash
curl http://localhost:11434/api/tags        # confirm Ollama is up and the model is pulled
```

Then ingest a book and check the worker logs (`wrangler dev` terminal) for the
provider that ends up handling extraction. The chosen provider is also
recorded as `provider_used` on the book's extraction checkpoint
([worker/_shared/book-checkpoint.js:38](../worker/_shared/book-checkpoint.js#L38),
set in [chapter-extract-pipeline.js:219](../worker/_shared/chapter-extract-pipeline.js#L219))
— it'll say `ollama-7b` rather than `gemini` when it took this path.

## Part 2 — Local API bridge (point any frontend at your local worker)

This is unrelated to which LLM does extraction — it's about **where the API
calls go**. Use it when the frontend you're using (e.g. the deployed
production site) isn't the one running on `localhost:5173` next to your local
worker, but you still want it to hit your local worker (and therefore your
local Ollama setup).

### Enable / disable

Visit the frontend with a `?localApi=` query param — handled by
[web/src/localApiBridge.js](../web/src/localApiBridge.js)
(`initLocalApiBridgeFromUrl`, called from
[web/src/main.jsx](../web/src/main.jsx) on boot):

| URL | Effect |
|---|---|
| `?localApi=1` or `?localApi=true` or `?localApi=` (empty) | Points API calls at `http://127.0.0.1:8600/projects/ebookavplayer/api` (`DEFAULT_LOCAL_EDGE`) |
| `?localApi=http://127.0.0.1:8600/some/other/path` | Points at that exact URL instead |
| `?localApi=0` or `?localApi=off` or `?localApi=false` | Clears the override, back to normal |

The choice persists in `localStorage["vae-api-base"]` (survives reload; the
query param is stripped from the URL after being applied), and
[web/src/components/LocalApiBridgeBanner.jsx](../web/src/components/LocalApiBridgeBanner.jsx)
shows a dismissible banner while it's active. `web/src/api.js`'s `apiBase()`
resolves the bridge override *before* the build-time `VITE_API_BASE` and
before the same-origin/proxy fallback, so it takes priority over everything
except an active offline connection.

> There is no Settings-UI toggle for this today — some older docs
> (`CURSOR_HANDOFF.md`) reference "Settings → Developer → Local backend
> bridge," but that control was never built. The query param + localStorage
> mechanism above is the only way to set it.

### CORS — required if the frontend isn't on localhost

Your local worker only accepts cross-origin requests from origins it
recognizes ([worker/_shared/cors.js](../worker/_shared/cors.js)):
`localhost`/`127.0.0.1` (any port), `hunterthemilkman.com` and its `www`
subdomain, `*.pages.dev`, and `*.workers.dev` are allowed by default. If
you're bridging from somewhere else (e.g. a `cloudflared` tunnel URL), add it
to `worker/.dev.vars`:

```bash
VAE_CORS_ORIGINS=https://your-tunnel-name.trycloudflare.com
```

(comma-separated for multiple origins; each is regex-escaped and matched
exactly — see [worker/.dev.vars.example](../worker/.dev.vars.example)).

### Exposing your local worker to a non-localhost frontend

`127.0.0.1:8600` is only reachable from your own machine. To bridge from the
*deployed* production site, your local worker needs to be reachable from the
internet — the established pattern here is a `cloudflared` quick tunnel:

```bash
cloudflared tunnel --url http://localhost:8600
# copy the printed https://<random>.trycloudflare.com URL
```

Then add that URL to `VAE_CORS_ORIGINS` (above), restart `dev:worker`, and
visit the deployed site with
`?localApi=https://<random>.trycloudflare.com/projects/ebookavplayer/api`.

## Putting it together: fully local, fully free extraction from the hosted site

1. `ollama serve` + `ollama pull qwen2.5:7b` (Part 1 prerequisites).
2. `OLLAMA_BASE_URL=http://localhost:11434` in root `.env`.
3. `npm run dev:worker` (picks up the Ollama config via `sync-dev-vars.mjs`).
4. Either use `localhost:5173` directly (no bridge needed), or start a
   `cloudflared` tunnel, add it to `VAE_CORS_ORIGINS`, and visit the deployed
   site with `?localApi=<tunnel-url>/projects/ebookavplayer/api` (Part 2).
5. Upload an EPUB. Extraction runs on your GPU/CPU via Ollama; nothing leaves
   your machine except the frontend's API calls (which stay on your own
   tunnel if you're using one).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Ingest still uses Gemini even with `OLLAMA_BASE_URL` set | `.env` edited but `worker/.dev.vars` is stale — restart `npm run dev:worker` so `sync-dev-vars.mjs` reruns; don't hand-edit `worker/.dev.vars` |
| Extraction times out around 20 minutes | Expected ceiling (`OLLAMA_TIMEOUT_MS`) — a 14B model on CPU-only hardware on a long chapter can be genuinely slow; try `qwen2.5:7b` or chunk the book smaller (`EXTRACT_CHUNK_MAX_TOKENS`) |
| `ollama-7b`/`ollama-14b` don't appear in the pipeline config UI | They're force-disabled whenever `OLLAMA_BASE_URL` is unset — this is intentional, not a bug |
| Bridge banner doesn't appear / API calls still hit production | Check `localStorage["vae-api-base"]` in devtools; the `?localApi=` param only applies once on load, then rewrites the URL to remove itself |
| Bridged frontend gets CORS errors in the console | Its origin isn't in `worker/_shared/cors.js`'s allow-list and isn't covered by `VAE_CORS_ORIGINS` — add it and restart `dev:worker` |
| Tunnel works but requests still fail | `cloudflared` free quick tunnels rotate URLs on restart — update `VAE_CORS_ORIGINS` and the `?localApi=` URL together each time |

## References

| Topic | File(s) |
|---|---|
| Ollama extract provider | [worker/_shared/freemium-extract.js](../worker/_shared/freemium-extract.js) (`ollamaExtract`) |
| Provider chain / gating | [worker/_shared/pipeline-registry.js](../worker/_shared/pipeline-registry.js) |
| Default provider selection | [worker/api/v1/ingest.js](../worker/api/v1/ingest.js) |
| Env sync | [scripts/sync-dev-vars.mjs](../scripts/sync-dev-vars.mjs), [worker/.dev.vars.example](../worker/.dev.vars.example) |
| Local API bridge | [web/src/localApiBridge.js](../web/src/localApiBridge.js), [web/src/components/LocalApiBridgeBanner.jsx](../web/src/components/LocalApiBridgeBanner.jsx), [web/src/api.js](../web/src/api.js) |
| CORS | [worker/_shared/cors.js](../worker/_shared/cors.js) |
| General setup | [../SETUP.md](../SETUP.md) |
