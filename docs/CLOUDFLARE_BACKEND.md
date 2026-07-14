# Cloudflare as your backend (without Fly)

> **Historical.** This is the pre-port planning doc for moving off FastAPI
> onto Cloudflare Workers. That migration is complete — every phase listed
> below shipped, including "drop `VAE_API_ORIGIN`/Fly entirely," which has
> now happened: the origin-proxy fallback has been removed from `worker/`
> entirely, and the original FastAPI backend is archived at
> `legacy/server/`. Kept for historical record of the migration reasoning;
> see [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) for the current architecture.

Your expectation was right: **Cloudflare Pages static hosting ≠ a backend.**  
But **Cloudflare Workers** *are* a backend — free tier included — with a different shape than FastAPI.

The ~10s limit applies to **one HTTP request waiting for work to finish**.  
Your dreams aren’t screwed; you need **async + storage**, which Cloudflare already supports.

## The mental model fix

```text
WRONG:  "Upload EPUB → Worker waits 90s for Gemini → return JSON"
        ↑ hits wall-clock / CPU limits

RIGHT:  "Upload EPUB → Worker returns { job_id } in 200ms
         → Queue / waitUntil runs Gemini (60–120s is fine)
         → Client polls GET /ingest/{job_id}
         → Result in R2 + KV"
```

**You already built this pattern in FastAPI** (`POST /ingest` + thread + poll).  
The port is: same UX, Worker + Queue + R2 instead of uvicorn + disk.

## Three Cloudflare tools for long LLM work

| Pattern | When to use | VAE example |
|---------|-------------|-------------|
| **Return immediately + poll** | Job takes minutes; client already polls | **Ingest** (extract), **pack build** |
| **Queue consumer** | Heavy work after response; 15 min wall clock on consumer | Gemini mega-pass, TTS batch |
| **Streaming pipe** | Token stream; connection stays alive while bytes flow | Live status text, future chat UI |
| **R2 + KV** | Files + job state | EPUB upload, analysis JSON, `.vaepack` |

Streaming is great when the **client consumes tokens live**.  
Your mega-pass needs **one big JSON blob** → **poll + Queue** is the right fit (not streaming).

`waitUntil()` helps for quick follow-up work after a response; for multi-minute jobs prefer **Queues**.

## Architecture (target)

```text
Browser  →  /projects/ebookavplayer/api/*
              │
              ├─ POST /ingest          → R2 (epub) + KV (job) + Queue  [instant]
              ├─ GET  /ingest/:id      → KV job status                  [instant]
              ├─ GET  /books           → KV/R2 catalog                  [instant]
              ├─ GET  /books/:id       → R2 compiled playback           [instant]
              ├─ POST /pack/build      → Queue (TTS…)                   [instant]
              ├─ POST /tts             → Edge TTS proxy (short)         [~1–3s]
              └─ (fallback) proxy      → VAE_API_ORIGIN if set          [optional Fly/home]
```

**No Fly required** for the core loop once ported.

## What runs where (phased)

| Phase | Status | Work |
|-------|--------|------|
| **0** | Done | UI on CF Pages; offline packs in IndexedDB |
| **1** | **Started in repo** | Ingest on Queue + Gemini on Worker; poll `/ingest` |
| **2** | Next | `GET /books`, compile playback on edge; catalog in KV |
| **3** | Next | Image gen via Workers AI FLUX in queue (freemium chain) |
| **4** | Next | Pack build + Edge TTS in queue (or Workers AI TTS) |
| **5** | Optional | Drop `VAE_API_ORIGIN` / Fly entirely |

## Cost (personal use)

| Service | Typical cost |
|---------|----------------|
| Workers requests | 100k/day free |
| KV | Free tier generous for job status |
| R2 | ~$0.015/GB-month; egress often free to Worker |
| Queues | Free tier includes ops |
| Gemini | Google AI Studio free tier (separate from CF) |
| Workers AI | 10k neurons/day (images; not main extract) |

**Cheaper than Fly** for “backend catches long LLM responses.”

## Secrets (portfolio Worker)

```bash
wrangler secret put GEMINI_API_KEY
wrangler secret put CLERK_JWKS_URL   # already have for portfolio
# VAE_API_ORIGIN — optional fallback only
```

Create infrastructure:

```bash
wrangler r2 bucket create vae-packs
wrangler queues create vae-jobs          # unified job queue
wrangler kv namespace create VAE_JOBS
```

Update `wrangler.toml` queue name to `vae-jobs` when you cut over.

## How ingest works on the edge (implemented)

