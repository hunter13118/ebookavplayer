# Nice-to-have: Audiobook-maker integration (design exploration)

Status: **exploratory**. This is a thinking doc, not a committed spec. For the
wider toolkit (VoxNovel, War Council, Context Fabric, the portfolio shell, etc.)
and how they all fit, see **`ECOSYSTEM_INTEGRATION.md`** — this doc is the deep
dive on the audiobook/playback spine specifically. It answers three questions
Hunter raised:

1. Can the audiobook generator be embedded here as a modal MFE to do voice work
   (personal / self-uploaded voices, XTTS v2) and M4B compilation?
2. Can an M4B carry per-sentence markers (a timing-stamped transcript) so the
   reader just "hits play" and the audiobook's playback clock drives the visuals?
3. Is a hybrid better — extract the script *here* (Gemini + BookNLP), synthesize
   *there*, so both apps share one script?

Short answers: **(3) yes, the hybrid is the right spine. (2) yes, and it's
cleaner as a sidecar timing manifest than as literal per-sentence chapters —
scenes fall out for free. (1) yes, but treat the modal UI as polish on top of a
backend contract that works without any MFE.**

The happy surprise: **most of this already exists in the parallel-reader.** This
doc leans on those patterns rather than inventing new ones.

---

## 0. What already exists (reuse map)

From `D:\claude cowork files\Projects\Gyōkan` (the parallel-reader):

| Concern | Existing asset | Reuse |
|---|---|---|
| "what's spoken at time t" | `pwa/src/audio/segments.js` → `paragraphAt(segments, tMs)`, `wordIndexAt(words, tMs)` (binary search, comment notes m4b can hold thousands of words) | The core of audio-clock-driven playback. Copy to a tee, key by `line idx` instead of `paragraph_id`. |
| timing model | `audio/base.py` → `ParagraphAlignment{start_ms,end_ms,words}`, `WordSpan` | The shape of a timing manifest entry. |
| force-align an external m4b | `audio/whisperx_aligner.py` (WhisperX large-v3, word→ms) | Timings for human-narrated audiobooks (no synthesis). |
| timings-for-free from TTS | `pipeline/stage5_audio.py` ("per-paragraph TTS → timestamps free") | Synthesis path needs no aligner; cumulative clip durations = timings. |
| XTTS v2 + uploaded voices | `audio/tts_engines.py` → `XttsV2Engine` (audiobook-maker `tortoise/voices` layout, `resolve_voice_sample`) | This *is* the bridge to the audiobook maker's voices. |
| m4b → streamable audio | `audio/transcode.py` → `transcode_audiobook` (m4b→m4a, stream-copy AAC), `probe()` duration | Server-side audio prep + duration. |
| audio pack serving | `api/app.py` → `/bundles/{id}/audio` manifest + `/audio/{rel}` file | Model for this app's audio-pack endpoints. |

The reader's segment row already looks like what we need:
`{ paragraph_id, lang, start_ms, end_ms, file_ref, words_json }`. We want the
same row keyed by our `line idx`.

---

## 1. The spine: hybrid, with the *script* as the shared contract

```
THIS APP (extract)                 SHARED CONTRACT              MAKER (synthesize)
─────────────────────              ─────────────────           ──────────────────
EPUB ingest                                                     receives script.json
  → Gemini mega-pass        ──►   script.json (the join)  ──►   user picks/uploads voices
  → BookNLP (attribution)         line idx = the key            XTTS v2 per-line synth
  → scenes/characters/lines       scenes, characters,           M4B compile
  → voice *intents*               line text, speaker,           emits timing.json
                                  voice intent                   (+ optional scene chapters)
        ▲                                                              │
        │            import: m4b + timing.json (keyed by line idx)     │
        └──────────────────────────────────────────────────────────────┘
                              ▼
                THIS APP (play): audio clock drives visuals
```

