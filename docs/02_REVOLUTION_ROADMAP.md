# EbookAVPlayer — Revolution Roadmap

*Where to take the app. Opinionated, sequenced, and grounded in what's already shipped. Read `01_AUDIT_AND_VERDICT.md` first.*

> **⟳ Updated for the July 14 snapshot.** Phase 2 (the expression overhaul) is now **largely shipped** — see below. Phase 0 (consolidation) is **still open and slightly more urgent**: the legacy `server/` was edited again this cycle, so expression changes are now being maintained in two backends. Phase 1 (Simple Mode) is now **implemented** per the `03_` spec: the `uiMode` pref (default `"simple"`) drives `data-ui` on the root, `SimpleLibrary.jsx` and `SimpleSettingsSheet.jsx` are new, `Player.jsx`'s advanced controls (chapter select, gap-nav, illustrations, characters, scrubber, sleep-timer badge) are wrapped in `uiMode === "full"` guards, and the Simple↔Full toggle is reachable and persistent from both modes. `web/src/audio/orchestrator.js` was not touched; the full existing e2e suite (forced to Full Mode) plus a new `simple-mode.spec.js` are green. Phase 3 (character enrichment) is **now built (v1)** — see `docs/CHARACTER_ENRICHMENT.md`: opt-in (`VAE_CHARACTER_ENRICH`, default off), keyless Fandom + MyAnimeList text-attribute lookups feed into image prompts and voice/prosody. It complements rather than replaces `illustration-character-match.js` — that path establishes reference art from the book's *own* embedded plates when present; text enrichment now runs regardless and adds attributes (hair/eye color, outfit, speech register) that embedded plates alone don't carry. Baka-Tsuki support was deferred pending API verification.

The through-line: this is already a capable engine. "Revolutionizing" it is **not** adding surface area — it's (a) removing the structural debt that makes every change slow, (b) closing the gap between the current flat-reading experience and the "staging a performance" vision the brief actually asks for, and (c) making it usable by someone who is not you. That last one is big enough to get its own document (`03_...`).

Everything here respects the two hard constraints that define this project: **the `$0` ceiling** (no new paid dependency crosses it) and **the architecture guardrails** (one central orchestrator; client stays dumb; per-character voice routing; progressive ingest).

---

## Sequencing overview

```
Phase 0  Consolidation           ← unblocks everything (2–4 days)
Phase 1  Simple Mode UI overhaul ← the accessibility mandate (see 03_)   ┐ can overlap
Phase 2  Expression performance  ← biggest experiential upgrade          ┘ with Phase 1
Phase 3  Character enrichment    ← the idea you opened this chat with
Phase 4  VoxNovel timing bridge  ← the highest-value ecosystem play
Phase 5  Net-new bets            ← optional, high-delight
```

Do Phase 0 first. It is the difference between the roadmap being pleasant and being painful.

---

## Phase 0 — Consolidation (the unglamorous prerequisite)

**Goal:** one backend, one source of truth, a green test suite, honest docs. This is P0-1, P0-2, P1-1, P1-2 from the audit, packaged as one campaign.

1. **Retire `server/`.** Confirm nothing in a *deployed* path imports it (grep for `VAE_API_ORIGIN` usage and whether any production `wrangler.toml` sets it). Move `server/align/forced_aligner.py` → `scripts/local-align-server/forced_aligner.py` (it's the one live consumer). Archive the rest of `server/` to a `legacy-fastapi` git branch or a `legacy/` dir excluded from the default toolchain. Remove the origin-proxy fall-through from `worker.js` once health confirms nothing needs it.
2. **Kill the "mirrors registry.py" coupling.** After `server/` is gone, `pipeline-registry.js` is simply *the* registry. Delete the mirror comment.
3. **Green the tests.** Fix/delete `tests/timing.test.mjs` (orphaned `isCheckpoint`). Add a root `npm test` that runs every `tests/*.test.mjs` and `npm --prefix web test`. CI-in-spirit: one command, one green/red.
4. **De-drift the docs.** Banner the two handoffs as historical *at the guardrail sections specifically*; fix the "keep `/tts` on FastAPI" line; fix the ecosystem doc's stack line. Add a single `docs/ARCHITECTURE.md` that is the *one* current-state doc (the README's "what's here" section, promoted and kept live).

