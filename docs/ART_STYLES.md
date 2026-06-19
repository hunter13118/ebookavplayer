# Multi-art-style system (design)

Status: **P1–P6 shipped** including **moment-mode** illustration flashes on
dialogue lines, per-character reference plates for sprite generation, and legacy
`direct-use` for permanent mapping. Keys/API wiring deferred to end of integration.

## The idea
A book can hold **more than one art style** at once. The user picks a style up
front when uploading, but can later switch — and the experience adapts to whether
the requested style has already been generated:

- **Style already generated →** instant swap (just point the player at that
  style's media set).
- **Style not generated yet →** an "Are you sure? this will take time" modal;
  on confirm, a background gen job produces that style. When it finishes, the
  user can flip freely between every generated style.
- **Cheap alternative (user's choice):** instead of *generating* a pixel set,
  apply a live **CSS pixelation filter** over an existing style — instant, zero
  storage/quota. So "pixel" can be either real pixel-art assets *or* a filter.
- **Discard to reclaim storage:** delete a style's assets — but only when **more
  than one** style is present (never delete the last/only art).

Styles in scope: **semi-realistic**, **pixel-art**, **anime** (for light novels).

## Data model (style-namespaced media)
Today media is flat (`{characters, backgrounds, cover}`). Make it per-style:

```
data/media/{book_id}/{style}/char_*.png, bg_*.png, cover.png
data/books/{book_id}.media.json:
{
  "active": "anime",
  "styles": {
    "semi-real": {"characters": {...}, "backgrounds": {...}, "cover": "...", "complete": true},
    "anime":     {"characters": {...}, "backgrounds": {...}, "cover": "...", "complete": true},
    "pixel":     {"mode": "filter"}          // filter, not generated assets
  }
}
```

`compile_book` already takes a `media` dict → it just receives the **active
style's** sub-dict. The library/status layer (`library.py`) gains per-style
progress; `select_cover` reads the active style. Backwards compatible: a flat
media file = a single implicit style.

## Player swap UX
- A style switcher in the player. Options show a badge: ready (●), generating (◐),
  not yet (○), or filter (▤).
- Choosing a **ready** style → `PATCH /books/{id}/active-style` → re-fetch book
  (compiled against that style's media) → sprites/backgrounds swap (CSS fade).
- Choosing a **not-generated** style → confirm modal ("~N images, a few minutes")
  → `POST /books/{id}/styles/{style}` kicks a gen job → the existing progressive
  polling fills it in live (same machinery as first ingest) → becomes ready.
- Choosing **pixel-as-filter** → no job; set `mode: "filter"` and apply the CSS
  filter over the active style's art (see below). Toggleable instantly.

## Live pixelation filter (the cheap path)
Render the existing sprites/background through a pixelation effect rather than
new art: CSS `image-rendering: pixelated` on a downscaled-then-upscaled layer, or
an SVG `feFlood`/`feComponentTransfer` posterize + a small `filter`. Apply at the
`Stage`/`Sprite` level keyed off `media.styles.pixel.mode === "filter"`. No quota,
no storage, instant on/off — distinct from *generated* pixel art (which looks
better but costs time + images).

## Discard / storage
- `DELETE /books/{id}/styles/{style}` removes that style's media dir + manifest
  entry. **Guard:** refuse if it's the only generated style (HTTP 409). If the
  deleted style was active, fall back to another generated style.
- Show per-style storage size in the switcher so the user can decide.

## Illustration extraction (book art as first-class)
The EPUB parser already pulls embedded images (`book.images`) and passes them to
Gemini as **reference**. Extend to two explicit modes (per book, maybe per style):

- **Reference (default):** embedded illustrations steer generated art's
  palette/character/world (already wired for the mega-pass + image prompts).
- **Direct use:** for light novels whose own illustrations are the art, map
  extracted images straight to sprites/backgrounds — e.g., a chapter
  illustration becomes that scene's background, a character plate becomes that
  character's sprite. Needs a light matching step (which image → which
  scene/character), which the Gemini pass can emit (it already sees the images):
  add `illustration_refs` to scenes/characters in `BookAnalysis` pointing at
  extracted image indices, and prefer those over generated assets when present.

Anime style pairs naturally with direct-use, since light-novel inserts are
already anime art — often the cheapest, best-looking option.

## API additions (summary)
- `POST /ingest` — `art_style` (done; now `semi-real|pixel|anime`).
- `GET /books/{id}` — include `styles` availability + `active`.
- `PATCH /books/{id}/active-style {style}` — instant swap (must be ready/filter).
- `POST /books/{id}/styles/{style}` — generate a new style (background job, polled).
- `DELETE /books/{id}/styles/{style}` — discard (409 if last).
- (reuses the existing `/books/{id}` progressive polling for live fill-in.)

## Phasing
- **P0 (done):** art style chosen at upload, sent to `/ingest`.
- **P1:** style-namespaced media model + `compile_book` reads active style;
  `GET /books/{id}` exposes `styles`/`active`. (pure-logic + library tests)
- **P2:** player style switcher + `PATCH active-style` (swap among ready styles).
- **P3:** on-demand `POST styles/{style}` gen job + confirm modal + live polling.
- **P4:** pixel-as-filter mode (Stage/Sprite CSS) as the cheap alternative.
- **P5:** discard + storage UI (with last-style guard).
- **P6:** illustration direct-use (analysis emits `illustration_refs`).

## Open questions
- Default illustration mode per style — reference for semi-real/pixel, direct-use
  for anime/light-novels? Or always ask?
- Is pixel **only** ever a filter (cheap, never generated), or both offered?
- Cap concurrent style-gen jobs (quota) — one at a time per book?
- Should switching style also reset/keep the reading position? (keep — line idx
  is style-independent.)
