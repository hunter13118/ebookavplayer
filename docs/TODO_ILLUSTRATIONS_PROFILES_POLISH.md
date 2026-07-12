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

## 2. Character portraits should reference actual EPUB illustrations — DONE

**Status:** matching, cropping, and in-image name-caption detection are all
done. Update (2026-07-09): the original text-only matching pass that only
matched 2/13 plates (and mismatched at least one non-character plate) has
been replaced with a vision-first pass, plus a separate OCR pass for plates
that caption character names directly on the image (the "plate 8" case
below).

**Correction (2026-07-10) — a matched plate must NEVER become the rendered
character sprite.** The original design (this same doc, below) had
`applyDirectIllustrations` write a character's matched `illustration_ref`
straight onto `playback.characters[id].sprite` — meaning the raw EPUB plate
(often a multi-character scene, or a caption-sheet montage) became that
character's permanent portrait on stage. Confirmed live: "Lidy"'s portrait
was literally a two-character embrace illustration, and a character whose
plate happened to be a multi-face design-sheet rendered as a tiled mosaic.
Reference crops (`character.reference_images`) were never the problem here —
those were already correctly scoped to generation-only input (never
rendered directly, see item 2's cropping section below) — the bug was the
*whole-plate* `illustration_ref` path.

Fixed in `worker/_shared/illustrations.js`'s `applyDirectIllustrations`: a
character's matched plate now unlocks as an **illustration moment** on that
character's first line (`line.illustration_url`/`playback.inserts`, the same
data shape `illustrationGallery.js`'s `collectIllustrations` already reads
for the Illustrations panel) instead of touching `sprite` at all. This also
fixed a second, previously-invisible bug: automatic matches never populated
`line.illustration_url`, so the Illustrations panel showed "0 unlocked
visual moments" even when a raw plate was plainly on screen as a sprite —
moments and the direct-sprite path were two disconnected systems. They're
now the same system.

**Self-heal for already-corrupted stored books:** a book matched before this
fix has the bad plate URL stuck in its stored `playback.json` sprite fields
forever otherwise — `enrichPlaybackFromAnalysis`'s "reuse any existing
`/media/` sprite across a recompile" rule can't tell a real generated
portrait from a mistakenly-stored raw plate. Added `healRawPlateSprites`
(`compile-playback.js`) — resets any sprite matching a URL in
`analysis.illustration_urls` back to the placeholder gradient token. Wired
into `GET /books/:id` (`books.js`) in **both** branches (the
`enrichPlaybackFromAnalysis` recompile path, and the `hasMomentArt`
lightweight-patch path) — the latter matters because a book with moment art
(which this fix causes automatically now) skips the recompile branch
entirely, so the heal has to run independently of it. Verified live: Lidy
and Helen's sprites reset to gradient placeholders, Diana and Samya's real
generated portraits were untouched. Test: `tests/compile-playback-inserts.test.mjs`.

Scene *backgrounds* still use the raw plate directly (`sceneOut.background =
url` in `applyDirectIllustrations`) — unchanged, not something the user
flagged, and a full-scene backdrop is a reasonable direct use of a plate
unlike a character portrait.

Also fixed in the same pass: two duplicate, conflicting `.vae-sheet-backdrop`
CSS definitions in `web/src/styles.css` — a later, unconditional rule
(`align-items: flex-end`) silently overrode an earlier responsive one meant
to center the sheet as a dialog on desktop widths, so every sheet (not just
Illustrations) was stuck in mobile bottom-sheet layout regardless of
viewport. Consolidated to one definition; desktop (≥520px) now centers,
mobile still bottom-sheets. If a *stale PWA offline cache* is still serving
old CSS/JS on a given device, a hard refresh / re-caching the book is needed
separately — this app aggressively caches for offline reading
(`start:local`/VitePWA), so a code fix alone doesn't retroactively bust an
already-cached client bundle.