**Effort:** 2–4 focused days. **Risk:** low (mostly deletion + doc edits). **Payoff:** every subsequent phase stops having two possible homes.

---

## Phase 1 — Simple Mode (the accessibility mandate)

Fully specified in `03_UI_OVERHAUL_SIMPLE_MODE_HAIKU_SPEC.md`. Summary of the thesis: a top-level `uiMode: "simple" | "full"` preference (default simple) that collapses the app to *library list → one book → play/pause/back*, hides every power-user affordance behind Full mode, and rewrites all user-facing copy from developer-speak to plain, reassuring language. Minimally invasive: it builds on the existing `voicePrefs.js` prefs system and the existing two-view shell; it does **not** touch the orchestrator or the pipeline.

This can start in parallel with Phase 2 once the `Player.jsx` hook-extraction (a Phase-1 prerequisite, see `03_` §Prep) is done.

---

## Phase 2 — Make it a performance (expression overhaul) — ✅ LARGELY SHIPPED (July 13)

> **Update (July 13):** this phase is now built. `docs/EXPRESSION_SENSITIVITY_PLAN.md` is marked *fully implemented*, and the four-leak fix sketched below is in the tree: a higher-temperature focused re-pass (`expression-repass.js`, temp 0.55, `VAE_EXPRESSION_REPASS`-gated), 16-bucket normalization (`expression-bucket.js` + web mirror), bucket→prosody mapping (`expression-prosody.js`), an `expression-sprites` visual consumer, and a flatness auto-trigger mirroring `audit_expression.py` — plus Phase-4 extras (a `tension.js` build-up curve, a **Performance Mode** dial, and a read-only **Director's Log**). Remaining work is *tuning and verification* (confirm the re-pass is enabled in your deployed config; use `GradeTheGrader` as the eval harness to tune the taxonomy/thresholds), not building. **The original plan is preserved below as the design record.**

**This is the single biggest upgrade to what the experience *feels* like,** and you've already done the hard diagnostic work in `docs/EXPRESSION_SENSITIVITY_PLAN.md`. The plan is written; this phase is "build the written plan," with a concrete sequence.

The four leaks and their fixes:

1. **Buried instruction → dedicated, exemplified prompt section.** In `worker/_shared/dialogue-rules.js` (and `extract-prompt.js`), promote expression from one bullet to its own labeled block with a real taxonomy (~12–16 values grouped: calm/soft, joy, anger, fear, sadness, surprise, etc.), 3–4 worked examples showing a line → its expression, and an explicit frequency expectation ("most emotional beats should carry a non-normal tag; a chapter returning 100% normal is almost always an extraction miss"). Instruction density is the lever — the model satisfies the loud, example-heavy rules and defaults the quiet ones.
2. **Temperature 0.2 → per-task temperature.** In `freemium-extract.js` the extraction temp is 0.2 (correct for structural JSON integrity). But expression is a subjective categorical call, and low temp collapses it to the modal token ("normal"). Options, cheapest first: (a) raise the *whole* extraction temp slightly (0.35–0.45) and measure JSON breakage; (b) better — a lightweight *second* low-cost pass over already-extracted dialogue lines *only*, at higher temperature, that fills/repairs expression + delivery without re-doing structural extraction. This keeps the big pass safe and makes the creative call where it belongs.
3. **No audit loop → a flatness detector.** Extend `worker/_shared/dialogue-repair.js`: after extraction, compute the non-normal expression ratio per chapter. If a chapter is suspiciously flat (e.g. <2% non-normal on >30 lines with detected exclamations/shouts in the source), auto-trigger the expression-repair pass for that chapter only. This is the feedback loop that's currently missing — and it's ~0 extra cost on chapters that are already expressive.
4. **Downstream discards half the signal → widen the pipe.** Audit `compile-playback.js` and the sprite/DSP mapping (`voice-assign.js`, and on the client `web/src/audio/voiceProsody.js`, `Sprite.jsx`, the `expr-*` CSS classes) to confirm every extracted expression value maps to *both* a visual treatment and a prosody adjustment. Today the CSS handles `expr-angry/sad/whisper/yell` — extend the map so the richer taxonomy (70+ free-form values already appear in real extractions) collapses cleanly into the supported visual/audio buckets instead of falling back to neutral.

**Why it's revolutionary and not incremental:** the brief's actual target is "the player should feel like it's staging a performance, not just reading text aloud over a static portrait." Right now it's the latter. This phase is what makes it the former, and it's mostly prompt + one repair pass — cheap in both dollars and risk.

**Effort:** 3–5 days. **Risk:** medium (prompt changes need eval — use `GradeTheGrader` from your ecosystem as the harness, that's literally what it's for). **Payoff:** the demo goes from "neat" to "wait, the characters are *acting*."

---

## Phase 3 — Character enrichment (the idea you opened with) — ✅ BUILT v1 (July 14)

> **Update (July 14):** built — `worker/_shared/character-enrich.js`, gated behind `VAE_CHARACTER_ENRICH` (default off). See `docs/CHARACTER_ENRICHMENT.md` for the full design record. Scope note vs. the original plan below: v1 ships Fandom + MyAnimeList (both keyless/free) rather than all three named sources — Baka-Tsuki's current API shape wasn't confirmed at implementation time, deferred as a fast-follow. **The original plan is preserved below as the design record.**

This is the web-search-per-character idea from the top of our conversation — and you've already scoped its shape in `docs/FUNNY_IDEAS_BACKBURNER.md` ("Fandom yoink engine," "Image search roulette") and *already built the plumbing*: `worker/_shared/external-refs.js`, `worker/api/v1/...external-refs`, and the client's `byoArtPack.js`/`ReplaceArtSheet.jsx` reference-image flow. So this isn't greenfield; it's connecting existing organs.

The version that's worth building (and stays on the right side of the `$0` ceiling *and* the copyright line):

**Enrich text, not pixels.** After character reconciliation produces a canonical character (stable ID + name + aliases), run one cached web-search enrichment lookup per character that extracts **structured textual attributes** — canonical hair/eye color, build, age, defining outfit, personality/speech register — from fan wikis (Fandom, Baka-Tsuki, MAL). Feed those attributes into:
- the **image prompt** for that character's baseline sprite generation (so "Elara" is canonically silver-haired even if chapter 1 never says so), and
- the **voice/prosody assignment** (register/cadence descriptors → `voice-assign.js` inputs).

**Do NOT** pipe scraped fanart into img2img as conditioning. That's the line `FUNNY_IDEAS` already flags with "maximum copyright side-eye," and it's the right call — using someone's copyrighted art as unlicensed conditioning is a real risk, especially for a public portfolio piece. Structured text descriptions distilled from wikis get ~80% of the accuracy gain with none of that exposure. (The existing "user pins a reference URL themselves" flow in `ReplaceArtSheet` is a *user choice* and a different, defensible thing — keep it as-is; just don't automate scraping into generation.)

