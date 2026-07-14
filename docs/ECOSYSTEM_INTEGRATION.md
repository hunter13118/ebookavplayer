# Ecosystem integration plan (revised, multi-app)

Status: **exploratory**. Supersedes the scope of `AUDIOBOOK_INTEGRATION.md` (which
stays as the deep-dive on the audiobook/playback spine). This doc widens the lens
to Hunter's whole toolkit after surveying the client-level projects, and shows how
each plugs into the reading/audio core.

## The toolkit (surveyed Jun 2026)

| App | Path | What it is | Stack |
|---|---|---|---|
| **EbookAVPlayer** | `D:\EbookAVPlayer` | Visual audiobook engine (this app) | Cloudflare Workers + React/Vite (original FastAPI backend archived at `legacy/server/`, not deployed, no test coverage) |
| **Gyōkan** | `…\Projects\Gyōkan` | JP⇄EN parallel reader | FastAPI + React PWA |
| **VoxNovel** (Milkman Audiobook Generator) | `D:\personal webapp portfolio` | Ebook→audiobook: BookNLP + XTTS v2 + M4B | Flask + CUDA |
| **Copilot Sonar** | `D:\copilot-tts` | Edge Neural TTS bridge for Copilot chat (streaming, earcons) | VS Code ext (TS) |
| **War Council** | `D:\war-council` | Local Ollama multi-model orchestration + MCP + dashboard | Node + Ollama |
| **Context Fabric** | `D:\Context Fabric` | Permission-aware cross-app context graph + MCP | TS + Fastify |
| **CloudPilot** | `D:\CloudPilot` | Gemini visual-to-cloud (Terraform), 2M ctx, multimodal | React + GCP |
| **GradeTheGrader** | `D:\grade-the-grader` | 4-judge Gemini-Flash rubric evaluator | React/Vite |
| **SpecterBoard** | `D:\specterboard` | "Ghost" personal performance leaderboard | React/Vite |
| **MilkMan Portfolio** | `D:\milkman-portfolio` | Portfolio that embeds the above as showcases | React/Vite + CF Workers |

## How they relate — three layers

**1. Reading/Audio core** (the product surface)
EbookAVPlayer + Gyōkan are the two readers. VoxNovel is the audio foundry.
Copilot Sonar is the *ancestor* of the Edge-TTS code both readers already run.

**2. Intelligence + quality** (how content gets made and checked)
Gemini (cloud) does extraction + image gen today. **War Council** is the local
fallback/verifier. **GradeTheGrader** is the eval harness for extraction quality.