The single most important idea: **`line idx` (already stable and contiguous in
our `PlaybackBook`) is the join key across both apps.** The maker never
re-derives structure; it adds audio + timings keyed by our line ids. Perfect
alignment, no fragile re-segmentation.

### The handoff artifact (`script.json`)
This is just our existing analysis/playback, plus voice intent:

```jsonc
{
  "book_id": "the-silver-gate",
  "title": "The Silver Gate",
  "characters": {
    "elara": { "name": "Elara", "voice_intent": { "engine": "xtts-v2",
               "voice": "angie.F", "pitch": "+20Hz" } },
    "garrick": { "name": "Garrick", "voice_intent": { "engine": "xtts-v2",
               "voice": "william.M" } }
  },
  "lines": [
    { "idx": 0, "character_id": "narrator", "scene_id": "scene-0001",
      "chapter": 1, "text": "Rain hammered the old stones..." },
    { "idx": 1, "character_id": "elara", "scene_id": "scene-0001",
      "chapter": 1, "text": "We should not be here, Garrick." }
  ]
}
```

`voice_intent` is a *suggestion* from our voice assignment (`audio/voices.py`);
the maker lets the user override per character, including self-uploaded XTTS
reference clips (the maker already resolves these via `tortoise/voices`).

---

## 2. The M4B question (Hunter's #2), answered directly

**Can you put a marker on every sentence so the M4B carries its own transcript +
timing?** Technically yes. M4B is MP4; chapters live in a `chpl` atom or a
QuickTime text track, each `{start, title}`. You *could* emit one "chapter" per
sentence with `title = sentence text`. But:

- **Player compatibility breaks down at scale.** Apple Books / most players
  expect dozens of chapters, not thousands; some truncate titles, some lag.
- **It conflates two different things** — navigation (chapters) and
  timing-data (a transcript index).

So the recommendation is a **split, mirroring what the reader already does**:

1. **Real chapters at scene (or book-chapter) boundaries** — a legitimate, small
   set that behaves in *any* player (Apple Books, car head unit, etc.). Nice for
   standalone listening outside this app.
2. **A line-level timing manifest** (`timing.json`) as the authoritative index —
   one entry per `line idx`, exactly your `ParagraphAlignment` shape:

```jsonc
{
  "book_id": "the-silver-gate",
  "media": "the-silver-gate.m4b",
  "duration_ms": 5231140,
  "lines": [
    { "idx": 0, "scene_id": "scene-0001", "start_ms": 0,     "end_ms": 7320,
      "words": [["Rain",0,420],["hammered",420,980]] },   // words optional (karaoke)
    { "idx": 1, "scene_id": "scene-0001", "start_ms": 7320, "end_ms": 11960 }
  ]
}
```

Keep `timing.json` as the source of truth. **Optionally** embed it inside the
M4B as a freeform iTunes atom (`----:com.vae:timing`) or a `udta` box so the file
is self-contained and portable — but the app reads the sidecar first. This is
strictly better than per-sentence chapters and loses nothing.

### Scenes are *not* a separate problem
A scene is a **contiguous run of lines**, so it's a **contiguous run of time**.
Once each line carries `scene_id` + `start_ms/end_ms`, the scene's time range is
just `[min(start) … max(end)]` over its lines. The visual scene switch fires when
`currentTime` crosses into a line whose `scene_id` changed. No separate
scene-timing track needed. (This is the same reason the reader didn't need
scene-level alignment — paragraphs already carried it.)

---

## 3. Playback Mode B: the audiobook clock as the event driver

Today (Mode A): the orchestrator fires one Edge `/tts` call per line and times
the typewriter to each clip. Great for instant, zero-synthesis playback.

New (Mode B): **one `<audio src="book.m4b">`. Its `currentTime` is the master
clock.** The orchestrator subscribes to `timeupdate` and:

- `activeLine = lineAt(timing, currentTime)`  ← copy `paragraphAt` to a tee
- typewriter progress = `(currentTime − line.start_ms) / (line.end_ms − line.start_ms)`
  (reuse `revealedCount` with this ratio instead of the estimated duration)
