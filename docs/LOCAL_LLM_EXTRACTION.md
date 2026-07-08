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
     ^ "local API bridge"        ^ "ollama-7b / ollama-20b / ollama-30b / ollama-14b" extract provider
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
ollama pull gpt-oss:20b      # required — new default local extract model (see benchmark below)
ollama pull qwen3:30b-a3b    # optional — strong Qwen-family alternative
ollama pull qwen2.5:7b       # optional — original small/fast baseline, still available
ollama pull qwen2.5:14b      # optional — legacy, disabled by default, superseded by the above
```

### Enable it

Add to root `.env` (see [.env.example](../.env.example)):

```bash
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL_7B=qwen2.5:7b
OLLAMA_MODEL_20B=gpt-oss:20b
OLLAMA_MODEL_30B=qwen3:30b-a3b
OLLAMA_MODEL_14B=qwen2.5:14b
```

`npm run dev:worker` runs [scripts/sync-dev-vars.mjs](../scripts/sync-dev-vars.mjs)
before starting `wrangler dev`, which copies these keys from `.env` into
`worker/.dev.vars` automatically. **Edit `.env`, not `worker/.dev.vars`** — the
sync script overwrites the latter on every `dev:worker` run.

### Ollama concurrency: benchmarked, and the answer is "don't"

`VAE_EXTRACT_CONCURRENCY` (see [SETUP.md](../SETUP.md#tweaking-parallel-chapter-extraction))
controls how many chapters the *worker* dispatches at once. `OLLAMA_NUM_PARALLEL`
(an env var for the `ollama serve` process itself — **not** read from
`.env`/`worker/.dev.vars`) controls how many of those requests Ollama serves
concurrently on its one loaded model, sharing weights with only the per-slot
KV cache scaling up.

It's tempting to assume raising both together scales throughput — that's what
continuous batching is supposed to buy you. **Measured on this machine (Apple
M4 Pro, 48GB unified memory, 20-core GPU, Ollama 0.31.1, qwen2.5:7b, 16K
context, matching the real extraction prompt size), it does the opposite:**

| Config | Aggregate tok/s (all concurrent requests summed) | Peak RSS |
|---|---|---|
| Solo (1 request, no contention) | **43.9** | 3.9 GB |
| `OLLAMA_NUM_PARALLEL=4` | 18.8 | 3.9 GB |
| `OLLAMA_NUM_PARALLEL=8` | 18.6 | 7.5 GB |
| `OLLAMA_NUM_PARALLEL=12` | 22.3 | 16.1 GB |
| `OLLAMA_NUM_PARALLEL=4` + `OLLAMA_FLASH_ATTENTION=1` | 18.5 | 3.9 GB |

Method: restart `ollama serve` at each level, fire that many concurrent
`/api/generate` requests (same ~2500-token prompt, `num_predict=300`,
`num_ctx=16384` — sized to match a real chapter-extraction call), measure
total tokens decoded across all requests divided by batch wall-clock.

Two things stand out:
- **Aggregate throughput is flat (~18-22 tok/s) from 4 slots all the way to
  12** — the GPU saturates at the very first concurrency level tested. RSS
  climbs linearly (matching the ~0.9 GB/slot KV-cache math) while nothing is
  gained for it — confirming **memory was never the ceiling; GPU compute was**.
- **The parallel ceiling is *below* solo throughput.** Running 4 chapters
  "concurrently" nets 18.8 tok/s combined; running them one at a time gets
  43.9 tok/s each, sequentially. On this Metal/llama.cpp backend, concurrent
  decode contends for the same GPU resources without the continuous-batching
  win you'd expect on server GPU hardware — so parallelism is **net negative**
  for total book-extraction time, not just non-positive.
- Enabling `OLLAMA_FLASH_ATTENTION=1` didn't change this for qwen2.5:7b —
  same ~18.5 tok/s ceiling at `NUM_PARALLEL=4`. **This turned out to be
  model-specific, not universal — see "Flash attention: a real free win"
  below, where it's a large win for the MoE models this repo now defaults
  to.** Keep `OLLAMA_NUM_PARALLEL=1` regardless (that conclusion held for
  every model tested); do enable flash attention.

**Conclusion for local Ollama extraction: `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_FLASH_ATTENTION=1`.**

```bash
# ~/.zshrc
export OLLAMA_NUM_PARALLEL=1
export OLLAMA_FLASH_ATTENTION=1
```
```bash
# .env
VAE_EXTRACT_CONCURRENCY=1
```

If you're on different hardware (especially a discrete/CUDA GPU, where
continuous batching is generally much more effective than on Apple Silicon
Metal), don't assume this transfers — rerun the same method above before
trusting a higher number. And note this conclusion is specific to *local
Ollama* extraction; if you're extracting through a cloud provider instead
(Cerebras/Groq/etc.), their compute isn't your machine's problem, and a
higher `VAE_EXTRACT_CONCURRENCY` is a reasonable, untested-here bet.

### Model comparison: is there something better than qwen2.5 for extraction?

Re-ran the same method (real chapter text — ~16K chars from a test-fixture
EPUB, pushed through the actual `buildSystemPrompt()`/schema-hint prompt this
codebase sends, `num_ctx=16384`, `num_predict=300`, `temperature=0.2`,
`/api/generate`, non-streaming) against six candidates beyond the qwen2.5
baseline, restarting `ollama serve` at each `OLLAMA_NUM_PARALLEL` level like
before:

| Model | Type | Solo tok/s | Parallel=4 agg tok/s | Parallel=8 agg tok/s | Peak RSS |
|---|---|---|---|---|---|
| qwen2.5:7b (existing baseline) | dense 7B | 43.9 | 18.8 | 18.6 | 3.9 GB |
| qwen3:4b | dense 4B | 34.4 | — | 17.4 | 2.5 GB (18.3 GB @ p8) |
| qwen3:8b | dense 8B | 25.7 | 13.1 | — | 2.5 GB (9.3 GB @ p4) |
| qwen3:30b-a3b | MoE, ~3B active/token | 29.1 | 17.3 | — | 1.7 GB (6.3 GB @ p4) |
| **gpt-oss:20b** | **MoE, ~3.6B active/token** | **31.4** | **21.6** | **20.9** | 0.7 GB (4.0 GB @ p8) |
| qwen3:32b | dense 32B | 7.2 | 2.8 (collapse) | — | 4.3 GB (34.1 GB @ p4) |
| gemma3:27b | dense 27B | 11.1 | 4.6 (collapse) | — | 3.8 GB (25.8 GB @ p4) |

Three findings:

- **The parallel-throughput-loss finding isn't specific to qwen2.5:7b or to
  dense models — it's universal on this backend, but the *severity* varies a
  lot, and one model (gpt-oss:20b) is a real outlier.** Every dense model
  tested loses 40-90% of solo throughput under concurrency, and the two
  "bigger dense" candidates (qwen3:32b, gemma3:27b) don't just lose
  throughput, they **collapse** — 7.2→2.8 and 11.1→4.6 tok/s respectively at
  parallel=4, with RSS ballooning to 34 GB and 26 GB. Both are ruled out for
  this hardware: too slow solo, actively dangerous under any concurrency.
  qwen3:30b-a3b (MoE) also degrades under load (29.1→17.3), just less badly
  than dense models of similar total size. **gpt-oss:20b is the one exception**
  — it holds ~21 tok/s essentially flat from parallel=4 to parallel=8 (21.6 →
  20.9), the only model in this entire comparison (including the original
  qwen2.5:7b benchmark) that doesn't keep degrading as concurrency rises. This
  is very likely its native MXFP4 quantization/attention path batching more
  efficiently under llama.cpp's Metal backend than the other GGUF quants
  tested — genuinely worth using if you want `VAE_EXTRACT_CONCURRENCY > 1`
  ([worker/_shared/pipeline-registry.js](../worker/_shared/pipeline-registry.js)
  gates this per-model already; `ollama-20b` is the one stage where raising
  concurrency past 1 might actually be worth re-testing on your own hardware,
  though the general "set both to 1" guidance above still holds until you've
  confirmed it transfers).
- **gpt-oss:20b is now the best all-around pick — fastest solo of every
  larger/alternative model tried (31.4 tok/s; still behind qwen2.5:7b's 43.9,
  but it's a much bigger, more capable model at a smaller speed tax than
  anything else here) *and* the only one that scales.** It's a MoE model
  (~20B total, ~3.6B active/token) from a different lineage than the Qwen
  family, and it
  wins on every speed axis measured here. qwen3:30b-a3b remains a strong
  second choice (29.1 solo) if you want the Qwen family specifically.
- **No dedicated "narrative-specific" model helped.** Gemma 3 (27B) has a
  strong reputation for prose/creative-writing quality, and Qwen3-32B is
  simply a bigger dense Qwen — neither is a fit here, and not just on
  speed: this pipeline's system prompt explicitly says *"you never invent
  plot; you only segment, attribute, and describe what is already in the
  text"* ([extract-prompt.js:6-8](../worker/_shared/extract-prompt.js#L6)) —
  the task rewards **faithfulness to source text**, not creative
  embellishment, so a model tuned for creative narrative generation isn't
  obviously better-suited than a strong general-instruction MoE model, and in
  this case was much slower to boot. (Extraction *accuracy* — as opposed to
  raw tok/s — was not independently scored here; the speed numbers above are
  measured, the accuracy/faithfulness claims are inferred from each model's
  general instruction-following reputation and would benefit from a real
  side-by-side ingest comparison before leaning on them further.)

**Wired in this session:** `ollama-20b` (gpt-oss:20b) and `ollama-30b`
(qwen3:30b-a3b) are now real selectable stages, not just benchmark data —
see below.

### Flash attention: a real free win, re-enabled

The original concurrency benchmark above concluded flash attention "didn't
change" throughput — true, but only for qwen2.5:7b specifically. Re-tested
with `OLLAMA_FLASH_ATTENTION=1` against every model still in rotation:

| Model | Solo (no flash) | Solo (flash) | Parallel=4/8 (no flash) | Parallel=4/8 (flash) |
|---|---|---|---|---|
| qwen2.5:7b | 43.9 | 41.5 (noise, no real change) | 18.8 @p4 | 17.8 @p4 (no real change) |
| gpt-oss:20b | 31.4 | **44.0** | 20.9 @p8 | **30.1 @p8** |
| qwen3:30b-a3b | 29.1 | **52.6** | 17.3 @p4 | **24.9 @p8** |

Flash attention only changes how attention/KV-cache math is computed — same
model weights, same quantization, **zero accuracy cost** — and it's a large
win specifically for the two MoE models this repo now defaults to (gpt-oss:20b,
qwen3:30b-a3b), while staying neutral for the older qwen2.5:7b (matching the
original finding for that model). Quantized KV cache
(`OLLAMA_KV_CACHE_TYPE=q8_0`) was tested on top of flash attention and added
nothing further (27.4 tok/s @p8 vs. 30.1 without it, for gpt-oss:20b) —
consistent with this machine being GPU-compute-bound rather than
memory-bandwidth-bound, so shrinking the KV cache's memory footprint doesn't
help when compute was never the bottleneck.

**Enabled going forward:** `~/.zshrc` now exports `OLLAMA_FLASH_ATTENTION=1`
alongside the existing `OLLAMA_NUM_PARALLEL=1`. This is a shell/process env
var for `ollama serve` itself — not read from this repo's `.env`, same as
`OLLAMA_NUM_PARALLEL`.

### MLX: tested as an alternative runtime, model-dependent result

The parallel-throughput ceiling above is Ollama's llama.cpp/Metal backend
specifically. Apple's own [MLX](https://github.com/ml-explore/mlx) framework
has a different, natively-Metal-optimized batching engine
(`mlx_lm.server`, OpenAI-compatible API, `--decode-concurrency` flag) — worth
checking whether it does better. **Important constraint: MLX only runs on
Apple Silicon — never Windows, Linux, or Intel Mac — so it can only ever be
an optional, additive local backend alongside Ollama, never a replacement.**
Ollama remains the only cross-platform local option and must keep working
unmodified for non-Apple-Silicon users.

Tested `mlx-community/gpt-oss-20b-MXFP4-Q8` and `mlx-community/Qwen3-30B-A3B-4bit`
(closest available MLX quantizations to what Ollama runs) via `mlx_lm.server
--decode-concurrency 8`, using the same real prompt but with **genuinely
different, never-before-sent chapter text per request** — an early pass here
mistakenly reused already-cached prompts across "concurrent" requests, which
inflated one result to a bogus 81.6 tok/s; the numbers below are the
corrected, honest ones:

| Model | Runtime | Solo tok/s | Parallel=8 agg tok/s |
|---|---|---|---|
| gpt-oss:20b | Ollama + flash attention | **44.0** | 30.1 |
| gpt-oss:20b | MLX | 25.9 | 29.1 |
| qwen3:30b-a3b | Ollama + flash attention | **52.6** | 24.9 |
| qwen3:30b-a3b | MLX | 18.6 | **39.1** |

The result is genuinely split by model, not a clean win either way:

- **gpt-oss:20b: MLX doesn't help.** It loses on solo (25.9 vs. 44.0) and
  roughly ties on parallel (29.1 vs. 30.1). No reason to run this model
  through MLX.
- **qwen3:30b-a3b: MLX loses solo badly (18.6 vs. 52.6) but wins parallel
  clearly (39.1 vs. 24.9).** If chapter extraction ever runs with
  `VAE_EXTRACT_CONCURRENCY > 1`, MLX + qwen3:30b-a3b is the best local
  combination found in this entire investigation for that specific case —
  better than every Ollama config tested, flash attention included.

**Not wired into the codebase.** Given `VAE_EXTRACT_CONCURRENCY=1` is (still)
the recommended default — solo beats parallel for every *other* config tested
— the practical win today is flash attention alone (already enabled, zero
integration cost). MLX would require a second serving stack (separate Python
venv, `mlx-lm`, its own SSL/networking quirks encountered during this
session's testing) gated behind something like `MLX_BASE_URL`, mirroring how
`OLLAMA_BASE_URL` gates Ollama, purely as an *additional* opt-in option next
to `ollama-20b`/`ollama-30b` — never replacing them. Worth revisiting if/when
concurrent chapter extraction becomes a real requirement rather than a
benchmarked curiosity.

### Choosing a preset

Three named presets exist, each pinning a different local model to the front
of the extract chain (still a fallback chain, not exclusive — the others stay
available if the leader errors out). Pick one via **Settings → AI Pipeline →
Local extraction presets** in the app (drag-free — a "Use this" button applies
it), or `PATCH /pipeline` with `{"apply_local_extract_preset": "<id>"}`
directly. Definitions live in
[worker/_shared/local-extract-presets.js](../worker/_shared/local-extract-presets.js).

| Preset (`id`) | Leads with | Effectiveness (this machine) | Recommended env | Pick this when |
|---|---|---|---|---|
| **Fastest** (`local_fastest_solo`) — default | `ollama-30b` (qwen3:30b-a3b) | ~53 tok/s solo | `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_NUM_PARALLEL=1`, `VAE_EXTRACT_CONCURRENCY=1` | Almost always — you're extracting one book/chapter at a time (the default) |
| **Best for concurrent chapters** (`local_best_concurrent`) | `ollama-20b` (gpt-oss:20b) | ~44 tok/s solo, ~30 tok/s aggregate @ 8-way concurrency | same, but `VAE_EXTRACT_CONCURRENCY=4`+ | You've deliberately raised `VAE_EXTRACT_CONCURRENCY` above 1 — every other model loses 40-90% of its throughput there, this one barely does |
| **Lightweight** (`local_lightweight`) | `ollama-7b` (qwen2.5:7b) | ~42 tok/s solo, 4.7GB download | same as Fastest (flash attention is neutral for this model) | Tight disk/RAM budget, or hardware where the MoE models haven't been validated |

`OLLAMA_FLASH_ATTENTION`/`OLLAMA_NUM_PARALLEL` are `ollama serve` process env
vars (shell, not `.env`) and `VAE_EXTRACT_CONCURRENCY` is a repo `.env`
var — none of these are set by clicking a preset, since the API can only
reorder the KV-persisted extract chain, not touch process/shell env. The
preset descriptions in the UI spell out what to set alongside it.

### What happens once it's set

- [worker/api/v1/ingest.js:9-16](../worker/api/v1/ingest.js#L9) — if
  `OLLAMA_BASE_URL` is set, new ingest jobs default their extraction provider
  to `ollama-20b` (gpt-oss:20b) instead of Gemini — the fastest-and-most-robust
  local pick per the benchmark table above.
- [worker/_shared/pipeline-registry.js](../worker/_shared/pipeline-registry.js)
  — the default extract chain is
  `["ollama-20b", "ollama-30b", "ollama-7b", "ollama-14b", "gemini", "cerebras", "groq", "mistral", "openrouter", "cloudflare"]`,
  with only `ollama-14b` disabled by default (it benchmarked strictly worse
  than `ollama-30b` on both speed and every other axis — enable it in
  pipeline config if you still want it tried).
- Four local stages now exist:
  - `ollama-7b` (qwen2.5:7b) — original small/fast baseline.
  - `ollama-20b` (gpt-oss:20b, `OLLAMA_MODEL_20B`) — **new default**; fastest
    solo and the only stage that doesn't collapse under concurrency.
  - `ollama-30b` (qwen3:30b-a3b, `OLLAMA_MODEL_30B`) — strong Qwen-family
    alternative if you want to stay in that lineage.
  - `ollama-14b` (qwen2.5:14b, `OLLAMA_MODEL_14B`) — disabled by default,
    superseded by the above.
- the inverse also holds: **if `OLLAMA_BASE_URL` is empty, all four Ollama
  stages are force-disabled.** This is a hard gate, not just a default —
  Ollama only ever runs against a local dev server, never in production,
  because `localhost:11434` isn't reachable from Cloudflare's edge.
- [worker/_shared/freemium-extract.js](../worker/_shared/freemium-extract.js)
  (`ollamaExtract`) — calls Ollama's native `/api/chat` (not the OpenAI-compat
  endpoint, so it can set `num_ctx` directly), with a 16384-token context
  window and a 20-minute timeout — local inference on CPU/consumer GPU is
  slow but has no rate limit, hence the long timeout.

### Forcing a specific provider for one ingest

`POST /api/v1/ingest` accepts a `prefer_provider` form field
([worker/api/v1/ingest.js:47](../worker/api/v1/ingest.js#L47)) — set it to
`ollama-7b`, `ollama-20b`, `ollama-30b`, `ollama-14b`, or `gemini` to override
the default chain for that one upload, without changing global config.

### Verifying it's actually being used

```bash
curl http://localhost:11434/api/tags        # confirm Ollama is up and the model is pulled
```

Then ingest a book and check the worker logs (`wrangler dev` terminal) for the
provider that ends up handling extraction. The chosen provider is also
recorded as `provider_used` on the book's extraction checkpoint
([worker/_shared/book-checkpoint.js:38](../worker/_shared/book-checkpoint.js#L38),
set in [chapter-extract-pipeline.js:219](../worker/_shared/chapter-extract-pipeline.js#L219))
— it'll say `ollama-20b` rather than `gemini` when it took this path.

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

1. `ollama serve` + `ollama pull gpt-oss:20b` (Part 1 prerequisites). Leave
   `OLLAMA_NUM_PARALLEL`/`VAE_EXTRACT_CONCURRENCY` at 1 unless you've
   benchmarked your own hardware and confirmed higher actually helps (see
   above — it didn't on Apple Silicon for most models; gpt-oss:20b was the
   one exception worth re-testing).
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
| Extraction times out around 20 minutes | Expected ceiling (`OLLAMA_TIMEOUT_MS`) — a dense 14B/32B model on CPU-only hardware on a long chapter can be genuinely slow; try `gpt-oss:20b`/`qwen2.5:7b` or chunk the book smaller (`EXTRACT_CHUNK_MAX_TOKENS`) |
| Wondering whether to raise `OLLAMA_NUM_PARALLEL`/`VAE_EXTRACT_CONCURRENCY` | Don't, without benchmarking first — on this repo's test machine it made aggregate throughput *worse* than sequential for every model except `gpt-oss:20b` (see benchmark table above) |
| `ollama-7b`/`ollama-20b`/`ollama-30b`/`ollama-14b` don't appear in the pipeline config UI | They're force-disabled whenever `OLLAMA_BASE_URL` is unset — this is intentional, not a bug |
| Bridge banner doesn't appear / API calls still hit production | Check `localStorage["vae-api-base"]` in devtools; the `?localApi=` param only applies once on load, then rewrites the URL to remove itself |
| Bridged frontend gets CORS errors in the console | Its origin isn't in `worker/_shared/cors.js`'s allow-list and isn't covered by `VAE_CORS_ORIGINS` — add it and restart `dev:worker` |
| Tunnel works but requests still fail | `cloudflared` free quick tunnels rotate URLs on restart — update `VAE_CORS_ORIGINS` and the `?localApi=` URL together each time |

## References

| Topic | File(s) |
|---|---|
| Ollama extract provider | [worker/_shared/freemium-extract.js](../worker/_shared/freemium-extract.js) (`ollamaExtract`) |
| Ollama concurrency (`OLLAMA_NUM_PARALLEL`) vs. worker concurrency (`VAE_EXTRACT_CONCURRENCY`) | `~/.zshrc` (env var, not `.env`); [SETUP.md](../SETUP.md#tweaking-parallel-chapter-extraction) |
| Provider chain / gating | [worker/_shared/pipeline-registry.js](../worker/_shared/pipeline-registry.js) |
| Default provider selection | [worker/api/v1/ingest.js](../worker/api/v1/ingest.js) |
| Env sync | [scripts/sync-dev-vars.mjs](../scripts/sync-dev-vars.mjs), [worker/.dev.vars.example](../worker/.dev.vars.example) |
| Local API bridge | [web/src/localApiBridge.js](../web/src/localApiBridge.js), [web/src/components/LocalApiBridgeBanner.jsx](../web/src/components/LocalApiBridgeBanner.jsx), [web/src/api.js](../web/src/api.js) |
| CORS | [worker/_shared/cors.js](../worker/_shared/cors.js) |
| Local image generation (same local-first spirit, different bottleneck — real batching wins/loses/crashes depending on model, not a uniform "concurrency doesn't help" story) | [docs/LOCAL_IMAGE_GEN.md](LOCAL_IMAGE_GEN.md) |
| General setup | [../SETUP.md](../SETUP.md) |
