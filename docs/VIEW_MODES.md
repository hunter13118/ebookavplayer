# View modes (one spine, three renderers)

Status: **view architecture + reader landed and verified.** Spotlight (middle
mode), inline illustrations, and the window-level notification are next (§5).

The player can render a book three ways. The key architectural fact: **all three
are renderers of the same `Orchestrator` state stream**, so switching between
them is a crossfade, not a reload — the audio never stops and the text stays in
sync across the switch.

```
                       ┌─────────────────────────────────────┐
   audio source  ──►   │  ORCHESTRATOR (the one clock)        │
  (Edge TTS / m4b /    │  onState{ index, line, speakerId,    │
   silent estimate)    │          revealed, currentTimeMs }   │
                       └───────────────┬─────────────────────┘
                                       │  same state, every mode
              ┌────────────────────────┼────────────────────────┐
              ▼                        ▼                        ▼
        CINEMATIC (now)         SPOTLIGHT (next)           READER (now)
       Stage: bg + full        bg + speaking sprite       paginated text +
       cast + DialogueBox      + bubble (middle mode)     karaoke + dim bg
```

Because the orchestrator owns the clock and every audio path funnels through its
uniform `onState` (`web/src/audio/orchestrator.js`), a view is pure
presentation. That's why the **reader works for EVERY audio source** — Edge TTS,
silent estimate, per-line m4b, continuous acoustic m4b — with no per-source code:
"whether we're using Edge TTS or not is irrelevant."

## The `viewMode` axis

`prefs.viewMode` (`voicePrefs.js`): `"cinematic" | "spotlight" | "reader"`,
default `cinematic`. Orthogonal to the existing `displayStyle` (dialogue-box
skin) and `uiMode` (simple/full density). Persisted like every other pref
(`setPref(KEYS.viewMode, …)` + `setPrefs`).

A toolbar button (`data-testid="view-toggle"`) cycles it. Player wraps the active
view in `<div className="vae-viewport" key={viewMode}>`; keying by `viewMode`
remounts on switch and replays the `vae-viewfade` crossfade (respects
`prefers-reduced-motion`). The orchestrator is untouched by the swap, so playback
continues seamlessly.

## Reader view (`web/src/reader/ReaderView.jsx`)

Surface only — playback controls come from the surrounding Player chrome. It:

- **Re-flows lines into paragraphs** (`reader/paragraphs.js`) before anything
  else — per-line (~per-sentence) extraction means each narration sentence and
  each narration/dialogue transition is its own `line`, so naively rendering
  one `<p>` per line reads as fragmented, not like a book. `groupIntoParagraphs`
  merges consecutive narration into one flowing paragraph, keeps a dialogue
  line together with its short attribution tag ("she asked, her tone
  dubious."), splits at a genuine new speaker turn, and re-inserts quote marks
  around dialogue (stripped during extraction for cinematic staging). Pure
  heuristic over data every book already carries (`kind`, `character_id`,
  trailing punctuation) — no pipeline changes. A line with no `kind` (a raw
  M4B-first transcript before retro-extraction) just keeps flowing as
  narration; the SAME grouper gets more accurate for free once retro-extraction
  adds real attribution. Forces a break on every scene change
  (`sceneOf`, passed from `Player.jsx`'s `flatten()`), and also once a
  paragraph's accumulated text passes `MAX_PARAGRAPH_CHARS` (400) — a long run
  of pure narration has no dialogue/scene change to force a break otherwise,
  so it would merge into ONE paragraph of unbounded size. Since pagination
  can't split a paragraph across pages, an unbounded merge could end up many
  times taller than any page and get silently clipped by the reader stage's
  `overflow:hidden` — observed in practice on a real book (one paragraph hit
  3196 characters / ~2700px tall against a ~680px page, overflowing by
  ~2000px). The cap also made tap-to-seek and the skip-forward button useful
  again on long passages: both effectively resolved to "the start of this
  giant blob" before, and now resolve to a much smaller one.
- **`syntheticSegment.leading`** (WhisperX gap detection, m4b continuous
  playback only — see `web/src/timing/ARCHITECTURE.md`'s gaps section) tells
  the reader whether an audio-only "gap" (e.g. a publisher's spoken intro)
  plays before or after the paragraph the orchestrator is pinned to, so a
  leading gap splices in BEFORE that paragraph instead of always after —
  matching playback order instead of always trailing it.
- **Paginates** the resulting paragraphs (not raw lines) to fit the viewport at
  the user's font size (`pagination.paginate`, measuring each paragraph
  offscreen). Font ± via `prefs.readerFontSizePx`; re-paginates on font/size/resize.
- **Tap a paragraph to resume** — jumps to its first underlying line
  (`onSeekLine(para.startLine)`).
- **Karaoke bolden from `revealed`** — the orchestrator emits `revealed` (chars
  typewritten through the active line) in *every* mode, so `revealFromChars`
  (`reader/karaoke.js`) derives the active word + wipe uniformly. Past sentences
  render fully read, the active one word-by-word, upcoming ones dim.
- **Auto page-turn / auto-scroll** — the page containing the active paragraph is
  shown; it turns itself as narration crosses a page boundary
  (`pagination.pageOfLine`, keyed off `paragraphIndexOfLine`).
  `resumeFromLine(i)` (Player.jsx) seeks AND plays from a tapped paragraph's
  first line — deliberately *distinct* from generating an image (§5), so a
  resume tap can never trigger a generation.
- **Dimmed scene backdrop** — the current scene's art at low opacity behind the
  text (`prefs.readerDimBackground`, toggleable), with a legibility scrim.
- **Front/back-matter art + inline illustrations** — order of operations is
  outside-book narration (the leading m4b gap, above) → front-matter art →
  real chapter text (with inline illustrations at their real positions) →
  back-matter art. Until this feature, the reader had *no* illustration
  rendering at all — not just front/back matter, not even regular per-line
  ones — despite cinematic/Stage already having it via `IllustrationFlash.jsx`
  + `Player.jsx`'s `activeFlash`/`flashActive`/`flashDismissSignal` state
  (auto-triggered whenever the active line's `illustration_url` changes,
  already view-mode-independent — it just was never rendered here). Now:
  - `book.front_matter`/`book.back_matter` (`[{url}]`, no line attached at
    all) come from `matchIllustrationsToChapters`
    (`worker/_shared/chapter-extract-pipeline.js`) bucketing plates whose
    spine position falls before the first real chapter (cover, character
    gallery, title page, copyright, TOC — a real light-novel EPUB's front
    matter) or at/after a `splitBackMatter`-popped trailing chapter
    (`worker/_shared/epub-text.js` — a publisher newsletter/ad page, which
    used to become a fake final "chapter" sent through real LLM extraction).
    Resolved to real URLs by `illustrations.js`'s `applyDirectIllustrations`
    from `analysis.front_matter_refs`/`back_matter_refs`, and preserved
    across every recompile by `compile-playback.js`'s
    `enrichPlaybackFromAnalysis` (same reasoning as `cover`).
  - `reader/ArtGallery.jsx` sequences a `[{url}]` list one image at a time via
    `IllustrationFlash` — front-matter fires the moment the book is at its
    genuine start (`activeIndex 0`, nothing revealed yet) and overlays
    whatever's already playing underneath (so it never blocks real audio);
    back-matter fires once `finished`. Each "armed" only once per book
    (`lines` identity) so rewinding back to line 0 doesn't replay the intro.
  - `IllustrationFlash.jsx` gained a `holdMs` prop (reader uses
    `READER_ART_HOLD_MS`=10s, longer than cinematic's default 5s — front
    matter plays out alongside the m4b's spoken intro) and scroll-to-dismiss
    (`onWheel`/`onTouchMove`) alongside the existing tap-to-dismiss, both
    triggering the same fade-out-then-advance path so a manual skip looks
    identical to an auto-advance, just sooner.

### Verified
An EPUB book (Edge TTS) in the real app: cinematic → reader mid-playback with
audio uninterrupted, karaoke picking up at the exact position (active word caught
mid-wipe), dimmed palace backdrop, auto page-turn, tap-to-resume jumping playback
to the tapped paragraph, and the round-trip back to cinematic. Cold-loads into
either mode (pref persists). Paragraph grouping verified against the real book's
actual line data (narration runs merge, dialogue+tag pairs stay together with
quote marks restored, scene changes force a break). 444 web tests green.

### Relationship to the M4B-first reader
The standalone `KaraokeReader.jsx` (M4B-first harness, `docs/M4B_FIRST_FLOW.md`)
owns its own clock for the `?karaoke-demo` fixture. `ReaderView` is the canonical,
orchestrator-driven reader. When the M4B upload flow is wired (M4B_FIRST §6), the
transcript feeds the orchestrator (`setTimeline` + acoustic path) and the M4B
path renders through `ReaderView` too — converging on one reader.

## Next (build order from the design discussion)

1. ✅ View architecture + smooth toggle (this doc).
2. **Illustrations inline + dim bg** — render `line.illustration_url` as an inline
   block in the reader's text flow (like a real book); more generated → more
   plates. (Dim bg already landed.)
3. **Spotlight (middle) mode** — `SpotlightStage`: scene bg + only the
   `spotlightCharacterId` sprite + `DialogueBox`. The cinematic layer minus the
   supporting cast.
4. **Window-level job notification** — a `position: fixed` toast portaled to
   `document.body` (outside the scroll container, so it can't jolt scroll),
   driven by the job-event SSE stream.
5. **Gutter "generate image" affordance** — a margin control on the active line,
   distinct from the resume tap.

## Synergistic enhancements (from `docs/04_FUTURE_IDEAS_AND_IMPLEMENTATION.md`)
Ranked by impact ÷ effort against these views: **#53 POV narrator-link** (makes
spotlight land for first-person LNs — the majority of the corpus), **#5 Media
Session API** (lock-screen/car controls for the reader's commute use case), and
the **minimal-view accessibility trio** (#3 bionic, #4 OpenDyslexic + spacing,
#37 reading ruler — the owner is dyslexic; synced highlight-during-audio is a
top-evidenced reading aid).