- `scene = sceneOf(activeLine)` → background/sprite swap on scene change
- optional word-level karaoke = `wordIndexAt(line.words, currentTime)`

Why this is *better*, not just different:

- **Sync drift drops to ~zero.** One continuous stream, not N independently
  fetched clips. The brief flagged drift as the main risk; this removes it.
- **Scrub/seek is free.** Set `currentTime`; visuals follow because they're
  derived from it. (Mode A can't really scrub.)
- **Offline + portable** — one file, matches the brief's Phase-2 caching goal.
- **Personalized voices** — XTTS v2 with the user's own voices, not generic Edge.

The orchestrator already centralizes timing; Mode B just swaps the clock source.
Concretely, abstract a `Clock`:

- `LiveClipClock` (Mode A) — the current per-line fetch+play loop.
- `MediaElementClock` (Mode B) — wraps the `<audio>` element; emits `tick(ms)`.

`Stage` / `DialogueBox` don't change; they render whatever line+revealed the
orchestrator emits. This keeps both modes on one code path.

---

## 4. Where timings come from

- **Synthesis path (preferred):** the maker synthesizes **per line** (XTTS v2),
  so it knows each clip's duration; cumulative offsets → `start_ms/end_ms` for
  free. `stage5_audio.py` already does exactly this ("timestamps free"). The
  maker emits `timing.json` as a byproduct of compiling the M4B. **No aligner
  needed.**
- **Externally-narrated path (bonus):** if the user drops in an M4B they already
  own (a human narrator, Audible-ripped personal copy, etc.), run
  **WhisperX forced alignment** of the M4B against the known script text →
  `start_ms/end_ms` per line. `whisperx_aligner.py` already does this for
  paragraphs; adapt to line granularity. This extends the whole feature to books
  that were never synthesized here.

---

## 5. The MFE / modal question (Hunter's #1)

Reality check: this app is Vite/React; the audiobook maker is a Python/PyTorch
(XTTS) app. True **Module Federation** wants both ends to be JS bundles, so it's
not the natural first move. Three options, increasing coupling:

- **Option C — backend contract only (start here).** This app `POST`s
  `script.json` to the maker's API (or writes it to a shared folder); the maker
  synthesizes + compiles and returns `{ m4b_url, timing_url }`; this app imports
  them. **No embedded UI at all** — and it already gives you 100% of the
  *functionality*. The maker keeps its own UI as a separate window/app.
- **Option A — iframe modal + postMessage (recommended polish).** Embed the
  maker's web UI in a modal here. Handshake:
  `parent → iframe: {type:"vae:open", bookId, scriptUrl, token}`;
  `iframe → parent: {type:"vae:done", m4bUrl, timingUrl}` → this app imports.
  The maker stays a separate deployable; we just frame it. Voice work
  (upload/select XTTS voices, preview a line) happens in its native UI.
- **Option B — true MFE via Module Federation.** Only if/when the maker grows a
  React UI worth federating. Tighter coupling, shared dep versions, more build
  work. Defer.

Recommendation: **build Option C's contract first** (it's the real integration),
then **layer Option A's modal** for the in-app feel Hunter wants. Option A
without C is backwards — the modal is a window onto the contract.

### Minimal import endpoint (this app)
```
POST /books/{id}/audio        multipart: m4b, timing.json
  → stores under data/media/{id}/audio/  (mirrors the reader's audio pack)
  → sets book.audio = { m4b, timing, duration_ms }, playback prefers Mode B
GET  /books/{id}/audio/manifest   → timing.json (client builds the clock map)
```

---

## 6. End-to-end hybrid flow (the recommended shape)

1. **Extract (here).** Ingest EPUB → Gemini mega-pass + **BookNLP** → scenes,
   characters, line attribution, voice intents. This is the existing "processing"
   step; it already produces the `PlaybackBook`.