1. `POST /projects/ebookavplayer/api/ingest` — multipart EPUB  
   - Stores file in R2 `uploads/{job_id}.epub`  
   - Writes `ingest:{job_id}` to KV (`status: queued`)  
   - Sends `{ kind: "ingest", job_id, book_id, generate_art, … }` to queue  
   - Returns `{ job_id, book_id, status: "queued" }` immediately  

2. Queue consumer (phased, freemium — no Gemini by default):

| Phase | Code | What |
|-------|------|------|
| **P1_PARSE** | `epub-text.js` | EPUB → plain text |
| **P2_EXTRACT** | `freemium-extract.js` | cerebras → groq → mistral → openrouter → cloudflare |
| **P3_IMAGES** | `freemium-image.js` | FLUX/pollinations/HF sprites + backgrounds → R2 `/media/…` |
| **P4_PACK** | `pack-build-edge.js` | ZIP `.vaepack` (visual or audiobook + Edge TTS) |

3. Client polls `GET /ingest/{job_id}` — response includes `debug_log` array when `VAE_DEBUG=true`.

4. Pack download: `POST /books/{id}/pack/build` → queue → **P4** on edge → poll → `GET …/file`.

### Pipeline UI (edge + local)

`GET/PATCH /projects/ebookavplayer/api/pipeline` persists to KV (`pipeline:config`).
Drag order and enable/disable in the **AI pipeline** sheet applies to the next ingest/image job on edge.

Default freemium image order (Workers AI **last**):

```text
pollinations-anon → pollinations-seed → huggingface → cloudflare
```

Default extract on edge has **Gemini disabled** until you enable it in the pipeline sheet (`EXTRACT_SKIP_GEMINI` seeds that default).

### Cost-efficient configuration (recommended)

Personal-use defaults that minimize quota burn while keeping quality acceptable:

| Layer | Recommended | Why |
|-------|-------------|-----|
| **Extract** | Cerebras → Groq → Mistral → OpenRouter → Workers AI; **Gemini off** | Cerebras ~1M tokens/day; Groq ~100k burst; Workers AI shares neurons with FLUX |
| **Images** | Pollinations → HF → Workers AI FLUX; **Gemini Image off** | Free image APIs first; ~10k neurons/day for FLUX fallback only |
| **Attribution** | `VAE_ATTR_LLM=true`, batch `5`, max `8` scenes | Only ambiguous multi-speaker scenes; ~0–2 batched LLM calls/book |

Wrangler vars (portfolio `wrangler.toml`):

```toml
EXTRACT_SKIP_GEMINI = "true"
VAE_ATTR_LLM = "true"
VAE_ATTR_LLM_MAX_SCENES = "8"
VAE_ATTR_LLM_BATCH = "5"
```

**Pipeline UI:** open **AI pipeline** from the library menu — shows a cost guide, live tips, and **Apply recommended preset** (persists to KV).

**Health:** `GET …/api/health` includes `attr_llm`, `cost_efficient`, and `cost_guide.tips`.

- **Poll responses:** `debug_log: [{ ts, phase, msg, data? }]` on ingest + pack jobs  
- **Worker logs:** `wrangler tail` — lines prefixed `[VAE:ingest]` / `[VAE:pack]`  
- **Health:** `GET …/api/health` → `phases`, `freemium_keys`, `debug: true`  
- **Tunables** (optional wrangler `[vars]`, for testing only):  
  - `VAE_IMAGING_MAX_CHARS` / `VAE_IMAGING_MAX_BGS` — only if set to a **positive** number (no cap by default)  
  - `VAE_PACK_TTS_MAX_LINES` (default 0 = all lines; set e.g. 30 to cap audiobook TTS during testing)

If `VAE_INGEST_EDGE` is not ready or queue missing, routes **fall back** to `VAE_API_ORIGIN` proxy (FastAPI).

## Streaming (when you want it later)

For **progress text** during extract (not required for MVP):

```javascript
// Worker pipes Gemini stream to client (SSE)
const upstream = await fetch(geminiStreamUrl, { body: … });
return new Response(upstream.body, {
  headers: { "content-type": "text/event-stream" },
});
```

Wall clock can exceed 10s **while bytes flow**. Final JSON validation still happens at end or in the consumer.

## Bottom line

- CF **does** host backends — **Workers**, not Pages alone.  
- You don’t need the HTTP handler to wait for Gemini.  
- **Poll + Queue** is the standard pattern; your FastAPI already proved it.  
- Fly was a shortcut for “run Python unchanged”; the **cheap** path is edge port + R2.  
- Your project is **not** dead — you’re one architecture shift away.

See also: [CLOUDFLARE_DEPLOY.md](./CLOUDFLARE_DEPLOY.md), [WORKERS_AI.md](./WORKERS_AI.md).
