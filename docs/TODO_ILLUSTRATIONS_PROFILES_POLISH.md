# TODO: illustration backfill, character reference profiles, and player polish

Handed off from a session that did local-extraction speed/reliability work
(chunk sizing, `think:false`, scene continuity, parallel imaging, a resume-
provider bug, an offline-cache-on-still-processing-book bug) and ran out of
turn budget before touching any of this. Nothing below has been implemented
or even prototyped — this is a scoped brief, not a partial patch. Everything
under "Confirmed" was actually checked via grep/read against the live repo;
everything under "Suspected / needs investigating" is the user's own
observation, not yet independently verified.

Test book in play during the handoff session: "My Quiet Blacksmith Life in
Another World" Vol 4 and Vol 6 (`book_id`s `book` and
`My-Quiet-Blacksmith-Life-in-Another-World---Volume-06-J-Novel-Cl`), both
mid-extraction via local Ollama. Good real test subjects if they're still
sitting in the local KV/R2 store — both are light novels with real embedded
illustration plates, which is exactly what surfaced item 1 below.

---

## 1. EPUB illustrations aren't showing up in the extracted book

**User's observation:** "the extraction process seemed to completely miss
the illustrations spread throughout the book."

**Confirmed:** the pipeline for this already exists and runs unconditionally
(not behind a flag that defaults off):

- `worker/_shared/epub-images.js`'s `extractEpubImages(bytes, {maxImages})`
  pulls image plates out of the EPUB
- `worker/_shared/reference-images.js`'s `persistEpubImages(env, book_id, epubImages)`
  writes them to R2
- Both are called unconditionally near the top of `runCheckpointedExtraction`
  in `worker/_shared/chapter-extract-pipeline.js` (~line 90-95), gated only by
  `VAE_EPUB_MAX_IMAGES` (0/unset = no cap, extracts everything found — not a
  reason for zero results)
- `illustrationsByChapterPos` (built right after) matches each plate to the
  chapter it lives in via `spine_path`, and gets threaded into the extract
  prompt as "ILLUSTRATION PLATES near this chapter" (see
  `worker/_shared/freemium-extract.js`'s `formatIllustrationsNearby` /
  `getChapterIllustrations`) — the *model* is supposed to set
  `illustration_ref` on a character/scene/line when a plate's nearby text
  clearly matches something it's extracting
- `illustration_mode` (`ILLUSTRATION_MODE` env var: auto/reference/moment/
  direct-use, see `normalizeIllustrationMode` in `worker/_shared/illustrations.js`)
  controls what happens with a matched plate — `direct-use` renders the
  actual plate in the player, `reference` mode is meant to feed it to image
  generation as a style/likeness reference, `moment` inserts it as a flash
  illustration on a dialogue line

**RESOLVED — root cause found and fixed:** `extractEpubImages` was finding
everything correctly (14/14 plates on the real test book) — the bug was in
the spine-path matching. Illustration plates in a real J-Novel Club EPUB
live on their own dedicated spine pages (`insert1.xhtml`, `Color1.xhtml`,
`bonus1.xhtml`, ...) sitting *between* chapter files in spine order, not
embedded inside a chapter's own file. The original match
(`chapters.findIndex(c => c.spine_path === meta.sourcePath)`) required exact
equality against a *chapter's* spine_path, so it could never match a plate's
own separate spine page — confirmed directly against the real EPUB: only 1
of 14 plates matched, meaning `illustrationsByChapterPos` was built almost
completely empty and the model was never even shown 13 of the 14 plates (not
a "too conservative" model behavior issue, a plumbing issue upstream of the
model entirely).

Fixed by walking the full spine order (`orderedPaths`, now returned from
`extractEpubText`) and attaching each plate to the next real chapter that
follows it in spine order — matches this EPUB format's convention of a plate
introducing the chapter it precedes. A plate with no following chapter
(trailing back-matter: color inserts duplicated at the end, bonus content,
sign-up pages) is left unmatched rather than guessed at. New
`matchIllustrationsToChapters` in `chapter-extract-pipeline.js`, tested in
`tests/illustration-chapter-matching.test.mjs` with a fixture EPUB
reproducing the exact interleaved-plate-page spine shape. Verified against
the real book: 13/14 plates now match (only the cover, which has no source
spine page at all, stays unattached — expected).

`ILLUSTRATION_MODE=auto` is what's configured locally (`.env`/`worker/.dev.vars`).

**Still open — model-behavior question, not a plumbing bug:** now that
plates actually reach the prompt, does the model reliably set
`illustration_ref`? Not yet re-verified end-to-end (would need a fresh
extraction run past the point this fix landed) — check a freshly-compiled
`books/{id}.analysis.json` for non-null `illustration_ref` fields once one's
available. If it's still sparse, the prompt's "only when clearly matching"
instruction may need loosening.

