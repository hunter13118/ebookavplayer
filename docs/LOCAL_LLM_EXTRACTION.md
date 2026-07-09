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

**Now wired in as an opt-in stage: `mlx-30b`.** Given `VAE_EXTRACT_CONCURRENCY=1`
is (still) the recommended default — solo beats parallel for every *other*
config tested — this only pays off once you've deliberately raised
`VAE_EXTRACT_CONCURRENCY` above 1. Setup:

```bash
python3 -m venv .venv-mlx && source .venv-mlx/bin/activate  # separate venv — don't mix with the repo's main one
pip install mlx-lm
mlx_lm.server --model mlx-community/Qwen3-30B-A3B-4bit --port 8081
```

```bash
# .env
MLX_BASE_URL=http://localhost:8081
```

`npm run dev:worker` picks this up via `sync-dev-vars.mjs` exactly like
`OLLAMA_BASE_URL`. This gates a new extract stage, `mlx-30b`
([worker/_shared/pipeline-registry.js](../worker/_shared/pipeline-registry.js)),
force-disabled whenever `MLX_BASE_URL` is unset — same hard-gate pattern as
the four `ollama-*` stages, purely additive and never replacing them. The
worker calls it via `mlxExtract()`
([worker/_shared/freemium-extract.js](../worker/_shared/freemium-extract.js)),
reusing the same OpenAI-compatible request shape `mlx_lm.server` exposes, with
no real API key required and the same long, no-rate-limit timeout Ollama gets.
A fourth preset, **Best for concurrent chapters (MLX, experimental)**
(`local_mlx_concurrent`, see below), leads with it.

**Note on tunneling:** running this alongside Ollama does *not* add a second
thing you need to expose to the internet. Only the worker itself
(`:8600`) ever gets a `cloudflared` tunnel (see Part 2 below) — Ollama
(`:11434`) and `mlx_lm.server` (`:8081`) are both plain localhost-only
processes the worker fans out to on your machine, invisible to whatever's on
the other end of the tunnel.

### Choosing a preset

Four named presets exist, each pinning a different local model to the front
of the extract chain (still a fallback chain, not exclusive — the others stay
available if the leader errors out). Pick one via **Settings → AI Pipeline →
Local extraction presets** in the app (drag-free — a "Use this" button applies
it), or `PATCH /pipeline` with `{"apply_local_extract_preset": "<id>"}`
directly. Definitions live in
[worker/_shared/local-extract-presets.js](../worker/_shared/local-extract-presets.js).

| Preset (`id`) | Leads with | Effectiveness (this machine) | Recommended env | Pick this when |
|---|---|---|---|---|
| **Fastest** (`local_fastest_solo`) — default | `ollama-30b` (qwen3:30b-a3b) | ~53 tok/s solo | `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_NUM_PARALLEL=1`, `VAE_EXTRACT_CONCURRENCY=1` | Almost always — you're extracting one book/chapter at a time (the default) |
| **Best for concurrent chapters** (`local_best_concurrent`) | `ollama-20b` (gpt-oss:20b) | ~44 tok/s solo, ~30 tok/s aggregate @ 8-way concurrency | same, but `VAE_EXTRACT_CONCURRENCY=4`+ | You've deliberately raised `VAE_EXTRACT_CONCURRENCY` above 1 — every other Ollama model loses 40-90% of its throughput there, this one barely does |
| **Best for concurrent chapters (MLX, experimental)** (`local_mlx_concurrent`) | `mlx-30b` (qwen3:30b-a3b via MLX) | ~18.6 tok/s solo, ~39.1 tok/s aggregate @ 8-way concurrency | `MLX_BASE_URL` set, `VAE_EXTRACT_CONCURRENCY=4`+ | Same as above, but you want the single best concurrent number measured — beats every Ollama config, at the cost of a second local server process (Apple Silicon only) |
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

### Reaching local Ollama/MLX from a *deployed* Worker (attempted 2026-07-08, blocked on this machine)

