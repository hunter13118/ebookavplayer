# Manual test backlog — ebookAVReader / ebookavplayer

Observations from **The Lantern Owl Gate** e2e run (2026-06-19).  
Test book: `test_assets/e2e/lantern-owl-gate.epub` (3 characters, 2 scenes, embedded owl plate).

---

## P0 — EPUB illustration timing & placement

**Observed:** Embedded EPUB illustration (owl plate) did not display appropriately during playback. Analysis had `illustration_ref: null` on all lines; catalog had `img_00.png` but no line-level `illustration_url`.

**Expected behavior (product rule):**

1. Illustration appears **exactly where it sits in the book text flow**.
2. If the plate falls **between line A and line B**:
   - Line **A** finishes speaking (TTS + typewriter complete for A).
   - Illustration **overlays** background + character sprites (full-screen or centered overlay).
   - Line **B** **starts** while the illustration is **still visible**.
3. Illustration **fades out after 10 seconds** (overlay removed; normal stage resumes).

**Likely touchpoints:**

- Extract / mega-pass: map EPUB `<figure>` / image position → `illustration_ref` on the **following** line (or explicit “after line id” in compile).
- `server/analyze/prompt.py` — illustration rules for positional inserts.
- `server/playback/compile.py` — emit `illustration_url` on the correct line.
- `server/playback/illustrations.py` — moment/direct-use modes.
- `web/src/components/IllustrationFlash.jsx`, `Player.jsx`, `Stage.jsx` — overlay z-index, 10s fade, don’t block line advance.
- `web/tests/e2e/illustrations.spec.js` — extend for A→flash→B sequence.

**Acceptance:**

- [x] Owl plate flashes after gate-scene narration before next dialogue, per book order.
- [x] Next line audio begins while flash visible; flash gone ≤10s after show.

---

## P0 — Replace art breaks unselected assets

**Observed:** Replace Art with **specific** targets (selected characters/backgrounds) successfully replaced those assets, but **all other images stopped loading** in playback.

**Likely touchpoints:**

- `server/app.py` — `_run_generate_media`, `ReplaceMediaRequest` scope handling.
- `server/images/generate.py` — partial regen vs `existing_media` / skip lists.
- `server/playback/library.py` — `set_media`, style manifest `complete` flag.
- `web/src/components/ReplaceArtSheet.jsx` — scope/mode payload to API.

**Acceptance:**

- [x] Replace one character sprite → other characters, backgrounds, cover, illustrations unchanged and still render.
- [x] Replace one background → same for other media keys.
- [x] E2E: `web/tests/e2e/replace-art.spec.js` — assert non-target URLs still resolve.

---

## P1 — Playback speed not persistent; typewriter desync

**Observed:**

- Changing speed only affected the **line currently playing**; **subsequent lines** reverted to default speed.
- **Typewriter** reveal rate did not track the selected speed (audio vs text out of sync).

**Likely touchpoints:**

- `web/src/components/Controls.jsx` — speed control state.
- `web/src/components/Player.jsx` — pass rate into orchestrator per line vs session-level.
- `web/src/audio/orchestrator.js`, `playSpeech.js`, `timing.js` — apply `playbackRate` to Edge TTS / Web Speech and typewriter duration.
- `web/tests/e2e/controls-extra.spec.js`, `fixtures.js` (`__lastRate`).

**Acceptance:**

- [x] Speed setting persists for all following lines until changed again.
- [x] Typewriter duration scales with speed (faster speed → faster reveal, stays aligned with audio).

---

## P2 — Modernize speed UI (slider + typed value)

**Observed:** Current speed control is not ideal for fine control.

**Target UX:**

- **Slider** for coarse adjustment (e.g. 0.5×–2.0× or product-defined range).
- **Numeric input** to type an exact multiplier (with min/max validation).
- Single source of truth shared with TTS + typewriter (see P1).

**Likely touchpoints:**

- `web/src/components/Controls.jsx`
- `web/src/styles.css`
- Persist preference in `web/src/audio/voicePrefs.js` (optional).

**Acceptance:**

- [x] Slider and text field stay in sync.
- [x] Invalid values clamped or rejected with clear UX.

---

## Reference — e2e test assets

| Asset | Path |
|-------|------|
| EPUB | `test_assets/e2e/lantern-owl-gate.epub` |
| Owl plate | `test_assets/e2e/sable_owl_plate.png` |
| Build script | `scripts/build_e2e_test_epub.py` |
| Ingested media | `data/media/lantern-owl-gate/anime/`, `.../illustrations/img_00.png` |

## Reference — infra fixed during same session

- `server/playback/library.py`: import fix (`..epub.illustrations`, `.illustrations`) for `/books/{id}` 500.

---

## Suggested fix order

1. ~~EPUB illustration placement + 10s overlay fade (P0)~~
2. ~~Replace art partial regen regression (P0)~~
3. ~~Speed persistence + typewriter sync (P1)~~
4. ~~Speed slider + numeric input (P2, can ship with P1)~~

---

## Status (2026-06-19)

All four items implemented:

- **P0 illustrations:** EPUB `[[ILLUS:n]]` markers in parse → `apply_illustration_placements` at ingest/compile; 10s overlay persists across line advance.
- **P0 replace art:** Pixel filter no longer corrupted by `mark_style_generating`; partial regen targets source style and preserves non-selected URLs.
- **P1 speed:** `getRate()` per line in `speakLinesViaEdge`; orchestrator reads live `this.speed`.
- **P2 speed UI:** Range slider + numeric input (0.5×–2.0×), synced to localStorage.