2. **Handoff.** Export `script.json` (analysis + voice intents). Open the maker
   (Option A modal, or just hand it the URL/token under Option C).
3. **Synthesize (there).** User confirms/overrides voices — including
   **self-uploaded XTTS reference clips** — previews lines, runs XTTS v2 per line,
   compiles the **M4B** (+ scene chapters), emits **`timing.json`**.
4. **Import (here).** `POST /books/{id}/audio`. The book flips to **Mode B**;
   "hit play" on the M4B and the playback clock drives sprites, scene changes,
   and typewriter text. Edge-TTS Mode A stays as the no-synthesis fallback.

### Why BookNLP belongs in step 1
BookNLP is strong at **quote attribution + character clustering** — exactly the
"who says this line" problem. It can either feed the Gemini pass (cheaper, fewer
tokens) or cross-check it (higher confidence on speaker labels). Either way it's
an *extraction* concern, so it lives **here**, and its output is already encoded
in `line.character_id`. The maker never needs to know BookNLP ran.

---

## 7. Risks & gotchas

- **Granularity mismatch.** The reader's audio model is per-**paragraph**; the
  visual app is per-**line/sentence**. Per-line is finer and fine for timing —
  just make the maker synthesize and time at line granularity (our `idx`).
- **Re-synthesis on script edits.** If the user edits a line after synthesis,
  only that line's clip + `timing.json` entry need regenerating. Keep the maker
  idempotent per line (stage5 already is per-paragraph). Downstream `start_ms`
  shift if a clip's duration changes — recompute cumulative offsets cheaply.
- **Browsers can't write M4B metadata.** All embedding/transcoding is
  **server-side** (ffmpeg / mp4box), same home as `transcode.py`.
- **Don't over-chapter the M4B.** Scene chapters only; per-sentence data → sidecar.
- **Voice uploads** = user audio at rest; store under the book's media dir, treat
  as personal data (don't sync to memory/logs).
- **Two sources of truth for "current line."** Mode A (clip ended → advance) vs
  Mode B (clock → lookup). The `Clock` abstraction keeps the orchestrator from
  branching everywhere.
- **Seeking in Mode A is poor; in Mode B it's native.** Another reason Mode B is
  the premium path.

---

## 8. Phased plan

- **P0 — contract.** Define `script.json` + `timing.json` shapes (above). Add
  `POST /books/{id}/audio` import + `GET …/audio/manifest`. No maker changes yet;
  validate by hand-authoring a `timing.json` for the sample book.
- **P1 — Mode B playback.** Add `MediaElementClock` + `lineAt`/`sceneOf` (copy
  `segments.js`); orchestrator consumes a `Clock`. Prove with sample M4B +
  hand-authored timings. (e2e: fake an `<audio>` clock, assert line/scene/
  typewriter track `currentTime` — same stub trick we already use.)
- **P2 — maker contract.** Maker accepts `script.json`, synthesizes per line with
  XTTS v2, compiles M4B, emits `timing.json`; this app imports. Backend-only
  (Option C).
- **P3 — modal MFE.** iframe + postMessage handshake (Option A) for the in-app
  voice-work feel.
- **P4 — external audiobooks.** WhisperX alignment path for M4Bs not synthesized
  here.

## 9. Open decisions (for Hunter)

- Embed `timing.json` inside the M4B (portable, self-contained) **and** keep the
  sidecar, or sidecar-only? (Recommend: both; sidecar authoritative.)
- Is the maker willing to expose (a) an HTTP API and/or (b) an embeddable web UI?
  That choice picks Option C vs A.
- Line vs sentence as the atomic unit for timing (we've used per-line; confirm
  the maker can synthesize at that granularity).
- Keep Edge-TTS Mode A as a permanent fallback, or treat Mode B (personalized
  M4B) as the only "real" experience once available? (Recommend: keep A — it's
  the zero-setup instant path and the demo's lifeblood.)