**Matching — DONE, now vision-first:**
`worker/_shared/illustration-character-match.js` exports
`matchPlatesToCharacters`, called from `POST
/books/:id/illustrations/match-characters`
(`worker/queue/illustration-character-match-consumer.js`, "Auto-match plates
to characters" button in Character settings). For each plate it:
1. **Vision pass** (`matchPlatesToCharactersVision`) — one call per plate to
   a local, vision-capable Ollama model (`OLLAMA_MODEL_VISION`, default
   `gemma3:27b` — already multimodal, no separate model pull needed) via
   `/api/chat` with the plate image attached. The model actually sees the
   plate's pixels (art style, features, clothing, setting) plus surrounding
   text, and can correctly say "not a character" for scenery/object plates —
   the root cause of the earlier text-only pass's bad matches (it explicitly
   could not see the image at all, "you cannot see it" was in its own system
   prompt).
2. **Text-only fallback** (`matchPlatesToCharactersTextOnly`) — the original
   heuristic, now used only for plates the vision pass couldn't resolve (no
   image bytes, or Ollama unreachable/erroring for that plate).

**Widened text context:** previously only the plate's own (often-useless)
nearby-HTML text plus the *next* chapter's opening 600 chars. Now also
includes the *preceding* chapter's last 500 chars — plates sit on their own
spine page between two chapters, so "who was just in this scene" context
often lives in the chapter before, not just the one the plate precedes.

A confirmed match applies immediately via the same `applyDirectIllustrations`
path a manual assignment uses — sprite/cover update included, verified live.
See `tests/illustration-character-match-vision.test.mjs`.