**3. Substrate + shell** (how it's connected and presented)
**Context Fabric** is a candidate shared-context/memory layer. **MilkMan
Portfolio** is the embedding shell and already proves two real MFE patterns.
**CloudPilot** is the Gemini-infra + deploy showcase.

## Shared contracts (the seams that make this an ecosystem, not 10 islands)

- **The script** — `BookAnalysis`/playback lines keyed by `line idx`. The join
  key across EbookAVPlayer ↔ VoxNovel ↔ Gyōkan. (See `AUDIOBOOK_INTEGRATION.md`.)
- **Edge-TTS server pattern** — `POST /tts {text, voice} → audio/mpeg`. Born in
  **Copilot Sonar**, copied into Gyōkan and EbookAVPlayer. One canonical module.
- **Timing manifest** — `line idx → {start_ms, end_ms}` over an M4B. The bridge
  between VoxNovel's output and Mode-B playback. **VoxNovel doesn't emit this yet.**
- **MCP tools** — both War Council and Context Fabric expose MCP. A reader could
  call them as tools (local analysis; shared context) rather than bespoke HTTP.
- **Embedding** — MilkMan Portfolio's build-time-SPA-at-subpath pattern is the
  reusable way to host one app inside another.

---

## Per-app: capability → concrete integration surface → role

### VoxNovel — the audio foundry (highest-value integration)
Real API (Flask, found in `backend/voxnovel_api.py`): `/api/upload`,
`/api/process/extract` (BookNLP → `quotes.csv`/`non_quotes.csv`/`sentences.csv`,
fields `{Text, Speaker, Start Location}`), `/api/voices` (GET list, POST upload
custom WAV/MP3 → `backend/tortoise/voices/{id}/sample.wav` + `embedding.pt`),
`/api/generate` (body `voice_assignments: {character → voice_id}`),
`/api/jobs/{id}`, `/api/clips`, `/api/audio/combine` (FFmpeg concat → M4B),
`/api/download/{file}`.

**What's already aligned with our hybrid:** per-character voice assignment, custom
voice upload, per-sentence synthesis (so durations exist), M4B output.

**The three gaps to close** (≈4–6h of VoxNovel backend work, per survey):
1. **No `generate-from-script` entry** — `/api/generate` re-runs BookNLP from
   uploaded text. We need a path that accepts *our* script (line ids + text +
   speaker + voice_id) and skips re-extraction. New `POST /api/generate-from-script`.
2. **No timing manifest** — clips are `clip_NNNN.wav` by index; durations are
   computed at synth time then discarded. Persist `clips.json`
   (`{clip_index, line_id, text, duration_ms}`) and have `/api/audio/combine`
   emit `timing.json` (`line_id → {start_ms, end_ms}`) by accumulating durations.
3. **No M4B chapter markers** — FFmpeg concat adds none. Add scene chapters via a
   metadata pass (ffmpeg `-map_metadata`/`mp4box`) at combine time.

Closing these = the P2 of the audiobook plan, now grounded in the real codebase.
Role: **synthesis half of the hybrid.** EbookAVPlayer extracts → VoxNovel
synthesizes → returns M4B + `timing.json` keyed by our `line idx`.

### Copilot Sonar — the Edge-TTS lineage
The streaming Edge Neural TTS WebSocket bridge (earcons, adaptive backpressure,
voice picker). Our readers' `/tts` modules descend from this "Copilot TTS pattern."
Role: **canonical TTS reference** — consolidate the one Edge-TTS module here and
have both readers + Sonar share it. Its earcon/backpressure ideas are also nice
upgrades for live Mode-A playback (e.g., subtle scene-transition earcons).

### War Council — local extraction fallback + verifier
Ollama multi-model orchestration, MCP server with ~40 tools (`consult_specialist`,
`consult_reasoning`, `council_debate`, `tournament_vote`, `smart_route`), HNSW
memory-engine RAG, cloud failover. No real TTS (just Web-Audio SFX).
Role: **offline/private extraction path.** When you don't want to spend Gemini
quota (or want privacy), route the mega-pass to War Council via MCP:
`council_deliberate` for line attribution, `tournament_vote` to pick the best of
N segmentations. Same `BookAnalysis` output contract; the reader's `analyze_book`
gains a second backend behind the existing interface.

**Future enhancement (not built):** today each app in this ecosystem that
wants local/offline LLM access stands up its own thing — ebookavplayer has
its own direct Ollama client ([worker/_shared/freemium-extract.js](../worker/_shared/freemium-extract.js)'s
`ollamaExtract`, see [LOCAL_LLM_EXTRACTION.md](LOCAL_LLM_EXTRACTION.md)) and
its own local SDXL image server ([scripts/local-image-server](../scripts/local-image-server)),
independent of War Council entirely. A cleaner long-term shape: **route all
of an app's local-LLM needs (text extraction, image gen, whatever comes
next) through War Council's MCP surface** instead of each app reimplementing
its own local-model plumbing — War Council already does multi-model
orchestration, failover, and RAG; reinventing a thinner slice of that per-app
is duplicated effort. Deliberately not done yet: the direct-Ollama and
direct-SDXL paths above were built standalone specifically to avoid a
War Council dependency while iterating quickly on this repo alone. Revisit
once the local-LLM surface area here stabilizes.

### GradeTheGrader — extraction QA
4 parallel Gemini-Flash judges scoring text against a rubric (Recharts radar).
Role: **the eval harness for the extraction step.** Feed it the mega-pass output
+ a rubric (speaker-attribution accuracy, scene-boundary sensibility, voice-intent
plausibility, hallucination check). Wire it into the `dry-run` ingest so you get a
quality score before spending image/audio quota. Pairs perfectly with the dry-run
mode just added.