Different problem from the one above: not bridging a local *frontend* to the
deployed site, but having an actually-`wrangler deploy`d Worker (real edge,
real Queues — which would also sidestep `wrangler dev`'s local queue
simulator flaking on long-running consumers) call back to Ollama/MLX running
on a home machine. `localhost` means nothing to a Worker running on
Cloudflare's edge, so this needs a tunnel running persistently on the model
machine, with the Worker's `OLLAMA_BASE_URL`/`MLX_BASE_URL` pointed at the
tunnel hostname instead.

**What was built and still exists, unused:**
- Named Cloudflare Tunnel `vae-ollama` (id `f407cc6c-9971-4519-855a-f0a2fab67067`),
  DNS-routed to `ollama.hunterthemilkman.com` → `localhost:11434` and
  `mlx.hunterthemilkman.com` → `localhost:8081` (config at
  `~/.cloudflared/config.yml` on that machine).
- A Cloudflare Access application gating both hostnames with a Service Auth
  policy + service token (`vae-worker`).
- `cfAccessHeaders(env)` in
  [worker/_shared/freemium-extract.js](../worker/_shared/freemium-extract.js) —
  reads `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` and attaches them to
  the Ollama/MLX fetch calls. No-ops against a bare `localhost` target, so
  it's safe to leave wired in permanently.

**Why it doesn't work today:** the model machine has an always-on, per-device
VPN/MDM network policy (not optional, not network-specific — confirmed
active regardless of which Wi-Fi it's on) that sinkholes DNS lookups for
domains it doesn't recognize to a filtering appliance. This isn't narrowly
about `cloudflared`'s SRV-record edge discovery (`_v2-origintunneld._tcp.argotunnel.com`)
— a fresh `ngrok` tunnel hostname got redirected to the *exact same*
sinkhole IP, serving an unrelated TLS cert. That rules out both "it's an SRV
lookup quirk" (proven: the real SRV records resolve fine over DNS-over-HTTPS,
port 53 specifically is what's intercepted) and "it's cloudflared-specific"
(ngrok, a completely different tunnel vendor over plain HTTPS, hit the same
wall). Docker Desktop wasn't installed to test whether a separate VM network
namespace escapes it — worth trying first on a future attempt, though if the
interception happens at the network/router boundary rather than purely via
the OS resolver config, it likely wouldn't help either.

**Revisit this from a different machine** — one without that device policy.
Everything above (tunnel, DNS, Access app, service token, the
`cfAccessHeaders` code) is ready to use as-is; only the tunnel *connector*
needs to run somewhere else. `cloudflared tunnel run vae-ollama` on that
machine (using the same `~/.cloudflared/` credentials, or re-authenticate
fresh) plus setting `OLLAMA_BASE_URL`/`MLX_BASE_URL` as deployed-Worker
secrets to the tunnel hostnames is the whole remaining task.

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

## Chunk size vs. progress granularity vs. scene continuity

`EXTRACT_CHUNK_MAX_TOKENS` (default 2000, see `.env.example`) controls how
much text goes into each extract round-trip. Smaller means more, faster
round-trips per chapter — more frequent `chunk N/M` progress ticks instead of
one slow local-model call sitting silent for many minutes. This is the knob
to reach for if a local model (30B/dense especially) goes quiet for a long
stretch with no feedback.

`OLLAMA_NUM_CTX` (see `.env.example`) auto-scales with this — 8x the chunk
budget, floored at 4096 — instead of a fixed 16384 sized for the old
2000-token default. A smaller chunk budget means the real prompt (system +
rules + chunk + known-characters) needs far less context than 16384 gave it
room for, and a smaller context window is less KV-cache for Ollama to
compute attention over on every generation step — real, measurable overhead
independent of which model is doing the generating. Override it directly if
the computed value turns out wrong for a specific book (a very long known-
characters list deep into a dense book is the main way it could need more
room than the default ratio assumes).

Two things this does *not* cost you:

- **Character continuity** — `extractChapterRaw`'s known-character list is
  threaded into every chunk's prompt regardless of chunk count, unrelated to
  chunk size.
- **Scene continuity** — chunk boundaries land wherever the token budget
  runs out, which can be mid-scene. The model flags this itself: if its last
  scene is cut off mid-action (not a real scene end), it sets
  `scene_continues: true` on it. The next chunk's prompt gets an "OPEN SCENE
  FROM PREVIOUS CHUNK" note (`formatOpenScene` in freemium-extract.js) naming
  that exact scene id, location, and present characters, instructing the
  model to continue the same scene id rather than starting a new one.
  `mergeChapterScenes` then stitches matching ids back into one scene
  (concatenated lines, unioned present-characters) instead of leaving two
  partial scene entries. See the SCENE_CONTINUES rule in
  [worker/_shared/dialogue-rules.js](../worker/_shared/dialogue-rules.js) and
  [tests/scene-continuity.test.mjs](../tests/scene-continuity.test.mjs).

  This is best-effort, not a guarantee — it depends on the model actually
  setting the flag and reusing the id as instructed. If it doesn't (weaker
  models are more likely to miss it), `mergeChapterScenes` falls back to
  today's plain concatenation for that scene — additive, never worse than
  the pre-existing behavior. Smaller chunks still raise how often a scene
  boundary gets hit at all, just not how gracefully it's handled when it
  does.

