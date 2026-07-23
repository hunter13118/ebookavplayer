# M4B-first flow (audiobook → auto-scrolling karaoke reader)

Status: **baseline complete and verified end-to-end on real data.** Upload
from the library → live transcription → minimal reader → background formal
extraction all work, proven against `test_assets/e2e/demo-clip.m4b` and the
real align server + local Ollama. The vaepack export and EPUB-integrity check
are the remaining follow-ups (§7).

Where the rest of the app starts with an **EPUB** and optionally attaches audio
later (`docs/AUDIOBOOK_INTEGRATION.md`, `web/src/timing/ARCHITECTURE.md`), this
flow **inverts** it: the **M4B is the only required input**. We speech-to-text
the whole book, and the transcript *is* the book text. From it the user gets an
immediately-usable minimal reader, while the normal scenes/characters extraction
runs later over the same transcript (retro-extraction) to upgrade it into a full
visual audiobook.

This is the `docs/AUDIOBOOK_INTEGRATION.md` "P4 external audiobook" path promoted
to a **primary entry point**, plus a brand-new minimal reader. Unlike the
existing `whisperx-local` timing tier (which fuzzy-matches audio against known
EPUB lines), there is **no known script** here — it's open transcription.

## 1. The pieces (and what each reuses)

| Concern | Where | Reuses |
|---|---|---|
| Speech-to-text w/ word timings | `scripts/local-align-server/server.py` → `POST /transcribe` | The same chunked WhisperX transcription + suspect-segment repair the `/align` path already had — minus the EPUB matching. |
| Transcript client | `web/src/timing/transcribeClient.js` → `transcribeM4b()` | The NDJSON-streaming pattern from `whisperxAlignerClient.js`. |
| Karaoke timing logic | `web/src/reader/karaoke.js` (pure) | `audio/lineAt.js`'s binary search. |
| Procedural pagination | `web/src/reader/pagination.js` (pure) | — |
| The reader | `web/src/reader/KaraokeReader.jsx` + `reader.css` | `audio/sharedAudioSource.js` as the master clock (Mode-B continuous playback). |
| Local-only book (before any server extraction exists) | `web/src/offline/m4bFirstBooks.js` | The SAME pack shape an installed `.vaepack` uses (`packStore.js`) — `mergeCatalog()` already lists a local-only pack with `server_available: false`, zero catalog changes needed. |
| Exact timing fast-path | `web/src/timing/m4bFirstTimeline.js` | Player.jsx's existing mount-time "attach a .m4b" hook — skips the 4-algorithm estimate dance since the timing is already known exactly. |
| Upload orchestration | `App.jsx`'s `startM4bFirstUpload` | `openBook`/`enterPlayer` — a fresh M4B-first book opens through the EXACT same path any other book does. |
| Formal extraction trigger | `POST /books/:id/ingest-text` → `worker/queue/ingest-text-consumer.js` | `runBookExtractPipeline` + `compilePlayback` — the same simple (non-chapter-checkpointed) path `re-extract-consumer.js` uses. |

## 2. `POST /transcribe` (align server)

Engine-agnostic on purpose — the ASR is WhisperX today, but the contract lets an
MLX backend replace `_transcribe_chunk` later with **no client change** (the
decision on record: "reuse WhisperX now, MLX-swap later").

```
POST /transcribe   multipart form: m4b (the whole audiobook file)
-> streamed NDJSON:
   {"status":"chunk",
    "lines":[{"idx":int,"text":str,"start_ms":int,"end_ms":int,
              "words":[[word,start_ms,end_ms], ...]}, ...],
    "processed_ms":int, "total_ms":int, "meta":{asr_device,align_device,model}}
   {"status":"done","line_count":int,"total_ms":int,"meta":{...}}
```

A "chunk" row carries only the sentences newly transcribed in that time window
(globally indexed, contiguous), so the reader can start on the first ~4 minutes
(`ALIGN_FIRST_CHUNK_MS`) while the rest streams in. Sentences are split from the
flat word stream on terminal punctuation (`_words_to_sentences`), so the highlight
unit is a real sentence while word timings stay available for the karaoke wipe.

### Resuming an interrupted transcription

A page refresh (or a crash) during transcription used to mean starting the
whole file over from `0ms` — for a long audiobook, potentially hours of
re-transcription. `/transcribe` now accepts two optional form fields:

```
POST /transcribe   multipart form: m4b, resume_ms (int, default 0), resume_idx (int, default 0)
```

When `resume_ms > 0`, `_chunk_bounds` skips straight to `CHUNK_MS`-sized
windows starting at that offset (no `FIRST_CHUNK_MS` warmup — a resumed run
doesn't need it), and new sentence `idx`s continue numbering from
`resume_idx` instead of `0`.

The client (`transcribeM4b`) checkpoints the offset on **every** chunk row —
including ones that produced no new lines — via
`checkpointM4bFirstProgress(bookId, processedMs)`
(`web/src/offline/m4bFirstBooks.js`), stored alongside the already-saved
lines on the local pack record. `resumeM4bFirstPoint(bookId)` reads it back
as `{ resumeMs, resumeIdx }` (`resumeIdx` is just the count of lines already
saved). Two call sites use it:

- `startM4bFirstUpload` — re-selecting the same file after an interrupted run
  resumes instead of wiping the partial transcript.
- `enterPlayer` — opening a book still flagged `m4b_first_status:
  "transcribing"` (e.g. after a reload) automatically calls
  `resumeM4bFirstTranscription(bookId, title)`, which re-reads the .m4b blob
  already sitting in `m4bStore.js` (no re-upload needed) and continues from
  the checkpoint in the background.

## 3. Transcript-book data model

The minimal book the whole flow runs on:

```jsonc
{ "bookId":"…", "title":"…", "durationMs": 360003,
  "lines":[ { "idx":0, "text":"…", "startMs":4478, "endMs":12663,
              "words":[["Podium",4478,4900], …] }, … ] }
```

`lines` are contiguous and `startMs`-sorted, so a line's array position **is** its
idx. The reader consumes this directly; later the vaepack persists it and
retro-extraction joins `text` into `body_text`.

## 4. The minimal karaoke reader

`KaraokeReader.jsx` — a full-screen, self-paginating, audio-clock-driven book:

- **Procedural pagination.** Every sentence is measured offscreen at the user's
  font size and greedily packed into pages that fit the stage
  (`pagination.paginate`). Font size ± re-paginates.
- **Word-level karaoke.** A rAF loop reads the audiobook playhead
  (`getSharedAudioCurrentTimeMs`) each frame. Past sentences render fully read;
  the active sentence reveals word-by-word; the active word is a left-to-right
  accent-colored wipe whose position is `wordProgress` through that word's
  `[startMs,endMs)`. The highlight is applied **imperatively** via refs so 60fps
  wipes never churn React — React state handles only page turns and font changes.
- **Auto page-turn.** When narration crosses into a sentence on the next page,
  the page turns itself (`pageOfLine`). Manual prev/next and click-a-sentence
  both seek the audio so the highlight always follows the clock.

### Verified (reader-first milestone)
Against the real transcript of `test_assets/e2e/demo-clip.m4b` (62 sentences,
809 words): pagination (→ 9–10 pages), fully-read vs active vs upcoming sentence
states, the per-word wipe (caught mid-word, e.g. active word "Slayer" at 43%),
and auto page-turn (seek to 3:30 → auto-advanced to page 5). 419 web tests +
24 align-server tests green.

Dev harness: `web/src/reader/KaraokeDemo.jsx`, reachable at `?karaoke-demo`
(DEV only), loads `web/src/reader/__fixtures__/demoTranscript.json` + the demo
audio. Not a production path.

## 5. Upload flow (`web/src/offline/m4bFirstBooks.js` + `App.jsx`)

"Upload an audiobook (.m4b)" lives in `AddBookSheet.jsx`, reachable from both
Simple and Full library "+ Add" (threaded through `Library.jsx` for Full mode).
Picking a connection to run STT against (`prefs.alignConnectionId`) previously
lived ONLY inside `PlayerMenu.jsx`'s Audiobook Sync section — unreachable
without an already-open book, which a first-time M4B-first user with an empty
library doesn't have. Added the same picker (book-agnostic — it's just
`listConnections()` + a pref write) to `GlobalSettingsSheet.jsx` (Full mode's
Library-level Settings) so it's reachable from a totally empty library.
Deliberately NOT added to Simple Mode's settings — connection/backend
management has always been Full-mode-only (see `Library.jsx`'s own doc
comment); Simple users reach it via the existing 2-tap "Show advanced
options" path, consistent with every other advanced setting.