**Architecture fit:** slot the enrichment call right after character reconcile in the extraction pipeline, cache by `name+series` in KV (the `external-refs` KV surface already exists), and gate it behind a pipeline toggle (default off, since it costs search calls and only helps for books with a fan community — obscure originals have no web presence and should fall back to in-text description, which the pipeline already does).

**Effort:** 4–6 days. **Risk:** medium (search-result parsing is fiddly; name-collision guarding needs the series title as an anchor). **Payoff:** noticeably more accurate character art/voice for any book with a fandom, using infra you mostly already have.

---

## Phase 4 — The VoxNovel timing bridge (highest-value ecosystem play)

From `docs/ECOSYSTEM_INTEGRATION.md`: VoxNovel (your BookNLP + XTTS v2 + M4B audiobook generator) is "the highest-value integration," and Mode B of the orchestrator is *already built to consume real narrated M4B audio*. The only missing piece is the **timing manifest**: `line idx → {start_ms, end_ms}` over the M4B. VoxNovel doesn't emit it yet.

The play: teach VoxNovel to emit a `timing.json` keyed by the same stable `line idx` that `PlaybackBook` uses (the shared join key the ecosystem doc identifies). Then a book can be played with *real human-quality XTTS narration* instead of Edge TTS, with the visual layer perfectly synced — because the orchestrator's `setTimeline()`/`_playMediaElementClock()` path already handles exactly this. You'd be connecting two things you already built, and the result is the single most impressive version of the product: your own narration engine driving the visual audiobook.