## Also worth knowing: hybrid-reasoning models and `think`

Qwen3 (and other hybrid-reasoning models — check a model's capabilities via
`curl localhost:11434/api/show -d '{"model":"..."}'`) generate a hidden
chain-of-thought before their actual answer unless told not to. That
reasoning is pure overhead for a structured-extraction task — we only want
the JSON — and its length doesn't scale down with a smaller
`EXTRACT_CHUNK_MAX_TOKENS`; a single chunk was observed sitting 3+ minutes
even at 800 input tokens. `ollamaExtract` in freemium-extract.js sends
`think: false` on every request unconditionally — Ollama ignores it
harmlessly for models that don't support hybrid reasoning, so this is safe
across the board. If a local extraction still seems to sit far longer than
expected on one chunk after this, check for an active TCP connection to
Ollama (`lsof -nP -iTCP:11434 | grep ESTABLISHED`) and `ollama ps` showing
the model actively loaded — if both are true, it's genuinely working, just
slow on that particular chunk, not stuck.

## Parallel per-chapter imaging

`VAE_PARALLEL_IMAGING=true` (off by default) generates art for a chapter's
new characters/scenes on a separate queue (`vae-imaging`, its own producer/
consumer binding in `worker/wrangler.toml`) as soon as that chapter is
checkpointed — instead of the default sequential pipeline, which extracts
*every* chapter first and only then runs one whole-book imaging phase at the
very end.

