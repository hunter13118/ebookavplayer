# Four-Tier Audiobook → Script Timing Engine

Sync a single `.m4b` audiobook to the on-screen script (chapters/slides originally
sourced from an EPUB) using one of four selectable timing strategies. The user
picks the strategy in **Settings → Audiobook sync** (`select-timing-algorithm`).

## How the generic spec maps onto THIS codebase

| Generic term | This codebase | Source of truth |
|---|---|---|
| chapter | `scene.chapter` (integer) | `chapterNav.buildChapterIndex` |
| **slide** | **a `line`** — the unit that advances on screen (`orchestrator.st.index`) | `Player.flatten()` |
| timing key | **global, zero-based line index** | resume/seek/orchestrator all use it |
| timing override point | `effectiveLineDuration()` in the orchestrator | `audio/timing.js` |
| algorithm picker | `prefs.timingAlgorithm` → `orch.configure` | `voicePrefs.js`, `AppSettingsSections.jsx` |

A "slide" is **not** a scene. Scenes are visual backdrops that change occasionally;
lines are what advance one-at-a-time as audio plays. So every timing record keys on
the global line index.

## Data flow

```
book.scenes ──buildSlidesByChapter──▶ ChapterSlides[]  (lines grouped by chapter,
                                                         carrying global lineIndex)
        │
        ├─(1 linear / 2 punctuation)  needs per-chapter audio durations ──┐
        ├─(3 moov-atom)  scanContainer(blob) ─▶ ContainerInfo (mvhd dur + chpl chapters)
        └─(4 whisperx)  streams NDJSON from a local align server ─▶ per-line timings
                                                                          │
   distributeProportional(totalMs, weights)  ◀───────────────────────────┘
        │  (THE zero-drift core: cumulative-boundary rounding)
        ▼
   TimingResult { algorithm, marker, chapters[], lineTimings{ lineIndex:[start,end] } }
        ▼
   (next milestone) orchestrator reads lineTimings to override estimateDurationSec
```

`lineTimings` is the flat `{ [lineIndex]: { startMs, endMs, durationMs } }` lookup the
orchestrator will read. Values are **absolute ms from book start** (so they can drive
an audio seek) and stored at **speed = 1** (the orchestrator divides by playback speed
at render time, exactly as it already does for measured TTS durations).

## The four algorithms

| # | Id | Marker | Tier | Speed | Memory | Accuracy | Drift |
|---|---|---|---|---|---|---|---|
| 1 | `linear` | `naive-linear-fallback` | client | instant | O(lines) | low | **0 ms** |
| 2 | `punctuation` | `punctuation-density-map` | client | instant | O(lines) | medium | **0 ms** |
| 3 | `moov-atom` | `container-atom-snap` | client | ms (header reads only) | O(moov), **never O(file)** | high at chapter edges | **0 ms** within chapter |
| 4 | `whisperx` | `whisperx-forced-align` | local server | minutes (real ASR) | host-bound | real acoustic timing | fuzzy-match, chapter-by-chapter |

### Trade-off analysis

- **1 — Linear ("Dumb Online").** Splits each chapter's duration across its lines in
  direct proportion to raw character count. No grammar, no acoustics. It is the
  universal fallback: it always works, is instantaneous, and is **provably zero-drift**
  (see below). Weakness: assumes every character takes equal time, so dialogue-heavy
  or punctuation-heavy passages drift *within* a chapter (never across one).

- **2 — Punctuation density ("Smarter Online").** Same distribution machinery, but the
  per-line weight is `charCount·charWeight + Σ punctuation bonuses` (`.`=4, `,`=2, `?`=4,
  `\n`=3, … all elastic/overridable). Pauses are roughly accent/dialect-invariant, so
  weighting them protects pacing against readers whose words-per-minute differ from the
  text length. Same zero-drift guarantee. Cost: still no acoustic ground truth — it's a
  better *model*, not a measurement.

- **3 — moov-atom cross-multiplier ("Advanced Online").** Reads the `.m4b`'s OWN
  structure in the browser: `mvhd` for total duration, the Nero `chpl` list for native
  chapter timestamps. It then **snaps** each script chapter's first/last line boundary
  to the real container chapter marks and linearly sub-distributes inside. Memory-safe by
  design — it walks 16-byte atom **headers** and skips the multi-GB `mdat` by pointer
  arithmetic, and uses a reverse-seek tail scan to find a trailing (non-faststart) `moov`
  "instantly." Accuracy is high at chapter boundaries (real timestamps) but still linear
  *within* a chapter. Degrades gracefully to whole-book linear if the file has no `chpl`.