**Why after Phase 3 and not before:** it depends on cross-repo work (VoxNovel changes) and the stable-line-idx contract being solid, which the consolidation in Phase 0 helps guarantee. But in terms of *wow*, this is arguably the ceiling.

**Effort:** cross-repo, harder to estimate — call it 1–2 weeks including VoxNovel-side work. **Risk:** medium-high (cross-repo contract, alignment accuracy). **Payoff:** the flagship demo.

---

## Phase 5 — Net-new bets (optional, high-delight, `$0`-safe)

Pick from these à la carte once the above lands. None are required; all fit the vision.

- **"Continue reading" resume card done right.** You already persist resume (`library.js`, `saveResume`/`resumeIndex`). Surface it as the *first* thing in Simple Mode — a single big "Continue *[Book]*, Chapter *N*" card. Highest-value tiny feature for a real user.
- **Auto-generated chapter recap.** One cheap LLM call per chapter (the extract providers are already wired) → a 2–3 sentence "previously…" shown on resume after a gap of >1 day. Great for the treadmill/study use case where you forget where you were. Cache it; it's static per chapter.
- **Ambient scene audio (the brief's "cave echo," generalized).** The brief lists audio post-FX as Phase 2. A `$0` version: a small library of CC0 ambient loops (rain, forest, tavern, wind) keyed off the scene's setting tag that the extraction already produces, mixed under the TTS via Web Audio (the orchestrator already owns the audio graph). No generation cost, big immersion gain.
- **Reading stats / streak (SpecterBoard tie-in).** You have `SpecterBoard` in the ecosystem. A private "you read 4 chapters this week" surface, stored locally, is a cheap retention hook and an easy cross-app integration story.
- **Expression-driven camera.** Once Phase 2 lands, let strong expressions (yell, shock) trigger a subtle CSS zoom/shake on the speaking sprite via the `expr-*` classes. The hooks are already in the CSS; it's a small, high-delight motion layer (respect `prefers-reduced-motion`).

---

## What I would explicitly NOT do

- **Don't add a 3D/game engine.** The brief already ruled it out and it's right — this is a *listening aid with visual anchoring*, not a movie. Three.js/Babylon would be scope suicide.
- **Don't chase the AI Studio scraping variants** in `FUNNY_IDEAS`. You already labeled them "peak hack, peak ToS grey area." They are ban-magnets and a bad look on a portfolio. The freemium chain you have is the honest, robust answer.
- **Don't rewrite the CSS or adopt Tailwind/a component lib.** At ~930 lines with clean custom-property theming, it's not the bottleneck. Rewriting it burns days for no user-visible gain and risks the whole visual layer.
- **Don't try to serve other people's books.** The entire legal posture rests on "the user provides their own legally-owned EPUB." Keep it single-user / bring-your-own. Never add a shared library of copyrighted content.

---

## The one-paragraph pitch, after all of this

*EbookAVPlayer turns an EPUB you own into a voiced, staged, game-style reading experience — characters act their lines with expression-matched art and prosody, over scene backgrounds, synced to the word. It runs entirely on free tiers (a reorderable multi-provider fallback chain keeps it at literally `$0`), it's simple enough for a non-technical reader, and with the VoxNovel bridge it can narrate in your own XTTS voice engine.* That's a portfolio centerpiece and a tool you'll actually use. The path there is this document, and it starts with Phase 0.