**In-image name-caption detection — DONE (the "plate 8" case):** some plates
label each pictured character's name directly on the image (a captioned
group shot). `scripts/local-image-server`'s new `POST /ocr_faces` (Tesseract
OCR + nearest-face pairing, `detect_and_crop_faces.py`'s
`crop_named_faces_from_bytes`) finds each name-like caption and pairs it with
its nearest detected face, returning a crop per confidently-paired face.
`illustration-character-match-consumer.js`'s `ocrNamedCropsForPlate` calls
this for every considered plate (regardless of whether the vision/text match
above found anything — a captioned group shot can name several characters at
once) and fuzzy-matches each label against the book's character roster
(`fuzzyMatchCharacterName` — substring-tolerant, since Tesseract on small
in-image text frequently drops a leading/trailing character, e.g. "Elara"
read as "lara"). Each confidently-matched label's crop is stored directly as
that character's reference image — no whole-plate face-detection fallback
needed, since OCR already paired the right face to the right name. Requires
`brew install tesseract` + `pip install pytesseract` (see
[LOCAL_IMAGE_GEN.md](LOCAL_IMAGE_GEN.md)'s Setup section). See
`tests/illustration-plate-ocr.test.mjs`.

**Cropping — DONE.** Corrected an earlier claim in this doc that no image
manipulation capability existed in the codebase — it did: a local Stable
Diffusion server (`scripts/local-image-server/server.py`,
[docs/LOCAL_IMAGE_GEN.md](LOCAL_IMAGE_GEN.md)) already had a working
anime-face detector (`detect_and_crop_faces.py`, `lbpcascade_animeface`) and
IP-Adapter reference-image support, just not wired into this flow. Wired up:
- `LOCAL_IMAGE_MODEL=animagine-xl` (`.env`/`.env.example`) — the profile
  with IP-Adapter support; `sdxl-turbo` doesn't have one.
- `POST /crop_faces` on the local-image-server — takes `image_b64`, returns
  base64 PNG crops via `crop_faces_from_bytes` (new function alongside the
  existing file-path-based `detect_faces`).
- `cropAndStoreReference` in
  `worker/queue/illustration-character-match-consumer.js` — after a plate is
  matched to a character, POSTs the raw plate bytes to `/crop_faces`, stores
  the first crop to `media/{bookId}/character-refs/{charId}/` in R2, and
  patches it onto `character.reference_images` (the same field
  `CharacterManager`'s upload UI writes to). Best-effort: no
  `LOCAL_IMAGE_URL`, an endpoint error, or zero detected faces in the plate
  all skip cleanly rather than failing the match job — the whole-plate
  `illustration_ref` (already applied) is a fine fallback on its own.
- `tryLocalSd` (`worker/_shared/freemium-image.js`) now sends
  `reference_image_b64`/`ip_adapter_scale` when references are available, so
  a cropped reference actually reaches generation instead of just sitting in
  storage.
- Verified: `/crop_faces` tested directly against real Volume 6 plates
  (correctly finds faces in some, correctly finds none in plates that are
  full-scene shots without a clear face — expected Haar/LBP-cascade
  behavior, not a bug). The crop→R2-store→`reference_images`-patch chain is
  covered by `tests/illustration-character-crop.test.mjs` with a mocked
  `/crop_faces` response, independent of any one book's plates happening to
  have a detectable face.

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

**Managing reference images (remove + pick-from-existing-crops) — DONE
(2026-07-10).** Once auto-matching actually started working (item 2 above),
a real book accumulated redundant near-duplicate crops on one character
(re-running the match job doesn't dedupe by *visual* similarity, only by
exact URL — see `MAX_REFERENCE_IMAGES` note in `character-merge.js`) and at
least one outright mismatched crop. Needed a way to clean that up, plus a
way to fix a mismatch by picking the *correct* character's crop instead of
manually re-uploading a file.

- `removeCharacterReferenceImageInAnalysis`/`InPlayback`
  (`character-merge.js`) + `DELETE /books/:id/characters/:charId/reference-image`
  (body `{url}`) — detaches one image from a character's list. Leaves the R2
  object alone (cheap, and it may still be a valid crop for a *different*
  character) — this is a pointer removal, not a hard delete.
- `POST /books/:id/characters/:charId/reference-image/assign` (body `{url}`)
  — attaches an *already-stored* media URL to a character, reusing the same
  `addCharacterReferenceImageInAnalysis`/`InPlayback` the upload endpoint
  uses. Guarded to only accept this book's own `/media/{bookId}/...` URLs
  (same SSRF-avoidance reasoning as the upload endpoint).
- `GET /books/:id/character-crops` — every reference image currently
  attached to *any* character in the book, each tagged with its current
  `owner_id`/`owner_name`. No separate R2 listing needed: every crop this
  app ever stores gets added to some character's `reference_images` at
  creation time, so the union of every character's list already is the
  complete set.
- `CharacterManager.jsx`: each reference thumbnail now has a small "×"
  overlay to remove it, plus a new "⌸ pick from existing crops" button next
  to upload (`CropPicker`) — opens a grid of every other crop in the book
  (lazily fetched, excludes ones this character already has), tagged with
  its current owner; clicking one assigns it here immediately. This is the
  "I know the right crop is sitting on the wrong character, let me just grab
  it" flow instead of a re-upload.
- Verified end-to-end live: removed a redundant Anne crop (8→7), reassigned
  a Helen crop to Anne via the picker (7→8), confirmed via the API's stored
  `reference_images` array both times. Tests:
  `tests/character-reference-images.test.mjs`.

**Full-size preview lightbox — DONE (2026-07-10).** The reference/crop
thumbnails above are 44-60px — too small to tell who's actually pictured,
which defeats the point of managing them. `ImageLightbox` (exported from
`CharacterManager.jsx`) opens on click instead of acting immediately: shows
the image full-size, with an optional action slot below it. Used in three
places — the reference-pictures grid (click → preview, with a "Remove this
reference" button right there), the per-character `CropPicker` (click →
preview tagged with current owner, "Use this for {name}" to confirm — no
longer assigns blindly on first click), and the crop catalog below. Verified
live: a crop that looked like a plausible thumbnail turned out, at full
size, to be an unrelated hooded/masked figure with dialogue text baked in —
exactly the kind of mismatch this was built to catch.

**Crop catalog replacing the raw-plate gallery + manual plate mapping —
DONE (2026-07-10).** Removed the old "EPUB plate mapping" section (a
per-character dropdown picking which *whole raw plate* is that character's
portrait) and the raw-plates preview grid — a raw plate is rarely a clean
single-character portrait (see item 2's "never onto character.sprite" fix
above), so crops are the right unit for "who is this," not whole plates.
Replaced with `CropCatalog.jsx`: a book-wide grid of **every** crop ever
stored, mapped or not — click to preview (`ImageLightbox`) and assign to any
character or remove from its current owner, right there.

- `GET /books/:id/character-crops` changed from "union of every character's
  `reference_images`" to an actual `env.VAE_PACKS.list({prefix:
  "media/{id}/character-refs/"})` R2 listing, cross-referenced against
  `reference_images` for `owner_id`/`owner_name` (`null` = unassigned).
  Needed because a crop detached via the DELETE endpoint above (or one that
  was created but fell off a character's 8-image cap after repeated
  auto-match runs — `MAX_REFERENCE_IMAGES` evicts oldest-first) was
  otherwise invisible even though it still exists in storage. Also exposes
  `stored_under` (the R2 folder it was originally cropped into, which can
  differ from `owner_id` after a reassignment).
- The still-useful "Re-scan EPUB for plates" / "Auto-match plates to
  characters" trigger buttons stayed — they're what *populates* the crop
  catalog. The cover-art plate picker also stayed (a whole plate is a
  legitimate book cover, unlike a character portrait) but now saves just
  `cover_illustration_ref` on its own instead of bundling per-character
  mappings into the same PATCH.
- Trimmed `illustrationCatalog.js`: `plateAssignmentMap`/
  `characterIllustrationRefs` deleted (only existed for the removed
  section); `listIllustrationPlates` stayed for the cover picker.
- Verified live on a real book: the catalog surfaced 32 stored crops, 30 of
  them "Unassigned" (fallout from re-running auto-match repeatedly during
  this session's testing — each run's fresh crops evicted older ones off
  the 8-image cap, but the R2 files never got cleaned up) — exactly the
  "orphaned crop" visibility problem this feature exists to solve. Assigned
  one to a character live, confirmed it updated instantly. Tests updated in
  `tests/character-reference-images.test.mjs` to cover the "unassigned crop
  still shows up" case specifically.

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

**Update (2026-07-12) — two bugs fixed, both confirmed live:**
1. **Model continuity.** `runExpressionRepass`'s `preferProvider` always
   soft-defaulted to `"ollama-7b"` regardless of what actually extracted the
   book — a book extracted on `ollama-30b` got re-tagged on the cheaper 7b
   model, a plausible quality regression for no reason. Fixed in
   `expression-repass-consumer.js` to default to the book's own
   `extract_provider` (`env.VAE_JOBS`'s `book:{id}` record) when the caller
   doesn't explicitly pass one — mirrors the existing
   `re-extract-consumer.js:54` precedent
   (`prefer_provider || (force_provider ? null : meta.extract_provider)`).
   Verified live: triggering a repass on a book with `extract_provider:
   "ollama-30b"` loaded `qwen3:30b-a3b` in `ollama ps`, not the 7b model.
2. **Stale catalog status.** The consumer's success/error paths only ever
   patched `active_job_id: null` onto the book index — never `status`/
   `stage`/`progress`/`detail`. A finished (or failed) repass left the
   catalog showing whatever the job's *first* progress tick was (`stage:
   "expression-repass", progress: 0.02, detail: "Loading book"`)
   indefinitely, because `worker/_shared/imaging-lock.js`'s reconciliation
   only re-syncs those fields from the live job while `active_job_id` is
   still set — once it's cleared, nothing corrects the stale snapshot.
   Fixed by writing `status: "ready", stage: "done", progress: 1, detail`
   (and `error` on failure) on both terminal paths, same shape other
   consumers (`illustration-character-match-consumer.js`, etc.) already use.

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