**Why a separate queue, not just calling it inline:** the existing
`pack-build` job shares the same physical queue as ingest/continue-extract
(`vae-jobs`), and that's exactly why offline-pack-caching gets stuck queued
behind a long-running extraction (see the Troubleshooting section above and
`SETUP.md`'s "stuck showing Processing" row). A genuinely separate queue
resource is what lets Cloudflare Queues run the two consumers concurrently
instead of one blocking the other.

**Why chapter packs, not the merged `books/{id}.json` playback:** the
extraction loop rewrites `books/{id}.json` wholesale from its own in-memory
scene list on *every* chapter completion, so anything written there by a
concurrently-running imaging consumer would just get clobbered on the next
chapter's completion. Each chapter's own pack
(`books/{id}/chapters/{pos}.json`) has no concurrent writer once its
initial `putChapterPack` call has happened, so `chapter-imaging-consumer.js`
writes generated sprite/background URLs there instead — no read-modify-write
race to reason about.

**How the two ends meet:** the whole-book finalization phase (still runs
after every chapter's *text* is done, per-chapter imaging or not) calls
`existingMediaFromChapterPacks` first, aggregating whatever's already sitting
in every chapter's pack, and passes that in as `runEdgeImaging`'s
`existingMedia` — so anything already generated in parallel gets reused
rather than regenerated. If per-chapter imaging finished everything already,
this final phase has little or nothing left to do. If `VAE_PARALLEL_IMAGING`
is off, an enqueue failed, or the local dev queue simulator never gave
`vae-imaging` a turn, this degrades to exactly today's sequential behavior —
nothing is lost either way.

Character consistency risk: same as any other art-generation timing —
generating a character's reference art the moment they first appear (rather
than waiting for the whole book) means a later chapter's fuller
characterization can't retroactively inform that first image. This is an
accepted trade-off, not a regression — the existing regenerate-art workflow
(`ArtStyleSwitcher`, `imaging-regen` jobs) is the way to fix a specific
character's look after the fact, same as it already was before this feature
existed.

See `tests/chapter-imaging.test.mjs` and
[worker/queue/chapter-imaging-consumer.js](../worker/queue/chapter-imaging-consumer.js).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Ingest still uses Gemini even with `OLLAMA_BASE_URL` set | `.env` edited but `worker/.dev.vars` is stale — restart `npm run dev:worker` so `sync-dev-vars.mjs` reruns; don't hand-edit `worker/.dev.vars` |
| Extraction times out around 20 minutes | Expected ceiling (`OLLAMA_TIMEOUT_MS`) — a dense 14B/32B model on CPU-only hardware on a long chapter can be genuinely slow; try `gpt-oss:20b`/`qwen2.5:7b` or chunk the book smaller (`EXTRACT_CHUNK_MAX_TOKENS`) |
| A chunk sits with no visible progress for many minutes (30B/dense models especially) — not timed out, just silent | Expected: one chunk = one round-trip, and local generation on a big model can genuinely take a long time with zero incremental feedback mid-request. Lower `EXTRACT_CHUNK_MAX_TOKENS` (try 600-1000) for more, smaller, faster round-trips per chapter — same `chunk N/M` progress display, just ticking more often. Character continuity across chunks is unaffected either way. Scene continuity across the chunk boundary itself is also handled now (see below) — if it's actually stuck (no live TCP connection to Ollama, `ollama ps` idle), cancel it from the Library — see [SETUP.md](../SETUP.md)'s "stuck showing Processing" row |
| Wondering whether to raise `OLLAMA_NUM_PARALLEL`/`VAE_EXTRACT_CONCURRENCY` | Don't, without benchmarking first — on this repo's test machine it made aggregate throughput *worse* than sequential for every model except `gpt-oss:20b` (see benchmark table above) |
| A hybrid-reasoning model (qwen3, gpt-oss) still "feels" slower per-chunk than a plain dense model with lower peak tok/s | Likely genuine — `think: false` disables the visible reasoning chain, but a reasoning-tuned model's real generation may still run longer per token of actual output than a model with no reasoning capability at all (check via `/api/show`'s `capabilities` list). If quality allows it for your book, a same-family dense model with zero `thinking` capability (e.g. `qwen2.5:14b` — bigger than `qwen2.5:7b`, same non-reasoning family) is a real fix, not just a workaround |
| Resuming with a different `prefer_provider` than last time keeps using the old one | Fixed 2026-07-08 — `checkpoint.provider_used` used to always win over an explicit `prefer_provider` on `continue-extract`. Now an explicit request on the call overrides it; only a plain "just resume" (no `prefer_provider`) falls back to the checkpoint. See `resolveResumeProvider` in chapter-extract-pipeline.js and `tests/resume-provider.test.mjs` |
| `ollama-7b`/`ollama-20b`/`ollama-30b`/`ollama-14b` don't appear in the pipeline config UI | They're force-disabled whenever `OLLAMA_BASE_URL` is unset — this is intentional, not a bug |
| Extraction stalls on one chapter with `freemium_extract: all providers failed (3) — Expected ',' or '}' after property value` or `Expected ',' or ']' after array element` in JSON at position N | Three possible causes, all read as the same class of JSON.parse error: (1) the model emitted a literal, unescaped `"` inside a string value (nested quotation marks are the usual trigger), (2) it simply forgot a comma between two properties/array elements, or (3) — confirmed the most common cause by directly reproducing against the live model with a real stalled chunk — **the response was truncated**: generation ran out of context/tokens mid-structure and just stops, with no misplaced character anywhere (the giveaway: JSON.parse's error position lands exactly at the end of the string, e.g. `position 8890` on an 8890-char response). This is genuinely non-deterministic even at `temperature: 0.2` (re-running the identical prompt against the identical chunk on `qwen3:30b-a3b` sometimes parses cleanly, sometimes doesn't — MoE routing/batching isn't bit-for-bit reproducible), so a pinned local provider's 3 retries can still all fail, or all pass, depending on luck. `parseModelJson` (freemium-extract.js) repairs all three: `escapeStrayQuotes` fixes the stray-quote case, an iterative `insertCommaAtPosition` pass (using the exact offset JSON.parse names, and refusing to fire at end-of-string so it doesn't misfire on a truncation) fixes a genuinely-missing separator, and `closeTruncatedJson` closes whatever brackets/strings were still open when generation stopped — dropping a dangling, cut-off-mid-value final field rather than guessing its content, so the chunk still comes back usable minus that one item. When any of these kick in, a `console.warn` logs the repaired snippet plus a preview of the neighboring chunks' source text so you can manually confirm they extracted cleanly too. See `tests/parse-model-json-repair.test.mjs`. If the warning never appears and the stall persists, it's a genuinely unrecoverable response (e.g. no JSON structure at all) — check the worker log for the exact parse error |
| A finished book (all chapters extracted, imaging under way) suddenly shows `status: "error"` / "Cancelled before any chapters finished" in the Library, even though the cover art and chapters clearly exist | Fixed 2026-07-09 — `worker/queue/imaging-regen-consumer.js`'s first `touchBook()` call (setting `imaging_locked`/`stage`) fired *before* the real book index was loaded from KV, so its `prev` hint was still the function's empty initial `{}`. Since `putBookIndex` skips its own KV read whenever a `prev` hint is passed, that first call overwrote the persisted index — silently dropping `chapters_ready`/`total_chapters`/`title`/`cover`/etc down to just the 4 fields in that patch. A later unrelated `cancel-processing` call then read `chapters_ready: 0` and wrote a harsh "nothing finished" error, even though extraction was fully done. The book's actual data (`books/{id}.json`, `.analysis.json`, chapter packs, generated media) was never touched — only the KV index entry used for the Library listing. Recovery for an already-corrupted index: re-derive the correct values from `books/{id}.json` (scene/line counts, cover) and the real chapter-pack count in R2, then `wrangler kv key put --binding VAE_JOBS --local "book:{id}"` with a corrected JSON blob — no need to re-extract or re-image anything already done. |
| Backgrounds/sprites never populate on a book stuck "processing" imaging (still showing gradient placeholders however long you wait), and/or chapter titles never show up in the chapter dropdown even after re-extracting | Fixed 2026-07-09 — four layered bugs found while debugging a real stuck book (My Quiet Blacksmith Life, Vol. 6), each masking the next until fixed in order: (1) the KV index-wipe bug above; (2) `compile-playback.js` trusted the model's self-reported `scene.id` — the model frequently reproduces the extraction schema's example id ("scene-0001") literally instead of incrementing it, sometimes for 20+ consecutive scenes within one chapter, so 133 real scenes compiled down to as few as 32 unique ids and image generation/lookup collided onto the same few keys; (3) `chapter-extract-pipeline.js`'s finalize step wrote `chapters` onto the hand-built `playback` object but never onto `analysis` — harmless until the *first* imaging run, which rebuilds playback from analysis via `compilePlayback`'s `chapters: analysis.chapters || []`, silently dropping every chapter title; (4) the same scene.id-trust bug as (2), independently, in `edge-imaging.js`'s background-generation loop — fixing (2) alone wasn't enough, because the function that actually *drives* image generation reads straight from `analysis.scenes[].id`, not from the already-compiled playback. All four fixed to always trust positional index (`scene-${i+1}`) over the model's own id. A 5th non-bug pitfall hit while recovering: queues have no cancel primitive (documented on `onCancelProcessingPost`) — an old *staged-comparison* imaging job left running from before the fix kept retrying and growing its Durable Object comparisons log past SQLite's blob size limit, throwing continuously and starving the new, correctly-behaving job of execution time; a full `wrangler dev` restart was required to actually kill it (`imaging/unlock` only resets a KV flag, it doesn't stop a running consumer invocation). Recovering an already-corrupted book (like this one) without a full re-extraction: re-derive `chapters` from `extractEpubText` on the stored EPUB (cheap, no LLM call), recompile `analysis.json`/`playback.json` with the fixed `compilePlayback`, write both back via `wrangler r2 object put <bucket>/<key> --local --file <path>`, then re-run imaging. Separate, lower-priority issue noticed during this recovery, not yet fixed: `buildChaptersFromSpine` (`epub-text.js`) sometimes misclassifies a front-matter/color-plate spine page as a real chapter, producing a bogus chapter entry whose title is literally the book's own title — cosmetic (extra junk entries in the chapter list), not blocking. |
| Bridge banner doesn't appear / API calls still hit production | Check `localStorage["vae-api-base"]` in devtools; the `?localApi=` param only applies once on load, then rewrites the URL to remove itself |
| Bridged frontend gets CORS errors in the console | Its origin isn't in `worker/_shared/cors.js`'s allow-list and isn't covered by `VAE_CORS_ORIGINS` — add it and restart `dev:worker` |
| Tunnel works but requests still fail | `cloudflared` free quick tunnels rotate URLs on restart — update `VAE_CORS_ORIGINS` and the `?localApi=` URL together each time |

## References

| Topic | File(s) |
|---|---|
| Ollama extract provider | [worker/_shared/freemium-extract.js](../worker/_shared/freemium-extract.js) (`ollamaExtract`) |
| MLX extract provider (experimental, Apple Silicon only) | [worker/_shared/freemium-extract.js](../worker/_shared/freemium-extract.js) (`mlxExtract`) |
| Ollama concurrency (`OLLAMA_NUM_PARALLEL`) vs. worker concurrency (`VAE_EXTRACT_CONCURRENCY`) | `~/.zshrc` (env var, not `.env`); [SETUP.md](../SETUP.md#tweaking-parallel-chapter-extraction) |
| Provider chain / gating | [worker/_shared/pipeline-registry.js](../worker/_shared/pipeline-registry.js) |
| Default provider selection | [worker/api/v1/ingest.js](../worker/api/v1/ingest.js) |
| Env sync | [scripts/sync-dev-vars.mjs](../scripts/sync-dev-vars.mjs), [worker/.dev.vars.example](../worker/.dev.vars.example) |
| Local API bridge | [web/src/localApiBridge.js](../web/src/localApiBridge.js), [web/src/components/LocalApiBridgeBanner.jsx](../web/src/components/LocalApiBridgeBanner.jsx), [web/src/api.js](../web/src/api.js) |
| CORS | [worker/_shared/cors.js](../worker/_shared/cors.js) |
| Scene continuity across chunk boundaries | [worker/_shared/freemium-extract.js](../worker/_shared/freemium-extract.js) (`mergeChapterScenes`, `formatOpenScene`), [worker/_shared/dialogue-rules.js](../worker/_shared/dialogue-rules.js) (SCENE_CONTINUES rule) |
| Stray-quote JSON repair (recovers a model response broken by an unescaped `"` in a string value) | [worker/_shared/freemium-extract.js](../worker/_shared/freemium-extract.js) (`parseModelJson`, `escapeStrayQuotes`, `fromModelContent`), [tests/parse-model-json-repair.test.mjs](../tests/parse-model-json-repair.test.mjs) |
| Parallel per-chapter imaging (`VAE_PARALLEL_IMAGING`) | [worker/queue/chapter-imaging-consumer.js](../worker/queue/chapter-imaging-consumer.js), [worker/_shared/edge-imaging.js](../worker/_shared/edge-imaging.js) (`existingMediaFromChapterPacks`), [worker/wrangler.toml](../worker/wrangler.toml) (`vae-imaging` queue) |
| Local image generation (same local-first spirit, different bottleneck — real batching wins/loses/crashes depending on model, not a uniform "concurrency doesn't help" story) | [docs/LOCAL_IMAGE_GEN.md](LOCAL_IMAGE_GEN.md) |
| General setup | [../SETUP.md](../SETUP.md) |