- **4 — WhisperX forced-align ("Smart Offline").** The only acoustically-correct option.
  Runs against a local align server (`scripts/local-align-server/`, standalone — not part
  of this repo's `worker/` deploy) that transcribes what the audiobook actually says
  (WhisperX ASR) and fuzzy-matches it to the known line texts, chapter by chapter,
  streaming results back as NDJSON as they resolve. Robust to audio/text drift (ad-libbed
  narrator intros, minor abridgment) since it's matching against real transcribed speech
  rather than assuming word-for-word alignment with a guessed boundary.

  A prior "forced aligner" option (a local FastAPI endpoint under the now-retired
  `server/`) was removed — its only working path was a deterministic proportional
  distributor that reproduced Algorithms 1/2's math with an added network round-trip and
  no acoustic benefit; its planned real backends (Aeneas / MMS) were never implemented.

## The zero-drift guarantee (Algorithms 1–3)

`distributeProportional(totalMs, weights)` guarantees `sum(durations) === round(totalMs)`
**exactly**, for any non-negative weights, by rounding **cumulative boundaries** against
the global total rather than rounding each slide:

```
boundary[i] = round( (Σ_{k≤i} weight[k] / Σ weight) · total )
duration[i] = boundary[i] - boundary[i-1]
```

The final cumulative weight equals the total weight, so the final boundary is
`round(total) === total`; differences telescope to exactly `total`. Boundaries are
non-decreasing (cumulative sum is monotonic, `Math.round` is monotonic), so no duration
is ever negative. All-zero weights fall back to an even split.

## File map

```
web/src/timing/
  types.js                — JSDoc contract (Slide, TimingResult, ContainerInfo, …)
  distribute.js           — zero-drift core (distributeProportional, spanSlides)
  slides.js               — buildSlidesByChapter, buildResult, resolveChapterSpans
  linearSplit.js          — Algorithm 1
  punctuationDensity.js   — Algorithm 2 (+ punctuationWeight, elastic weights)
  moovAtomScanner.js      — Algorithm 3 (scan + moovAtomTiming; byte-range walking)
  whisperxAlignerClient.js — Algorithm 4 client (streams NDJSON from a local align server)
  registry.js             — multi-choice dispatch (ALGORITHMS, computeTimeline)
  fromContainer.js        — computeTimelineFromM4b: scan + resolve chapter durations + dispatch
  index.js                — public barrel
scripts/local-align-server/
  server.py                — standalone WhisperX ASR + fuzzy-match align server (Algorithm 4 backend)
web/src/audio/
  sharedAudioSource.js    — single <audio> element, plays a [startMs,endMs) segment per line
web/src/offline/
  m4bStore.js             — persists the attached .m4b Blob + filename (IndexedDB)
```

## Playback consumption (landed)

A user attaches one local `.m4b` via Settings → Audiobook sync ("Attach .m4b"). The
file is stored in IndexedDB (`m4bStore.js`, reusing the offline-pack blob store) so it
survives a reload, scanned once via `computeTimelineFromM4b`, and the resulting
`lineTimings` is pushed into the orchestrator (`orch.setTimeline(...)`). From then on,
`Orchestrator.play()` takes a fourth path — `_playSharedAudio` — that seeks a single
shared `<audio>` element (`sharedAudioSource.js`) to each line's `[startMs, endMs)`
window instead of synthesizing/fetching TTS for that book. The typewriter still drives
off the real segment duration via the same `onStart(durSec)` clock contract every other
playback mode uses, so it can't drift from the audio.

The whole file is held as a single in-memory Blob (object URL), not streamed via HTTP
Range — consistent with Algorithms 1–3 already operating on a local Blob/ArrayBuffer
rather than a remote URL. `pause()`/`stop()`/`seek()` reach `stopSharedAudio()`, which
explicitly settles any in-flight segment so the orchestrator's playback loop is never
left awaiting a promise that would otherwise never resolve.