**What's wanted, once the above is diagnosed:**
1. Bake illustration extraction into the baseline extraction pass — it may
   already be "baked in" architecturally; the fix might just be unblocking
   whatever's silently failing above, not building new plumbing.
2. A **manual backfill button** — for a book that already finished
   extracting without illustrations (or where this pass failed/wasn't run),
   trigger the same illustration-extraction + matching pass after the fact.
   Needs: re-open the stored EPUB bytes (`loadStoredEpubBytes`, already used
   elsewhere), re-run `extractEpubImages`/`persistEpubImages`, re-run the
   matching logic against the *already-compiled* analysis (matching plates to
   already-extracted scenes/characters instead of matching during a fresh
   extraction chunk-by-chunk — this is a different code shape than the
   inline version and will need its own pass, not a direct reuse of
   `chapter-extract-pipeline.js`'s inline version).
   - Surface this button in **two places**: the "Illustrations" panel (
     `web/src/components/IllustrationGallerySheet.jsx`, opened via the
     "Illustrations" button in `Player.jsx` ~line 1110) and from the Library
     screen (per-book action, likely alongside the existing bulk-action bar
     in `Library.jsx` or a per-card menu).
   - Should also grab the EPUB's own cover image and set it as the book's
     cover (`epub-images.js`/`epub-text.js` likely already has cover
     detection given `epubExtract.cover_index` is referenced elsewhere in
     `chapter-extract-pipeline.js` — check what that's currently used for).

## 2. Character portraits should reference actual EPUB illustrations — PARTIALLY DONE

**Status:** the "who's pictured" matching pass is done and verified
end-to-end. Cropping is not — see below for exactly why, and what it needs.

**Matching — DONE:** `worker/_shared/illustration-character-match.js`'s
`matchPlatesToCharacters` is a targeted, separate LLM read (not the main
extraction prompt) run via `POST /books/:id/illustrations/match-characters`
(`worker/queue/illustration-character-match-consumer.js`, "Auto-match plates
to characters" button in Character settings). Re-parses the stored EPUB
(cheap, no LLM) to recover plate/chapter association via the existing
`matchIllustrationsToChapters`, then asks per-chapter: given the known
character roster and text context, which character (if any) does each plate
depict — told explicitly not to guess. **Real finding while building this:**
a plate's own nearby text (`textNear()` in `epub-images.js`) is frequently
useless on its own — plates conventionally live on their own dedicated,
nearly-empty spine page (just an `<img>` tag), so the captured "context" is
often that page's own XML boilerplate, not narrative prose. Fixed by also
feeding the model the opening of the chapter the plate was matched to
(`parsed.chapters[chapterPos].text`) — confirmed this is what actually makes
matches possible; the plate-only-context version matched 0/13 plates on a
real book, the chapter-text-grounded version matched 2/13 (a modest but
real, honest number — the system is designed to decline rather than
false-positive). A confirmed match applies immediately via the same
`applyDirectIllustrations` path a manual assignment uses — sprite/cover
update included, verified live.

**Cropping — NOT DONE, genuine infrastructure gap:** there is no image
manipulation capability anywhere in this codebase — no canvas/sharp
equivalent, no WASM image library, no Cloudflare Images binding configured.
Doing this for real needs one of:
- A vision-capable model call that returns a face bounding box, plus an
  actual pixel-cropping step to apply it (Workers doesn't have a native
  crop primitive; would need a WASM image library like `photon-rs`, or an
  external image-processing service/binding).
- Cloudflare Images (if enabled on the account) can crop via URL transform
  params without needing an in-Worker image library at all — the more
  realistic first cut if this is prioritized, since it sidesteps the "no
  image lib" gap entirely.
Until one of these lands, a matched plate is used **whole** as the
character's reference (not face-cropped) — better than nothing, and already
wired into `referenceTargetsForCharacterWithStylePool` via the confirmed
`illustration_ref`, but not the tight, face-only reference originally asked
for.

## 3. Character profile viewer/editor UI — DONE (description + uploaded references)

**Implemented:** `CharacterManager.jsx` now shows, per character: a portrait
thumbnail (falls back to an initial when the sprite is still a placeholder
gradient token or the image 404s), an editable **description** textarea, and
a **reference pictures** grid with upload — exactly the "user-editable
description + uploaded reference pictures" half of the original ask.

- `setCharacterDescriptionInAnalysis`/`InPlayback` (`worker/_shared/character-merge.js`)
  + `PATCH /books/:id/characters/description` — same pattern as the existing
  temperament setter.
- `addCharacterReferenceImageInAnalysis`/`InPlayback` (same file) +
  `POST /books/:id/characters/:charId/reference-image` (multipart upload) —
  stores to R2 under `media/{id}/character-refs/{charId}/`, recorded as
  `character.reference_images` (capped at 8, most-recent-wins). Deliberately
  **not** routed through `external-refs.js`'s URL-fetch mechanism — that
  one's SSRF host-blocklist would strip a same-worker URL right back out
  (confirmed while building this: `localhost` is blocked by design there,
  which is correct for user-typed URLs but wrong for a URL this worker just
  generated itself).
- Verified end-to-end live: description round-trips through the PATCH
  endpoint and persists; an uploaded PNG round-trips through the POST
  endpoint, is retrievable via `GET /media/...`, and renders in the grid.

**Not yet done — genuinely separate, deferred:**
- Alt-expression sprites and EPUB-illustration crops in the viewer (needs
  item 2 below to exist first — nothing to show yet).
- Reference images aren't wired into image generation as a reference source
  yet (`edge-imaging.js`'s `referenceTargetsForCharacterWithStylePool` would
  need to also read `character.reference_images`, not just `external_refs`).

## 4. A unified "illustration + character-reference" extraction pass

**What's wanted:** items 1-3 aren't three separate features — the user
wants **one pass** that does all of it together:
- Runs **automatically** during initial EPUB extraction — "perhaps per
  chapter" (i.e. hook it into `onChapterComplete` in
  `chapter-extract-pipeline.js`, same place `chapter-imaging` parallel art
  generation got hooked in this session, or as its own phase)
- **Also** runs manually/retroactively on an already-extracted book, for
  when the automatic pass fails or wasn't enabled
- Populates: the illustrations catalog (item 1), AND character
  profiles/references (items 2-3)

This is the biggest open design question in this doc. Worth deciding early:
is this ONE new pipeline stage that does illustration-matching +
who's-pictured + cropping + reference-attaching all in one LLM round-trip
per plate, or several smaller composable steps? Given how many other
passes this session built as separate opt-in queue-driven stages
(`chapter-imaging`, `expression-repass`, `imaging-regen`), the precedent in
this codebase leans toward: **one dedicated queue/consumer for this**,
gated behind its own env var (e.g. `VAE_ILLUSTRATION_BACKFILL`), following
the `chapter-imaging-consumer.js` / `imaging-regen-consumer.js` pattern
(separate queue binding in `worker/wrangler.toml`, dispatched via
`worker/queue/dispatch.js`'s `kind` router).

## 5. Retroactive expression re-tag pass (separate from illustrations, same shape) — DONE

**Implemented:** `POST /books/:id/expression-repass` (`worker/api/v1/book-actions.js`'s
`onExpressionRepassPost`) queues a `kind: "expression-repass"` job, handled by
the new `worker/queue/expression-repass-consumer.js`. Operates directly on
the compiled `books/{id}.json` playback's `scenes` (confirmed its line shape
— `kind`/`character_id`/`text`/`expression`/`intensity` — matches what
`runExpressionRepass` already expects from the analysis-stage call site, no
translation needed). Batches scenes 8 at a time (`SCENES_PER_BATCH`) rather
than one giant call over the whole book's lines, since a full book can have
thousands of dialogue lines; each batch is best-effort (a failed batch keeps
its original tags rather than failing the whole pass, same spirit as the
automatic per-chapter trigger). UI trigger: "Re-tag expressions" in
`PlayerMenu.jsx`, right next to "Re-extract script" in the Art style section
— exactly where item 5 originally asked for it. Verified end-to-end live
(job reaches `status: "done"`, playback scenes updated).
- **Where:** user asked for this "somewhere in the menu around the 'generate
  art' button" — that's `PlayerMenu.jsx` / `ArtStyleSwitcher.jsx`'s
  neighborhood.

## 6. Chapter titles showing as generic "Chapter N" instead of the real EPUB title

**Root cause CONFIRMED — this is a one-line field-name mismatch, not missing
data:**

- `web/src/chapterNav.js`'s `chapterLabel(ch, chapterMeta)` (line ~69) does:
  ```js
  const meta = (chapterMeta || []).find((m) => m.chapter === ch.chapter);
  if (meta?.title) return `Ch. ${ch.chapter}: ${meta.title}`;
  return `Chapter ${ch.chapter}`;
  ```
  It looks for a field called **`.chapter`** on each `chapterMeta` entry.
- But `chapter-extract-pipeline.js` (~line 408) builds the compiled
  `book.chapters` array as:
  ```js
  chapters: parsed.chapters.map((c) => ({ index: c.index, title: c.title })),
  ```
  Each entry has **`.index`**, not `.chapter`. `epub-text.js` confirms
  `parsed.chapters` entries are built with `.index` throughout (`chapters.push({ ...part, index: part.index ?? idx, ... })`).
- So `chapterMeta.find((m) => m.chapter === ch.chapter)` **never matches
  anything** (`m.chapter` is always `undefined` on every entry) — it always
  falls through to the generic `Chapter ${ch.chapter}` string, even though
  the real title (e.g. "Ordinary Days in the Black Forest" — confirmed
  present in this session's own worker logs as `chapterTitle`) was extracted
  correctly and is sitting right there in `book.chapters[i].title` the whole
  time.

**The fix is small:** change `chapterLabel` to match on `.index` (or
whatever field the caller actually passes — check both call sites,
`PlayerMenu.jsx:409` and `Player.jsx:1072`, pass the same `book.chapters`
shape) instead of `.chapter`. Confirm `ch.chapter` (the *other* side of the
comparison, coming from wherever `ch` is built — `chapterAtLine`/
`chapterRelativeIndex` in the same file) is the right value to match against
`.index` — likely just needs `m.index === ch.chapter` instead of
`m.chapter === ch.chapter`. Write a quick test in whatever
`chapterNav.test.js` exists (check first) before shipping.

**Bonus ask:** once real titles show up, this should also help distinguish
a real "Chapter 1" from a Prologue that currently gets mislabeled/confused
as Chapter 1 — worth confirming `epub-text.js`'s chapter-splitting logic
actually treats a Prologue/Foreword spine section as its own chapter entry
(with its own real title) rather than merging it into "Chapter 1", since
that's a separate potential bug from the label-rendering one above.

## 7. Director's Log should be a toggle, off by default

**Confirmed:** `web/src/components/DirectorsLog.jsx` line 11:
```js
if (!import.meta.env.DEV || !line) return null;
```
Currently gated purely on dev-build (`import.meta.env.DEV`) — always on in
every dev session, no user control, and would never show in a production
build regardless. **Wanted:** a real user-facing toggle, defaulting off,
that works in both dev and prod builds (since it's a legitimately useful
debugging tool for tuning expression tags, not just a dev-only artifact).

- Follow the `performanceMode` pattern already in
  `web/src/audio/voicePrefs.js` (a `getPrefs()`-backed localStorage key) and
  `web/src/components/AppSettingsSections.jsx` (where the Performance Mode
  dropdown lives in Settings → Display) — add a `directorsLog: boolean` pref
  the same way, default `false`.
- `Player.jsx` already threads `performanceMode` into `DirectorsLog` — thread
  the new toggle value in the same way, replacing the `import.meta.env.DEV`
  check with the user preference.

## 8. Sprite portraits overlap the dialogue/text box

**Confirmed the two CSS rules in play** (`web/src/styles.css`):
```css
.vae-sprite { position: absolute; left: var(--slot-x, 50%); bottom: 16%; ... }
.vae-sprite-art { width: clamp(90px, 16vw, 180px); aspect-ratio: 3/4; ... }
.vae-dialogue { position: absolute; left: 4%; right: 4%; bottom: 4%; ... }
```
Sprites are bottom-anchored at a fixed 16% from the stage bottom, with a
responsive height up to ~240px (180px width * 4/3 aspect ratio). The dialogue
box is separately bottom-anchored at 4%, height driven by however much text
wraps (2-3+ line dialogue can grow tall). On some viewport sizes /
long-dialogue lines, the dialogue box's top edge can move up past the
sprite's bottom edge. **Wanted:** guarantee they never overlap — either
raise `.vae-sprite`'s `bottom` percentage enough to always clear a
reasonably-tall dialogue box, or make the stage's sprite-container height
dynamically aware of the dialogue box's actual rendered height (more robust,
more work). Needs live visual iteration in the browser (resize viewport,
test with a long multi-line dialogue string) to land on the right values —
not something to just guess a new percentage for blind.

---

## Suggested order of attack

1. **Chapter titles (#6)** — smallest, most precisely scoped, already has a
   confirmed root cause and likely fix. Good first PR to warm up on this
   codebase.
2. **Director's Log toggle (#7)** and **sprite positioning (#8)** — small,
   independent, no backend changes, easy wins.
3. **Illustration extraction investigation (#1)** — figure out why the
   existing pipeline isn't surfacing anything before building the backfill
   button on top of it; building a backfill button for a pipeline that's
   silently broken just gives you a backfill button that also does nothing.
4. **Backfill buttons (#1 cont'd, #5)** — once #1's root cause is fixed,
   these follow the same shape as `imaging-regen`/`chapter-imaging` already
   built this session; should go quickly once the pattern's warmed up.
5. **Character reference profiles + viewer UI (#2, #3, #4)** — the biggest,
   least-scoped item. Recommend a proper plan/design pass before writing
   code, given how much this touches (new UI, new data model on the
   character record, new LLM pass, new crop/reference-attach mechanism).