`App.jsx`'s `startM4bFirstUpload(file)` owns the whole sequence:

1. **Install immediately.** `installM4bFirstBook({bookId, title, blob,
   fileName})` derives `book_id`/`title` from the filename (same slugging
   convention as EPUB ingest), saves a pack record (one empty scene) via
   `packStore.savePackRecord`, and stores the blob via the existing
   `m4bStore.js` — the exact store Player.jsx's mount-time "attach a .m4b"
   hook already reads. `mergeCatalog()` lists it immediately
   (`server_available: false`, `offline_pack: true`) with zero catalog code
   changes.
2. **Transcribe, streaming.** `transcribeM4b()` streams NDJSON from the align
   server; each chunk's lines are appended (`appendM4bFirstLines`) and, the
   moment the FIRST chunk lands, the app opens the book — `openBook`/
   `enterPlayer`, unmodified. If the book is already open when a later chunk
   arrives, `fetchBook(bookId)` is re-run and pushed into `Player`'s `bk`
   prop, so playback keeps growing live instead of needing a reload.
3. **Formal extraction, backgrounded.** Once the full transcript is in hand,
   `POST /books/:id/ingest-text` runs — no UI blocking, failure is non-fatal
   (the book stays fully usable as transcript + real audio either way).

### Formal extraction (`POST /books/:id/ingest-text`)