### Context Fabric — optional shared substrate
TS Fastify + MCP context layer: canonical entities, permission-aware graph, REST
(`/v1/context/search`, `/v1/context/brief`) + 9 MCP tools, connector SDK.
Role (optional, later): a **unified memory/context API** across the suite — e.g.,
"which books has Hunter read, where did he stop, what voices did he pick, what did
he highlight in Gyōkan." Enterprise-grade and permission-heavy, so likely overkill
for single-user; but its connector + MCP model is the clean way to make per-app
state queryable if the suite grows. Treat as a stretch substrate, not a dependency.

### CloudPilot — Gemini patterns + deploy arm
Gemini visual-to-cloud, 2M-token grounding, multimodal whiteboard→graph, Cloud
Build deploy. Role: **reference for Gemini-heavy patterns** (huge-context grounding,
image→structured-JSON — directly analogous to our EPUB-images→analysis mega-pass)
and the **deployment story** if the readers ever need cloud hosting beyond
Cloudflare Pages.

### MilkMan Portfolio — the embedding shell (answers the MFE question)
Already embeds apps **two real ways**:
- **Web-Component showcase** (Shadow DOM cards + scroll tours, health-check
  `fetch`) for VoxNovel + War Council — `src/components/MilkmanShowcase.jsx`,
  `public/showcase/wc/voxnovel-card.js`.
- **Build-time SPA at a subpath** with Clerk auth + Worker secrets + edge API
  routing for CloudPilot — `scripts/integrate-cloudpilot.mjs`, `worker.js`
  (`/projects/cloudpilot/**`).

Role: **the precedent for the modal/MFE** in `AUDIOBOOK_INTEGRATION.md §5`. The
build-time-SPA-at-subpath pattern is exactly how you'd host VoxNovel's voice UI
inside EbookAVPlayer (or both inside the portfolio) without Module Federation.
No cross-app `postMessage` exists yet — that's the piece to add for a live
script→synthesis handshake.

### SpecterBoard — tangential
Personal performance leaderboard. Role: minor/optional — could surface
reading/listening streaks if the suite ever wants gamification. Not on the
critical path.

---

## Revised roadmap

**Track 1 — Reading/Audio core (the main line)**
- P0–P1 (unchanged): finish simplest-form Gemini extraction + image gen here;
  define `script.json`/`timing.json`; build Mode-B (`MediaElementClock`).
- **P2 (now concrete):** add VoxNovel's `/api/generate-from-script`, `clips.json`,
  and `timing.json` (the three gaps above). Then EbookAVPlayer `POST`s a script
  and imports M4B + timings.
- **P3:** embed VoxNovel's voice UI in EbookAVPlayer using the portfolio's
  build-time-SPA-at-subpath pattern + a small `postMessage` handshake
  (`vae:open {scriptUrl}` ↔ `vae:done {m4bUrl, timingUrl}`).

**Track 2 — Intelligence + quality (parallel, optional)**
- War Council as a second `analyze_book` backend (local/offline extraction) behind
  the existing interface; `tournament_vote` to choose among segmentations.
- GradeTheGrader wired into `dry-run` ingest → an extraction quality score before
  spending quota.

**Track 3 — Substrate + shell (later)**
- Consolidate the Edge-TTS module (Copilot Sonar ↔ readers) into one shared package.
- Optional: Context Fabric as the cross-app state/memory API.
- Optional: surface everything through MilkMan Portfolio as the public shell.

## Open decisions (for Hunter)
- Is **VoxNovel** the only synthesis backend, or should **local TTS** (XTTS direct)
  and **Edge TTS** (Sonar) all sit behind one synth interface here?
- Should extraction be **Gemini-first with War Council fallback**, or
  **War Council-first** (private/offline) with Gemini for hard cases?
- Is a shared substrate (**Context Fabric**) worth it for single-user, or is
  per-app localStorage + a thin shared JSON enough?
- Embedding target: VoxNovel-inside-EbookAVPlayer, or both-inside-Portfolio?
