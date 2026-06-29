# Cloudflare deploy — VAE on MilkMan Portfolio

Edge backend for **long LLM work** without Fly: Workers + Queue + R2 + KV.

## Architecture

```text
Browser (PWA at /projects/ebookavplayer/)
  ├─ IndexedDB offline packs (import .vaepack — no server)
  └─ /projects/ebookavplayer/api/*  →  Portfolio Worker
         ├─ POST /ingest           → R2 + KV + Queue (instant) → Gemini in consumer
         ├─ GET  /ingest/:id       → KV job status (poll)
         ├─ GET  /books, /books/:id → R2 catalog + playback JSON
         ├─ POST pack/build        → Queue → FastAPI webhook (optional)
         ├─ GET  pack file         → R2 fast path
         └─ fallback               → VAE_API_ORIGIN (optional Fly/home)
```

**Mental model:** HTTP never waits for Gemini. Queue consumer runs 60–120s; client polls.

See [CLOUDFLARE_BACKEND.md](../ebookavplayer/docs/CLOUDFLARE_BACKEND.md) in the ebookavplayer repo.

## One-time setup

Your `CLOUDFLARE_API_TOKEN` must include **Workers Scripts, R2, KV, Queues** (or unset it and use `wrangler login` OAuth).

```bash
cd milkman-webapp-portfolio

# Creates R2 vae-packs, queue vae-jobs, KV VAE_JOBS, patches wrangler.toml
npm run cf:setup-vae

# GEMINI (if not in env)
npx wrangler secret put GEMINI_API_KEY

# Optional FastAPI fallback while edge port is incomplete
npx wrangler secret put VAE_API_ORIGIN
npx wrangler secret put QUEUE_WEBHOOK_SECRET
```

## Build & deploy

```bash
npm run build          # needs CloudPilot frontend deps if CloudPilot changed
npm run cf:deploy      # or: npm run cf:deploy-vae (setup + deploy)
```

Verify:

```bash
curl https://hunterthemilkman.com/projects/ebookavplayer/api/health
# expect: {"ok":true,"edge_ingest":true,"r2":true,"kv":true,"jobs_queue":true,"gemini":true,...}
```

Smoke test ingest (small EPUB):

```bash
curl -F "file=@book.epub" -F "dry_run=true" \
  https://hunterthemilkman.com/projects/ebookavplayer/api/ingest
# → {"job_id":"...","status":"queued"}
curl https://hunterthemilkman.com/projects/ebookavplayer/api/ingest/JOB_ID
# poll until status: "done"
```

## FastAPI (optional)

Not required for **edge ingest** or **offline import**. Still useful for full imaging/TTS until Phases 3–4 land.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `/api/health` returns HTML | Worker not deployed or route missing — redeploy `wrangler deploy` |
| `Authentication error [10000]` on deploy | API token lacks R2/KV — `wrangler login` or expand token |
| `edge_ingest: false` | Create KV/queue/R2; paste KV id in `wrangler.toml` |
| Ingest stuck `queued` | Queue consumer not bound — check `[[queues.consumers]]` in wrangler.toml |
| `GEMINI_API_KEY not configured` | `wrangler secret put GEMINI_API_KEY` |
| Ingest `error` with Gemini 429 | Google AI Studio credits depleted — add billing or a fresh API key |
| 503 on non-ingest routes | Set `VAE_API_ORIGIN` or wait for edge port |

Optional FastAPI R2 mirror (same bucket as Worker):

```env
R2_ACCOUNT_ID=c41c7b1bb8131ac32f61a61253b928bd
R2_ENDPOINT=https://c41c7b1bb8131ac32f61a61253b928bd.r2.cloudflarestorage.com
R2_BUCKET=vae-packs
# R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY from R2 dashboard → Manage API tokens
```

See also: [WORKERS_AI.md](../ebookavplayer/docs/WORKERS_AI.md), [FLY_DEPLOY.md](../ebookavplayer/docs/FLY_DEPLOY.md).