The "same book_id, no epub" version of `/ingest`. `body_text` goes to R2 (not
the queue message — Cloudflare Queues caps messages at 128KB; a full book's
transcript can exceed that), and `worker/queue/ingest-text-consumer.js` runs
`runBookExtractPipeline` (character-count chunking — no epub chapters needed,
`freemiumExtractBook` already falls back to it) → `compilePlayback` → persists
`books/{id}.json` — no imaging, mirroring a dry-run EPUB ingest. `fetchBook()`
prefers a matching remote book over the local-pack fallback once that remote
book has actually **compiled** (see the "can't open a processing book" bug
below for the case where it hasn't yet), so the SAME `book_id` graduates to cinematic/spotlight-capable on
its own; no merge step. Art generation stays a separate, on-demand action via
the normal ArtStyleSwitcher, same as any dry-run/BYO book.

**Bug found and fixed while verifying this:** `freemiumExtractBook` calls
`onProgress` as a **plain function** (`onProgress({chunk,total,provider})`),
not `onProgress.extract(fn)`. `re-extract-consumer.js` — the file
`ingest-text-consumer.js` was modeled on — passes the wrong shape
(`onProgress: { extract: fn }`), which throws `"onProgress is not a
function"` the instant the first chunk finishes, killing the job.
`ingest-text-consumer.js` passes a plain function and is verified working;
**`re-extract-consumer.js` still has the original bug** (untouched — out of
scope for this change) and needs the identical one-line fix before "Re-extract
script" in `PlayerMenu.jsx` can be trusted to actually complete. Also worth
carrying to that fix: `putBookIndex` merges rather than replaces, so a book_id
reused across attempts (or across an unrelated prior feature — one repro hit a
stray `"Imaging job stalled — unlock and retry"` string surviving into a
successful, unrelated `ingest-text` run's `detail` field) keeps whatever
`error`/`detail` an earlier `putBookIndex` call last wrote unless a later call
explicitly overwrites both. `ingest-text.js` (on enqueue) and
`ingest-text-consumer.js` (on success) now set `error: ""` and a real
`detail` string every time; `re-extract-consumer.js` does neither.

**Second bug found and fixed while verifying this: "UI works, audio doesn't."**
A real-device upload (laptop) completed transcription and formal extraction
correctly — the reader rendered and scrolled fine — but the audiobook audio
itself was silent. Root cause: `.m4b` has no browser/OS-registered MIME
mapping (unlike `.mp3`), so a file picked via `<input accept=".m4b">`
frequently arrives with an empty `file.type`; `packStore.js`'s
`blobToStored()` then defaults that to `application/octet-stream`, which
Chrome/Safari's `<audio>` element silently refuses to play even though the
underlying AAC-in-MP4 data is valid — text/scroll is unaffected since it never
touches the blob's MIME type. Fixed in `web/src/offline/m4bStore.js` via a
`normalizeM4bType()` helper (re-wraps the blob — `Blob.type` is read-only —
with `audio/mp4` unless it's already a recognized audio type), applied on
**both** `storeM4b` (write) and `loadM4b` (read). Normalizing on read means
the fix is retroactive: an M4B already sitting in IndexedDB from before this
fix (e.g. the user's already-uploaded book) gets a playable type on next load
with no re-upload needed. Covered by 4 new tests in `m4bStore.test.js`.

**Third bug found and fixed: couldn't open the minimal reader for a book
still mid formal-extraction.** Reported as "how come I can't do the minimal
view for a processing book" against a real book whose `/ingest-text` job was
queued/running server-side. Two independent gates were both wrong for this
case:

1. `web/src/offline/bookSource.js`'s `fetchBook()` — once a remote `GET
   /books/:id` succeeds at all, it merged `{...remote, ...}` over the local
   pack. A book still mid formal-extraction returns a near-empty remote stub
   (`{error, book_id, status:"processing"}`, zero scenes) — the merge
   silently threw away the local pack's already-complete transcript, leaving
   `lines.length === 0` and a permanent "Preparing this book…" spinner even
   though the device had full readable content. Fixed: while
   `remote.status === "processing"`, return the local pack's content instead
   (`bookFromLocalPack(local)`) — the same thing the function already did on
   an outright fetch *error*, just also applied to a fetch that *succeeds*
   with an unfinished stub.
2. `web/src/components/SimpleLibrary.jsx`'s `bookAction()` — its
   "still extracting" heuristic falls back to `entry.progress < 0.45` when
   `total_chapters` is absent, which is *always* the case for an
   `ingest-text` job (character-chunk based, no chapter concept at all). That
   permanently disabled the library row (`disabled={act.kind ===
   "processing"}`), so the book couldn't even be tapped, independent of bug
   #1. Fixed by short-circuiting the gate when the entry already has a
   readable offline pack (`entry.offline_pack && entry.lines > 0`).

Note Full Mode's `BookCard.jsx` was never affected by #2 — its card button has
no `disabled` state at all, so it already opened straight into bug #1's
spinner. Verified live in-browser (Simple Mode): with a synthetic local pack
installed under a book_id the real dev worker reports as `status:
"processing"`, the row changed from a disabled "Getting your book ready…" to
a tappable "▶ Play" that opens directly into the reader showing the
transcript. Regression test added to `bookSource.test.js`.

### Verified (this milestone)
Real end-to-end run against `demo-clip.m4b`'s transcript (4588 chars, 62
sentences) through the live worker + local Ollama (`ollama-30b`), repeated
until a fully clean pass: `POST /books/:id/ingest-text` → job progresses
through real chunked extraction → compiles to 2 scenes / 3 correctly-
identified characters (`young-man`/`dragon-slayer`/`narrator`) with correct
dialogue/narration attribution → catalog entry flips to `status:"ready"`,
`error:""`, `detail:"Formal extraction complete (ollama-30b)"` — no stale
fields. `m4bFirstBooks.js`'s full lifecycle (install → append chunks → mark
complete → remove) plus its integration with
`fetchLocalCatalog`/`mergeCatalog`/`fetchBook` verified via
`fake-indexeddb`-backed vitest (11 tests) — including the critical
`fetchBook()` → `m4bFirstTimelineFromBook()` handoff Player.jsx's fast path
depends on. 460 web tests green.

One verification run genuinely hung (not a timing artifact): Ollama evicted
the model mid-generation on its own idle keep-alive while the job sat
untouched for several minutes, orphaning the worker's in-flight request with
no response ever coming back — `ollama ps` showed zero loaded models while
the job stayed at "processing" indefinitely, yet a fresh request against the
same model completed normally. A `npm run start:local` restart (same fix as
the earlier stuck-queue gotcha) cleared it. Not a code bug — a local-serving
rough edge triggered by leaving a job idle a long time; a real user's client
actively polls and wouldn't reproduce this window.

## 5b. Attaching a real EPUB after the fact

A book that started m4b-first has no real EPUB behind it — just the STT
transcript (and, once formal extraction runs, scenes/lines derived from that
transcript's guessed chapter/sentence boundaries). `PlayerMenu.jsx`'s
"Attach EPUB…" (next to "Re-extract script") lets the user attach one later,
purely to *upgrade* an already-usable book: better chapter boundaries than
STT-guessing, and any illustrations embedded in the EPUB itself surfacing as
real cover/character/background art via the existing `direct-use`
illustration mode (`worker/_shared/illustrations.js`) — no AI image
generation needed for those slots.

Implementation is almost entirely reuse, not new plumbing:
`web/src/api.js`'s `attachEpubToBook()` calls the exact same `POST /ingest`
route a fresh EPUB upload uses, just with an `existing_book_id` field.
`worker/api/v1/ingest.js` uses that id instead of deriving one from the
filename, and skips overwriting the catalog title unless one is explicitly
passed — everything else (checkpointed extraction, embedded-image
extraction, R2 storage, queue consumer) is the *unmodified* normal EPUB
pipeline. The client's job-polling UI (`onJobStarted`/`pollJob`/`onRefresh`,
already built for "Re-extract script") covers this for free too.

The client-side m4b audio blob (`m4bStore.js`, keyed by book_id) is never
touched by this — Player.jsx's mount-time re-timing effect already detects
that the new EPUB-derived lines no longer match the exact-timing fast path
(`m4bFirstTimeline.js`) and falls back to real WhisperX alignment against the
new line boundaries automatically, the same mechanism that already handles
the "STT-transcript lines → formal-extraction lines" transition (§5).

Verified via curl against a real fixture EPUB (`test_assets/e2e/
lantern-owl-gate.epub`) with a synthetic `existing_book_id` — chapters
extracted correctly, and an embedded plate came back as the real cover
(`/media/{id}/illustrations/img_000.png`, verified reachable). Also verified
the full UI round trip (menu button → file input → job → completion) against
the "M4B First Test Book" fixture by simulating a file-input `change` event
in a live browser (Claude-in-Chrome's upload tool caps at 10MB, too small for
the real 587MB audio case earlier in this doc, but this EPUB fixture fit).

### Knowing which books still need it: `book.text_source`

Once formal extraction promotes an m4b-first book to a real server book
(§5's `POST /books/:id/ingest-text`, run automatically on the raw STT
transcript), it looks — client-side — like any other book: `m4b_first_status`
is gone, since that field only ever lives on the local-only pack. Nothing
distinguished "real EPUB prose" from "STT transcript that happened to pass
through the normal extraction pipeline" until now.

`book.text_source` (`"epub"` | `"m4b_transcript"`) closes that gap:
- `worker/_shared/book-extract-pipeline.js`'s `runBookExtractPipeline()`
  stamps it onto `analysis.text_source` — `"epub"` by default (every caller
  except one), `"m4b_transcript"` when `ingest-text-consumer.js` passes it
  explicitly.
- The checkpointed EPUB pipeline (`chapter-extract-pipeline.js`, used by
  `POST /ingest` — both a fresh upload and "Attach EPUB…") always sets
  `"epub"` directly, since it only ever runs over real uploaded EPUB bytes.
- `compile-playback.js`'s `compilePlayback()` copies `analysis.text_source`
  onto the compiled playback (`"epub"` if missing entirely — true for every
  book compiled before this field existed). Because `GET /books/:id`
  recompiles playback from `analysis.json` on every fetch
  (`enrichPlaybackFromAnalysis`, `worker/api/v1/books.js`), this value is
  never stale — attaching a real EPUB later re-derives it to `"epub"`
  automatically, no separate migration/backfill needed.
- The purely-local pack (before any server ingest at all — `emptyBook()` in
  `web/src/offline/m4bFirstBooks.js`) sets the same field so the indicator is
  correct from the very first moment too.

Surfaced in Settings (`PlayerMenu.jsx`, `data-testid="text-source-indicator"`,
next to "Attach EPUB…") as "Text source: EPUB ✓" or "Text source: audio
transcript (no EPUB attached yet)".

## 5c. Verbatim-coverage repair (attribution tags weren't showing up)

The extraction prompt (`worker/_shared/dialogue-rules.js`'s "VERBATIM
COVERAGE" rule) already tells the model every word of the source book must
appear in exactly one line — an attribution tag like `he said quietly.` is
supposed to come out as its own narration line. Nothing verified compliance
though, so a per-chapter LLM slip (dropping a tag) was silent and invisible
both in the reader and cinematic views.

`worker/_shared/verbatim-coverage.js`'s `findMissingVerbatimText()`/
`repairChapterVerbatimCoverage()` closes that gap: after each chapter's
extraction, it diffs the chapter's raw EPUB text (`epub-text.js`'s
`chapter.text` — no LLM involved, genuinely verbatim) word-for-word against
the reconstructed lines' text, using the same anchor-block strategy
`server.py`'s `IncrementalAligner` already uses for audio alignment (a run of
several consecutive matching words is a real anchor; anything from the
source that never resurfaces is what got dropped) — but with a lower
block-size floor (3, not 6) since this is an exact, normalized text-vs-text
diff with a tightly bounded resync search, not fuzzy ASR matching across an
entire book. Anything missing is spliced back in as a new
`{character_id:"narrator", kind:"narration"}` line, right where it belonged.

Wired into both `chapter-extract-pipeline.js` (per chapter, the normal
ingest/"Attach EPUB…" path) and `book-extract-pipeline.js` (the single-shot
re-extract path) — skipped for the m4b-first transcript-only path
(`text_source: "m4b_transcript"`), since there's no separate verbatim ground
truth to diff against there. Only runs at ingest/re-extract time — an
already-extracted book needs a "Re-extract script" run (`PlayerMenu.jsx`) to
pick up any previously-dropped text.

## 5d. Front/back-matter art (cover, gallery, trailing junk)

Attaching a real EPUB via §5b also now surfaces the cover/character-gallery/
title-page art that sits *before* the first real chapter, and correctly
excludes trailing junk (a publisher newsletter/ad page) from becoming a fake
final "chapter" — see `docs/VIEW_MODES.md`'s Reader view section for the full
mechanism (`splitBackMatter` in `epub-text.js`, `matchIllustrationsToChapters`
in `chapter-extract-pipeline.js`, `book.front_matter`/`back_matter`,
`reader/ArtGallery.jsx`). Verified directly against the real Mistress Vol. 2
EPUB (`~/Downloads/...`): 7 front-matter plates (cover + 3-image color
gallery + title page + copyright + TOC) and the "Newsletter" back-matter page
correctly bucketed, all 14 interior illustrations still matched to their real
chapters unaffected. **Not yet verified end-to-end against a real, fully
completed attach** — this book's own "Attach EPUB" re-extraction (started
same day) takes ~2-3 hours via local Ollama (see §2's `MAX_WORDS_PER_SECOND`-
style local-vs-cloud tradeoff), so the worker-side pieces were validated
directly against the EPUB file's parsing/matching output (no LLM involved)
and the client-side gallery/hold/skip UX was smoke-tested against a
*different*, already-fully-extracted book with synthetic injected
front_matter/back_matter/illustration_url data.

## 6. Known limitations (baseline)

- **Sentence splitting is ASR-punctuation-based.** Headings without terminal
  punctuation can merge into the next sentence ("Prologue, The Visitor In this
  world…"). Fine for a minimal reader; retro-extraction re-segments properly.
- **Pagination measures every sentence up front** (O(lines) DOM). Fine for a
  chapter/demo; a full multi-thousand-sentence book wants batched/estimated
  measurement.
- **ASR runs on CPU (int8).** Fine for the demo clip; a full 10-hour book is
  slow — the MLX backend swap (§2) is the intended fix. **Fixed the worst
  consequence of this** (see next section): a page reload used to throw away
  all alignment progress on a long book; now it resumes instead.

**Bug found and fixed: WhisperX alignment restarted from 0% on every page
reload, on a book long enough that a single session often couldn't finish
it.** `alignCache.js`'s `storeAlignManifest()` only ever persisted once — at
full completion (`Player.jsx`'s final `.then(finalResult => …)` callback). A
~10-hour audiobook running WhisperX on CPU can easily outlive one tab
session; every reload before that final callback fired discarded ALL
already-computed acoustic timing and restarted the whole pass from the crude
linear estimate. Fixed by persisting incrementally: `storeAlignManifest` now
takes a `{complete}` flag, written `false` after every `onLinesReady`/
`onGapsReady` chunk (accumulating across chunks, not just the latest one) and
`true` only on the authoritative final merge. On load, a `complete: false`
manifest is used as the resumed baseline (already-real acoustic timing, a
strictly better starting point than the linear guess) while the SAME live
realignment pass keeps running and refining in the background — nothing
about the live-refinement behavior changed, only what happens on reload.
Verified live against the real ~617-minute Mistress book: reloaded mid-align
at "4/617 min · 1%", waited for a couple chunks to land (confirmed a
`complete: false` manifest with real line timings in IndexedDB), reloaded
again, and it opened at "34/617 min · 6%" — continuing forward, not
resetting. 2 new tests in `alignCache.test.js`; 467 web tests green.

**Bug found and fixed: playback occasionally jumped to a "random" spot in
the book.** `IncrementalAligner.feed()` (`server.py`) accepted any
`MIN_ANCHOR_BLOCK_WORDS`-sized (6+) matching block found within
`max_lookahead` words of the cursor — and `max_lookahead` grows with
`elapsed_since_advance_ms`, which **accumulates across consecutive chunks
that fail to match anything** (a hard-to-transcribe stretch, or the Whisper
mis-segmentation bug above) and is never reset until a real anchor lands. A
long enough dry spell could inflate the window to thousands of words, at
which point a coincidental 6-word match on an ordinary repeated phrase
anywhere in that window got accepted as a real anchor — and since `cursor`
is monotonic (`self.cursor = max(self.cursor, ...)`, never reverts), the
whole stretch between the true position and the false anchor was left with
bogus interpolated timings. There was already a regression test for a match
found *outside* even the inflated window
(`test_a_long_coincidental_match_far_ahead_in_a_big_book_is_rejected_as_implausible`);
the uncovered case was a coincidental match *inside* it. Fixed with two new
constants: `MAX_LOOKAHEAD_WORDS` hard-caps how far the window can inflate
regardless of dry-spell length, and `STRICT_ANCHOR_BLOCK_WORDS` (10, up from
6) is required specifically for a block whose position is beyond what this
chunk's own elapsed real time — uncapped, unfloored — could plausibly
justify. New regression test:
`test_a_short_coincidental_match_reachable_only_via_the_lookahead_floor_is_rejected`.
Because a manifest computed before this fix could have baked in exactly this
kind of bogus timing, `web/src/offline/alignCache.js` needed some way to
treat already-cached alignments as stale. **First attempt was wrong and
regressed live**: namespacing the storage key (a `CACHE_VERSION` bump) made
every pre-existing manifest unreachable outright — but `Player.jsx`'s
`applyM4bTimeline` only preserves real acoustic sync (gaps included) when it
finds SOME cached data to use as a working baseline; with nothing cached at
all, it drops straight to a crude text-length-estimate timeline and only
recovers real sync if the local align server happens to be running to redo
the whole alignment live. Caught by the user testing against a real book
with the align server stopped: gaps vanished entirely and the displayed
duration jumped from the real 6:12:15 to an estimated 9:50:57. Fixed by
downgrading instead of hiding: manifests now carry a `schemaVersion`; a
pre-existing one (or one from an older schema) loads with `complete: false`
while its real `result` (lineTimings + gaps) is still returned intact — reusing
the exact "resume from a real cached baseline, refine live in the background"
machinery already built for the page-reload-mid-alignment case (above),
instead of discarding working data. The book keeps its current sync/gaps
immediately; a corrected alignment only replaces it once one actually
completes (which needs the align server running — same as any fresh align).

## 7. Next steps

1. ✅ **Upload wiring** — done (§5).
2. ✅ **Retro/formal extraction** — done (§5): `POST /books/:id/ingest-text`.
3. **Vaepack export** — persist transcript + M4B + timing into the existing
   `TIER_AUDIOBOOK` pack (`offline/packFormat.js`) for portable offline use.
   (Today's local pack already IS offline-durable via IndexedDB — this is
   about the exportable `.vaepack` file, matching what a normal book gets via
   Simple Library's Downloads sheet.)
4. ✅ **Attach a real EPUB after the fact** — done (§5b): `POST /ingest` with
   `existing_book_id`, "Attach EPUB…" in `PlayerMenu.jsx`. Diffing the
   attached EPUB against the transcript to flag STT drift (the original scope
   of this item) is still not implemented — the attach itself just
   re-extracts from the EPUB's real text outright rather than reconciling
   against the STT version.
5. **Fix `re-extract-consumer.js`'s `onProgress` bug** (§5) — same one-line fix
   `ingest-text-consumer.js` needed; "Re-extract script" in `PlayerMenu.jsx` is
   currently broken for any book whose extraction actually reaches a chunk
   boundary.
6. **Live re-render polish** — `startM4bFirstUpload`'s live-refresh
   (`fetchBook` on each new chunk while the book is open) re-fetches the WHOLE
   book per chunk; fine for a demo-length clip, wasteful for a real book with
   many chunks. Consider merging just the new lines into the open `Player`'s
   `book` state instead once this flow sees real multi-hour-book usage.

## Align-server setup

WhisperX needs torch, which has **no Python 3.14 wheels** — this repo's `venv/`
is 3.14, so the align server gets its **own 3.12 venv** via `uv`:

```bash
cd scripts/local-align-server
UV_SYSTEM_CERTS=1 uv venv --python 3.12 .venv          # keychain trust (MDM TLS)
UV_SYSTEM_CERTS=1 uv pip install --python .venv/bin/python whisperx fastapi "uvicorn[standard]" python-multipart
.venv/bin/python server.py                              # GET /health, POST /align, POST /transcribe on :7861
```

`UV_SYSTEM_CERTS=1` is required on this machine — the MDM intercepts TLS, so uv
must trust the macOS keychain root (see the MDM/DNS note in memory). ffmpeg 8 is
present; the `libtorchcodec` warning on startup is harmless (WhisperX decodes via
the ffmpeg CLI, not torchcodec).

### Reaching it from a phone (or any other device on the LAN)

**The working fix: proxy it through Vite, same as every worker route** —
`vite.config.js`'s `server.proxy` has an `/align-proxy` entry →
`http://127.0.0.1:7861` with a `rewrite` stripping the prefix, so
`/align-proxy/transcribe` → the align server's `/transcribe`, etc. A phone
only ever needs to reach Vite (`:5173`) — already LAN-reachable and
macOS-firewall-allowed (proven working all session) — Vite makes the
`127.0.0.1:7861` hop itself, same-machine, entirely outside any firewall's
incoming-connection rules. **No sudo, no firewall changes, no direct
connection to port 7861 at all.**

**Namespaced under `/align-proxy`, not bare `/align`/`/transcribe`/`/health`,
on purpose** — bare `/health` is ALREADY proxied to the Worker (`:8600`) for
the "Cloud" connection's own health check. A first attempt used the bare app
origin as the align-server connection's `baseUrl`; its health check then
hit bare `/health` too, which wasn't proxied to anything, showing red/offline
even though `/transcribe` itself worked fine (verified separately by curl).
The fix: give the align server its OWN path prefix so its health check hits
its OWN `/health`, not the Worker's or nothing.

**In the app:** add a "remote" backend (Settings → Backends → Add remote
backend) whose URL is the app's origin **plus `/align-proxy`** — e.g.
`http://<mac-lan-ip>:5173/align-proxy`, not just the bare origin and not
`:7861`. Select it in the "Align server" picker
(`GlobalSettingsSheet.jsx`/`PlayerMenu.jsx`'s Audiobook Sync section) — just
adding the connection isn't enough, `prefs.alignConnectionId` has to actually
point at it. Verified: `GET http://<lan-ip>:5173/align-proxy/health` returns
the align server's own health JSON (not the Worker's), and `POST
.../align-proxy/transcribe` reaches the real align server and returns a real
FastAPI response — both via the LAN IP.

Also fixed along the way, though no longer load-bearing for phone access
specifically: `server.py` binds `0.0.0.0` by default now (`ALIGN_SERVER_HOST`
overrides), matching `vite.config.js`'s `server.host: true` — useful if
something ever needs to hit the align server's own port directly. What
turned out NOT to work on this Mac: macOS's Application Firewall CLI
(`socketfilterfw --add`/`--unblockapp`) refused with "firewall settings
cannot be changed in command line" even with `sudo` — likely an MDM-managed
restriction on this corporate Mac (see the MDM/Zscaler memory notes). The
GUI (System Settings → Network → Firewall) might still work if the proxy
approach above is ever insufficient, but wasn't needed once Vite's proxy
covered it.

When diagnosing "nothing seems to happen," check both services' own raw logs
directly for the expected request rather than guessing from symptoms alone —
that's what revealed neither the worker nor the align server had received
anything at all, pointing at a LAN-reachability problem rather than an
app-logic one.
