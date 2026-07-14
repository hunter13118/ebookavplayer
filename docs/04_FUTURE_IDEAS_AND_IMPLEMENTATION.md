# EbookAVPlayer — Future Ideas & Implementation

*A living backlog of where this can go. The one rule, non-negotiable: **no new spend.** Every idea here is achievable on free tiers, self-hosted on hardware you already run, or pure client-side. Where an idea touches paid territory, it's flagged and a $0 path is given instead.*

> **⟳ Changelog — re-synced July 13 against `ebookavplayer-main_2.zip`.** Items that moved since first draft:
> - **#17 (expression → DSP/prosody) — ✅ shipped:** `expression-prosody.js` maps bucket + intensity → Edge-TTS pitch/rate/volume, with a subtle/balanced/full **Performance Mode** dial. (Reverb/convolver for "cave"/distance is still open.)
> - **#11 (flatness detector / quality loop) — ◧ partly shipped:** `audit_expression.py` plus a wired "suspiciously flat" auto-trigger in `expression-repass.js` exist; the GradeTheGrader-in-the-loop grading is still open.
> - **#46 (Director's Mode) — ◧ half shipped:** a read-only **Director's Log** overlay (`DirectorsLog.jsx`) now surfaces per-line direction; the *editable* script editor is still the open — and higher-value — half.
> - **Seed 2 (#7, local extraction) — in progress:** recent work added MLX local extraction, chunk-size tuning, `think:false`, scene-continuity, and parallel imaging (see the new `docs/TODO_ILLUSTRATIONS_PROFILES_POLISH.md`). The specific *line-by-line* framing isn't the path taken yet, but the local-extraction foundation it depends on is being hardened.
> - **New adjacent capability:** vision-based illustration → character matching (`illustration-character-match.js`) establishes character reference art from the book's *own* embedded plates — a cleaner, zero-copyright cousin of the enrichment idea, and a natural neighbor to #53.
> - **Cinematic build (in the spirit of #21–#28):** a per-scene **tension** curve (`tension.js`) now escalates across consecutive high-intensity lines. Everything else in Themes A–M remains open.

**How to read this:** ideas are grouped by theme and numbered continuously (1–53). Each has: what it is, **why** it's worth doing, **how** (the $0 path + the real files/systems it hooks into), an effort tag (**S** = hours–1 day, **M** = a few days, **L** = a week+), and, where borrowed, the product it's lifted from. Nothing here is a commitment; it's the menu. A suggested "first five" is at the end.

Three of these came from you and are marked **★ SEEDED** — I've run with each rather than just restating it.

---

## Theme A — Reading & audio modes

### 1. ★ SEEDED — Read-Along Mode (ebook + audiobook, no visuals)
**What:** a display mode that drops the Stage/sprite layer entirely and shows the chapter as clean, auto-scrolling text with the audio playing and the current line (and ideally the current *word*) highlighted karaoke-style.
**Why:** you're right that it's an easy win — and it's more than that. It's arguably the *most* useful mode for the core use cases in the brief (treadmill, study, passenger seat) and it directly serves the dyslexia motivation: synchronized text-highlight-during-audio is one of the best-evidenced reading aids there is. It's also the lowest-friction thing to show a skeptic ("it's Audible + Kindle, synced").
**How ($0):** this is mostly *subtraction*. The orchestrator already emits `{index, revealed}` per line and, in Mode B, maps the real audio playhead to a line via `lineAt()`. Add a fourth `displayStyle` value — `"read"` — alongside the existing `pixel | smooth | subtitle` in `voicePrefs.js`. Render a new `ReadAlong.jsx` that lists the chapter's lines as flowing paragraphs, auto-scrolls to keep the active line centered, and applies a highlight class driven by the same `index`/`revealed` state `DialogueBox` already consumes. Word-level highlight (see #2) is the upgrade.
**Effort:** S–M. **Borrowed from:** Audible Immersion Reading / Speechify / Kindle Whispersync.

### 2. Word-level karaoke highlighting
**What:** highlight each word as it's spoken, not just each line.
**Why:** the single biggest polish on Read-Along; the difference between "nice" and "how is this free." Strong dyslexia/ADHD focus aid.
**How ($0):** within a line you already have a per-line duration (Mode A) or real start/end (Mode B). Distribute word timings across the line using the existing `web/src/timing/` machinery — `punctuationDensity.js` and `linearSplit.js` already model intra-line pacing. When WhisperX alignment is active, use its word timestamps directly (the local align server already produces them). Emit a `revealedWord` index alongside `revealed`.
**Effort:** M. **Borrowed from:** Speechify, Spotify lyrics.

### 3. Bionic / focus reading toggle
**What:** bold the first 1–3 letters of each word to create fixation anchors.
**Why:** a well-known dyslexia/skim aid; trivial to add; instantly differentiating.
**How ($0):** pure client-side text transform applied in Read-Along and DialogueBox when toggled. No backend, no cost. Store as a pref.
**Effort:** S. **Borrowed from:** Bionic Reading.

### 4. Dyslexia-friendly typography pack
**What:** OpenDyslexic (or Atkinson Hyperlegible) font option, plus sliders for letter-spacing, word-spacing, line-height, and a cream/sepia background.
**Why:** the owner is dyslexic and this is the reader they'll personally use. It's also a genuine accessibility credential for the portfolio.
**How ($0):** self-host the open-licensed fonts (OpenDyslexic is free; Atkinson Hyperlegible is free from the Braille Institute). Wire spacing to CSS custom properties. Slot into the existing settings.
**Effort:** S. **Borrowed from:** Kindle / Word's accessibility settings.

### 5. Lock-screen & headphone media controls (Media Session API)
**What:** proper OS-level playback — lock-screen art + title, play/pause/skip from headphones, car Bluetooth, and the notification shade.
**Why:** this is the difference between "a webpage that plays audio" and "an audiobook app." Essential for the treadmill/car use case; currently missing.
**How ($0):** the `navigator.mediaSession` API — set `metadata` (title, chapter, cover) and `setActionHandler` for play/pause/next/prev, wired to the orchestrator's existing `play`/`pause`/`next`/`rewind`. Pure browser API, works in the PWA. No cost.
**Effort:** S–M. **Borrowed from:** every podcast/audiobook app.

### 6. "Continue listening" as the first thing you see
**What:** surface the most-recent in-progress book as a single big resume card at the top of the library.
**Why:** for a real daily user this is the highest-value tiny feature; it removes all navigation on the common path.
**How ($0):** you already persist resume (`library.js`, `saveResume`/`resumeIndex`). Read the most-recent one and render it above the grid (and it's the natural hero of Simple Mode).
**Effort:** S. **Borrowed from:** Netflix/Spotify "continue."

---

## Theme B — Extraction & pipeline

### 7. ★ SEEDED — Line-by-line local extraction mode
**What:** an extraction path that processes a chapter **line by line with a rolling context window** on a local LLM (Ollama), instead of chunk-by-chunk.
**Why:** your reasoning is sound — per-line is more intuitive than per-chunk (clearer logs, honest progress "line 340/3,022," accurate ETAs, simpler feature logic), and local models have no per-token cost or rate limit so the "this would rail cloud LLMs" problem evaporates. **One honest caveat:** naive *stateless* line-by-line would wreck dialogue attribution and speaker resolution, which genuinely need surrounding context. So the design that works is **stateful sliding-window**: each line is processed with (a) the previous N lines as context and (b) a running state object carried forward — characters seen so far, current scene, last speaker. That gives you per-line granularity *and* context, and it's a natural fit for a local model that isn't being metered.
**How ($0):** add a `line` mode to the extraction lane, gated to run only when `OLLAMA_BASE_URL` is set (never on a deployed Worker — matches how `pipeline-registry.js` already disables Ollama stages without a local server). Reuse the per-provider adapters in `freemium-extract.js`; wrap them in a loop that threads the running-state object. This also becomes the ideal home for the expression-repair pass (#8, and Phase 2 of the roadmap). Emit per-line events over the existing job-event Durable Object so the UI can show it live (#9).
**Effort:** L. **Note:** keep the chunk path as the cloud default; this is the local-power-user path.

### 8. Live extraction "theater"
**What:** turn the wait during ingest into a watchable show — lines streaming in and getting classified (speaker assigned, expression tagged, scene detected) in real time.
**Why:** waiting is the worst part of the current flow; making it legible (and a little mesmerizing) is both UX and a great demo. Per-line extraction (#7) makes this natural.
**How ($0):** the job-event Durable Object (`job-event-hub.js`) + SSE stream already exist; emit a per-line event and render it in a live log/animation. `IngestActivity.jsx` / `ProcessingLog.jsx` are the hooks.
**Effort:** M. **Borrowed from:** the "watch it think" pattern from agentic tools.

### 9. Honest ETAs from measured throughput
**What:** a real countdown ("about 4 minutes left") from measured lines/sec, not a fake bar.
**Why:** trust. Fake progress bars erode it; real ones build it.
**How ($0):** with per-line events, compute a rolling lines/sec and multiply by remaining. Pure client math.
**Effort:** S.

### 10. Per-line idempotent cache + surgical repair
**What:** cache each line's extraction by content hash so re-runs are instant and a single bad line can be re-extracted without redoing the book.
**Why:** makes iteration cheap and makes the "fix this one wrong attribution" flow trivial.
**How ($0):** hash line text (+ context signature) → KV key. On re-extract, skip cached lines. The KV surface already exists.
**Effort:** M.

### 11. Auto-grade extraction quality (GradeTheGrader in the loop)
**◧ Status (July 13): partly shipped** — `audit_expression.py` + a wired flatness auto-trigger in `expression-repass.js` exist; the GradeTheGrader-in-the-loop grading is still open.
**What:** after extraction, an automated quality pass flags low-confidence chapters (flat expression, unresolved speakers, suspicious character churn) for optional re-run.
**Why:** closes the feedback loop that `EXPRESSION_SENSITIVITY_PLAN.md` identifies as missing. You already built the eval harness (GradeTheGrader) — this is wiring two of your own tools together.
**How ($0):** run a cheap local/free-tier judge pass over the extracted JSON; compute the non-normal-expression ratio and attribution-confidence stats; surface a "re-run chapter 4?" nudge.
**Effort:** M. **Borrowed from:** your own ecosystem.

### 12. Proactive character-merge suggestions
**What:** detect likely duplicate characters ("Unnamed man" ≈ "Eizo") and suggest the merge instead of waiting for the user to find it.
**Why:** the merge tooling exists (`character-merge.js`, `CharacterManager.jsx`) but it's reactive. Suggesting merges makes the common cleanup one tap.
**How ($0):** name/alias similarity + co-occurrence heuristics over the reconciled character set; surface as a dismissible suggestion.
**Effort:** M.

---

## Theme C — Expressive & cinematic voice (the ElevenLabs question, answered)

**The headline finding, and it's good news:** as of early 2026 the gap between free/open TTS and ElevenLabs has largely closed. You don't need to rip anyone off — you can get ElevenLabs-tier expressive delivery for **$0, self-hosted, and legally.** Ripping off ElevenLabs would break *both* your rules (it costs money and it's a legal minefield); the open ecosystem makes that unnecessary.

### 13. Self-hosted expressive TTS tier — Chatterbox (the flagship)
**What:** add **Chatterbox (Resemble AI)** as a self-hosted TTS tier. It's MIT-licensed (commercial-safe), reportedly *beat* ElevenLabs in blind preference tests, offers dial-able **emotion exaggeration**, and supports paralinguistic tags like `[laugh]`, `[sigh]`, `[chuckle]`. Turbo variant runs in ~4–8GB VRAM at sub-200ms latency.
**Why:** this is the single biggest lever on the "cinematic" feel and it's the direct, legal, $0 answer to your ElevenLabs envy. Map the extracted `expression` tag → Chatterbox's emotion-exaggeration control ("yell" → high, "whisper" → low) and inject paralinguistic tags where the text implies them.
**How ($0):** you already run local model servers (War Council on `:3737`, local SD on `:7860`, XTTS in VoxNovel). Add a Chatterbox server on your box; register it as a TTS tier behind Edge TTS in the pipeline the same way image tiers are ordered. Deployed/remote users fall back to Edge TTS; local/you get Chatterbox. Note it's English-only and watermarked.
**Effort:** M–L. **Borrowed from:** ElevenLabs (the *capability*, not the code).

### 14. Parler-TTS / natural-language delivery direction
**What:** a TTS tier where you *describe* the delivery in plain language — "a terrified whisper, trembling" — and the model performs it. Parler-TTS supports free-form instructions embedded at any word position (`[whisper in small voice]`, `[excited and fast]`).
**Why:** it pairs *perfectly* with expression extraction — your pipeline already produces free-form expression values (70+ observed), and instead of collapsing them into 4 buckets you can pass them almost verbatim as delivery prompts. This is the most direct path from "the model knows the character is scared" to "the voice sounds scared."
**How ($0):** self-host Parler-TTS; feed `expression` + `delivery` fields as the description prompt. Slot as a tier.
**Effort:** M. **Borrowed from:** the describe-the-voice paradigm.

### 15. Exploit Azure expressive styles through the free Edge TTS loophole
**What:** Azure neural voices support expressive styles via SSML `mstts:express-as` (cheerful, angry, sad, whispering, shouting, terrified, etc.) with a `styledegree`. **Spike whether the free Edge read-aloud endpoint honors these** — if it does, you get expressive delivery on the tier you *already run*, for $0, with zero new infra.
**Why:** if it works, it's the cheapest possible expression win — no new model server. If it doesn't, you've spent a day and learned the boundary. Either way it's worth the spike before building #13/#14.
**How ($0):** extend `edge-tts.js` to emit `<mstts:express-as style="...">` wrapping and test against the real endpoint. **Verify, don't assume** — the loophole rides a consumer feature and may strip unsupported SSML.
**Effort:** S (spike) then S–M. **Risk:** may not work; treat as investigation.

### 16. Kokoro as the fast default narrator
**What:** add **Kokoro (82M, Apache-2.0)** as a lightweight default narrator tier — ~2–3GB VRAM, runs even on CPU, ~200x realtime on a good GPU, commercial-safe.
**Why:** for long-form narration where you want speed and don't need cloning, Kokoro is the efficient workhorse; keep the heavy expressive models (Chatterbox/Parler) for dialogue lines and Kokoro for narration. A per-line *router* (narration → Kokoro, emotional dialogue → Chatterbox) is the cinematic-and-fast sweet spot.
**How ($0):** register as a tier; route by line kind (`lineKinds.js` already distinguishes narration vs dialogue).
**Effort:** M. **Borrowed from:** the "right model per job" pattern.

### 17. Expression→DSP performance layer (enhance what exists)
**✅ Status (July 13): shipped** — `expression-prosody.js` (bucket+intensity → pitch/rate/volume) with a subtle/balanced/full Performance Mode dial. Reverb/low-pass for "cave"/distance still open.
**What:** even on plain Edge TTS, post-process per-expression: pitch/rate/volume shifts, plus reverb for "cave"/large spaces and a slight low-pass for "distant/muffled."
**Why:** a $0 fallback that makes *any* TTS tier more performant, and it generalizes the brief's "cave echo." You already have `server/audio/expression_dsp.py` and `voice_expression.py` as a starting point — bring the concept to the Worker/client audio graph the orchestrator owns.
**How ($0):** Web Audio nodes (BiquadFilter, ConvolverNode with a free impulse response, GainNode) applied per line based on expression/scene tags. No cost.
**Effort:** M.

### 18. Dramatic pacing & pauses
**What:** insert cinematic micro-pauses — a beat after an em-dash, a longer hold on an ellipsis, a breath before a shout, a pause at scene breaks.
**Why:** timing is 80% of what makes narration feel "directed" vs "read." Cheap, huge impact.
**How ($0):** the orchestrator already controls inter-line gaps (`lineGapMs`); extend it to vary the gap by punctuation and expression. Pure timing logic.
**Effort:** S–M. **Borrowed from:** professional audiobook narration.

### 19. Per-character voice cloning (consent-gated)
**What:** assign a character a *cloned* voice from a short reference clip (XTTS v2 or Chatterbox both clone from 5–10s).
**Why:** full-cast personalization; and the heartfelt version (#52) is genuinely special.
**How ($0):** self-hosted XTTS/Chatterbox cloning; store the reference per character. **Hard rule:** only voices you have the right to use — your own, public-domain, or a person who has explicitly consented. Gate the feature behind an explicit consent affirmation and never ship cloned-celebrity presets. XTTS is non-commercial-licensed (fine for a personal project; do not commercialize cloned output).
**Effort:** M. **Caveat:** consent + licensing — see the Caveats section.

### 20. Auto-casting by archetype
**What:** auto-pick a fitting voice per character from extraction — age, gender, and role (gruff mentor, young sibling, regal antagonist).
**Why:** a well-cast full-cast audiobook with zero manual work; great first impression.
**How ($0):** map extracted character attributes → a curated table of free voices (Edge voice catalog already exists in `edge_voice_catalog.py`; extend with the local tiers). The existing pitch-de-collision logic in `voices.py` prevents same-voice clashes.
**Effort:** M.

---

## Theme D — Cinematic visuals & staging (all $0, mostly CSS/Web Audio)

### 21. Ken Burns / parallax on backgrounds
**What:** slow, subtle pan-and-zoom on scene art; optional depth parallax between background and sprites.
**Why:** the single cheapest thing that reads as "cinematic." A static background feels like a slideshow; a drifting one feels like a film.
**How ($0):** CSS `transform` keyframe animations on the `Stage` background layer. Respect `prefers-reduced-motion`.
**Effort:** S. **Borrowed from:** Ken Burns / documentary film.

### 22. Dynamic camera on the speaker
**What:** subtle push-in toward the speaking sprite; a small shake or snap-zoom on a `yell`/`shock` expression.
**Why:** directs the eye to who's talking and makes big emotional beats *land*. Pairs with the expression work.
**How ($0):** CSS transforms on the spotlighted sprite (the `spot`/`dim` classes already exist); trigger stronger transforms off `expr-*` classes.
**Effort:** S–M.

### 23. Mood lighting / color grading
**What:** a full-stage color-grade overlay keyed to scene setting or dominant expression — warm gold for a tavern, cold blue for night, a red pulse for rage.
**Why:** color is emotional shorthand; it makes each scene feel distinct for near-zero effort.
**How ($0):** a CSS gradient/filter overlay layer on the Stage, value chosen from the scene/expression tags the extraction already produces.
**Effort:** S.

### 24. Letterbox / cinematic bars
**What:** an optional 2.35:1 letterbox toggle.
**Why:** instant "movie" signal; some users love it.
**How ($0):** two CSS bars over the Stage. Trivial.
**Effort:** S.

### 25. Scene transitions
**What:** fade/dissolve/wipe between scenes instead of a hard cut, with an optional "establishing beat" — hold on the new background with its title for ~1.5s before dialogue starts.
**Why:** transitions are what make a sequence feel authored. The establishing beat is a classic cinematic grammar and gives the listener a moment to place the scene.
**How ($0):** CSS transitions on Stage swap; the orchestrator already knows scene boundaries.
**Effort:** M.

### 26. Ambient scene audio beds
**What:** a small library of CC0 ambient loops (rain, forest, tavern murmur, wind, ocean, fire) mixed softly under the narration, chosen by the scene's setting tag.
**Why:** ambience is disproportionately immersive; it's the brief's own "context effects" idea generalized. Big payoff for a listening aid.
**How ($0):** ship a handful of CC0 loops (Freesound CC0, etc.); mix via a low-gain Web Audio source under the TTS in the orchestrator's audio graph. Keyed off the scene tag extraction produces.
**Effort:** M. **Borrowed from:** immersive audiobook productions / VNs.

### 27. Sound-effect stingers on impactful lines
**What:** optional, sparing SFX on strong action/expression beats — a door slam, a sword ring, a thunderclap.
**Why:** used sparingly, it's the difference between "reading" and "experiencing." Used heavily, it's annoying — so make it a subtle toggle with a low trigger rate.
**How ($0):** small CC0 SFX set keyed to action/expression tags; Web Audio one-shots. Off by default; "cinematic mode" turns it on.
**Effort:** M. **Caveat:** taste — cap frequency.

### 28. Weather & particle overlays
**What:** CSS/canvas rain, snow, falling leaves, embers, dust motes — chosen by scene tag.
**Why:** cheap atmosphere that makes scenes feel alive.
**How ($0):** a lightweight canvas particle layer over the Stage; a handful of presets. Respect reduced-motion and battery.
**Effort:** M.

### 29. Generated "movie poster" chapter/book cards
**What:** a cinematic title card per book (and optional per-chapter), composed from the generated cover art + title typography.
**Why:** makes the library feel like a streaming service and gives a strong opening beat when you start a book.
**How ($0):** you already generate covers (`select_cover`, catalog cover logic); compose title typography over them client-side (canvas or CSS).
**Effort:** S–M. **Borrowed from:** Netflix title cards.

---

## Theme E — Player UX & controls

### 30. Visual scene scrubber
**What:** a timeline with scene thumbnails; jump by scene, not just by scrubbing blindly.
**Why:** navigating a long book by a featureless bar is painful; thumbnails make it spatial.
**How ($0):** you have per-scene backgrounds; render them as scrubber ticks. Ties to the existing progress scrub.
**Effort:** M. **Borrowed from:** YouTube storyboard hover.

### 31. Bookmarks, highlights & notes
**What:** mark a line, highlight a passage, jot a note; a "my bookmarks" view per book.
**Why:** table-stakes for a serious reader; also enables the share-a-quote feature (#45).
**How ($0):** store against the stable `line idx` in localStorage / the progress endpoint. Pure client + existing progress store.
**Effort:** M. **Borrowed from:** Kindle.

### 32. Sleep timer with fade-out & "end of chapter"
**What:** upgrade the existing sleep timer with a gentle audio fade before it stops, and an "end of current chapter" option.
**Why:** the current timer is abrupt; a fade is the humane, Audible-standard behavior for bedtime listening.
**How ($0):** you already have the sleep timer (`sleepTimerRemainingMs`, the badge); add a GainNode ramp and a "stop at chapter end" mode.
**Effort:** S. **Borrowed from:** Audible.

### 33. A–B repeat / line replay
**What:** replay the current line, or loop a selected A–B passage.
**Why:** comprehension aid (and huge for the language-learning angle, #48).
**How ($0):** the orchestrator already has `seek`/`rewind`/line indices; add a loop flag between two indices.
**Effort:** S–M. **Borrowed from:** language-learning players.

### 34. Voice command control
**What:** hands-free "pause," "next chapter," "louder" via the Web Speech API.
**Why:** perfect for the treadmill/kitchen/driving contexts; genuinely useful accessibility.
**How ($0):** `webkitSpeechRecognition` (free, on-device in Chrome) mapped to orchestrator actions. Off by default.
**Effort:** M. **Caveat:** browser support varies; treat as enhancement.

### 35. Gesture controls (mobile)
**What:** swipe for next/previous line, tap-to-pause, long-press to reveal controls.
**Why:** the app is a PWA people will use on phones; gestures beat hunting for small buttons.
**How ($0):** touch handlers on the Stage. Pairs with Simple Mode.
**Effort:** M.

---

## Theme F — Accessibility & comprehension

### 36. Tap-to-define / tap-to-translate a word
**What:** tap any word to see a definition and, optionally, a translation.
**Why:** massive for ESL readers and dyslexia — and *specifically relevant to you*: your mother's first language is Vietnamese, so instant EN→VI translation of a tapped word turns this into a tool she could use to read English books, not just listen. That's a real, personal, high-value feature.
**How ($0):** free dictionary APIs (e.g., the free Dictionary API) or a bundled offline dictionary; for translation, a free tier or an offline model (many small MT models run locally). Definitions cache per word.
**Effort:** M. **Borrowed from:** Kindle Word Wise / Duolingo. **Caveat:** pick a genuinely-free translation source or self-host.

### 37. Reading ruler / line focus
**What:** dim everything except the current line (and a line or two around it).
**Why:** a well-evidenced focus aid for dyslexia/ADHD; makes Read-Along calmer.
**How ($0):** a CSS mask/overlay in Read-Along. Pure client.
**Effort:** S. **Borrowed from:** Microsoft Immersive Reader.

### 38. Color-tint overlays (Irlen-style)
**What:** optional whole-screen color transparency tints (some readers find specific tints reduce visual stress).
**Why:** cheap, opt-in accessibility that helps a real subset of readers.
**How ($0):** a fixed CSS overlay with adjustable hue/opacity. Pure client.
**Effort:** S.

### 39. Full screen-reader + keyboard-navigation pass
**What:** ARIA roles/labels throughout, focus management, complete keyboard operability, visible focus rings.
**Why:** it's the right thing to do, it's a portfolio credential, and it makes the app usable by people who can't use a mouse. `Controls.jsx` already has `aria-label`s — extend the discipline everywhere.
**How ($0):** systematic pass; no cost. Pairs with the Simple Mode work.
**Effort:** M.

---

## Theme G — Library, progress & retention

### 40. Reading stats & streaks (SpecterBoard tie-in)
**What:** a private, local "you read 4 chapters this week / 6-day streak" surface.
**Why:** gentle retention and a natural cross-app integration with your SpecterBoard project.
**How ($0):** derive from resume/progress events stored locally. No cost.
**Effort:** M. **Borrowed from:** Duolingo streaks.

### 41. Auto chapter recap ("Previously…")
**What:** a 2–3 sentence recap shown on resume after a gap of a day or more.
**Why:** perfect for the study/treadmill user who forgets where they were; removes re-reading friction.
**How ($0):** one cheap free-tier/local LLM call per chapter, cached (it's static per chapter). Uses the extract providers already wired.
**Effort:** M. **Borrowed from:** "previously on…" TV grammar.

### 42. Auto-derived genres/tags & smart shelves
**What:** tag and group books by genre/theme derived from extraction; series grouping.
**Why:** makes a growing library navigable; you already have shelves (`libraryShelves.js`).
**How ($0):** derive tags during extraction (one cheap classification); feed the existing shelf system.
**Effort:** M.

### 43. Cross-device resume
**What:** start on your phone, continue on your desktop.
**Why:** expected of any modern reader; you already have the progress endpoint that makes it possible.
**How ($0):** sync resume position through the existing `/books/:id/progress` endpoint instead of localStorage-only. No new infra.
**Effort:** M. **Borrowed from:** Kindle Whispersync.

---

## Theme H — Offline & performance

### 44. Full offline packs (audio pre-synth)
**What:** extend offline packs to include pre-rendered audio, so a downloaded book plays with zero network.
**Why:** true airplane/subway listening; you already cache images offline (`web/src/offline/*`, `.vaepack`).
**How ($0):** pre-synthesize Edge/local TTS per line at pack-build time and store in the pack. Storage-for-latency trade the brief already anticipated. Watch pack size — make it opt-in per book.
**Effort:** M–L. **Borrowed from:** Spotify/Audible downloads.

### 45. Background pre-fetch of the next chapter
**What:** quietly prepare the next chapter's audio/art while the current one plays.
**Why:** eliminates the between-chapter hitch; makes playback feel seamless.
**How ($0):** prefetch on idle via the existing queue/pack machinery. No cost.
**Effort:** M.

---

## Theme I — Personalization & creative control

### 46. "Director's Mode" script editor
**◧ Status (July 13): half shipped** — a read-only Director's Log (`DirectorsLog.jsx`) now surfaces per-line direction; the editable script editor (the higher-value half) is still open.
**What:** a simple editor to correct the extracted script — fix who says a line, change an expression, split/merge a scene — then re-compile.
**Why:** gives power users (you) creative control and a way to hand-fix any extraction miss without touching code. It's also the honest answer to "extraction isn't perfect": let the human direct.
**How ($0):** an editing UI over the compiled `PlaybackBook` JSON, writing back through the existing character/media/re-extract endpoints. The stable `line idx` is the anchor.
**Effort:** L. **Borrowed from:** Descript / VN script editors.

### 47. Themeable dialogue-box & art-style presets
**What:** more display skins beyond pixel/smooth/subtitle, and shareable art-style prompt presets ("90s cel anime," "watercolor," "noir").
**Why:** low-cost personalization and a fun surface; art-style is prompt-only so it stays $0.
**How ($0):** additional CSS skins; art styles are just prompt templates fed to the existing freemium image chain (no LoRA, no training — description only). Ties into the shipped multi-style system in `ART_STYLES.md`.
**Effort:** M.

---

## Theme J — Sharing & showcase (copyright-careful)

### 48. Shareable "scene card" export
**What:** export a still — background + sprite + the current line — as an image to share.
**Why:** organic marketing and a delightful moment. **But:** the quoted book text is copyrighted. Keep shares to a *short* line (a sentence), only over *your own generated* art, and default to the public-domain sample book for any public/demo sharing. Don't build a feature that encourages exporting long copyrighted passages.
**How ($0):** canvas composite client-side. No cost.
**Effort:** M. **Caveat:** copyright — short quotes only; see Caveats.

### 49. Portfolio "demo reel" auto-play
**What:** a curated, fully non-copyrighted sample book (you have *The Silver Gate*) that auto-plays a polished ~60s highlight for showcase.
**Why:** the safest, most impressive way to demo the app publicly — no copyright exposure, all your own generated content, shows off the cinematic layer.
**How ($0):** script an auto-play sequence over the embedded sample. No cost.
**Effort:** S–M.

---

## Theme K — Ecosystem ("Babel") integration

### 50. VoxNovel narration bridge (timing manifest)
**What:** teach VoxNovel to emit `line idx → {start_ms, end_ms}` over its M4B so its real XTTS narration drives Mode-B playback.
**Why:** from the roadmap and `ECOSYSTEM_INTEGRATION.md` — the highest-ceiling version of the product: your own human-quality narration engine, perfectly synced to the visual layer. The orchestrator's `setTimeline()` path is *already built* to consume exactly this.
**How ($0):** cross-repo work on VoxNovel + the shared stable-`line idx` contract. No new infra.
**Effort:** L (cross-repo). **Borrowed from:** your own toolkit.

### 51. Gyōkan bilingual mode
**What:** a JP⇄EN parallel visual-audiobook mode using your Gyōkan reader's dual-text approach.
**Why:** turns this into a language-learning tool (dual text + synced audio + tap-to-define), a genuinely novel combination. Ties directly to the ESL/translation features (#36) and your mother as a user.
**How ($0):** integrate Gyōkan's parallel-text pipeline; render dual lines in Read-Along with audio in the target language.
**Effort:** L. **Borrowed from:** your own toolkit + LingQ/Readlang.

---

## Theme L — Wildcard / shower thought

### 52. "Read to me in a loved one's voice" (consent-gated)
**What:** let a user record a consenting family member reading for ~30 seconds, clone that voice (XTTS/Chatterbox), and have it narrate any book — a grandparent reading bedtime stories to a grandchild who lives far away, in the grandparent's actual voice.
**Why:** it's the emotional peak of everything this app can do, and it's entirely $0 and self-hosted. It reframes the whole project from "cool tech demo" to "something that matters to a family." (It's also, frankly, a portfolio story that people remember.)
**How ($0):** self-hosted cloning from a short reference; store per-narrator. **Absolutely consent-gated** — only voices recorded with the person's explicit, informed permission; never a public-figure preset. See Caveats.
**Effort:** M (on top of #19). **Caveat:** consent is non-negotiable.

---

## Theme M — POV & narrator identity

### 53. Link the narrator to the POV character (first-person staging) — FULL SPEC
**What:** in a first-person book, the "narrator" and the protagonist are the *same person* — the narration is the protagonist's inner monologue — but extraction models them as separate identities. This feature detects first-person POV mechanically, proposes linking the `narrator` pseudo-character to a real character, and — when linked — resolves narration lines to that character's **voice** and **sprite** while *preserving* the narration/dialogue distinction. It's the third piece of the character-reconciliation story that sits right next to the merge/rename tools (#12): merge fixes "Unnamed protagonist → Eizo"; this fixes "narrator *is* Eizo."

**Why:** most of your corpus is first-person light novels, and inner monologue is the *majority* of their runtime. Today that majority plays in a generic narrator voice over an empty/unfocused stage. Linking it means (a) the protagonist's inner voice sounds like the protagonist, (b) their sprite is present while they think, and — the compounding payoff — (c) all the expressive-voice work (Chatterbox #13, expression-repair from the roadmap) now applies to the line-type the reader hears most. It's also a POV-correctness fix: it's the difference between the app *understanding* whose head we're in and not.

**Design principle — link, don't hard-merge.** Do **not** merge `narrator` into the character (that would turn narration into dialogue and destroy the thought-vs-speech distinction you want for staging and prosody). Instead keep `kind: "narration"` and add a *resolved reference* to the POV character. Narration stays narration; it just now has an owner.

**Design principle — POV-aware, detected mechanically, never global-always.** Detection comes out of the LLM's hands (the weak link you flagged) and into a deterministic heuristic. A blind global merge breaks two real cases the spec must handle: **third-person books** (you must NOT voice/spotlight Eizo reading "Eizo walked to the forge") and **alternating-POV books** (common in LNs — the narrator is a different character per chapter), which is why the link is a book-level default with **per-chapter overrides**.

#### Data model
Store on the book's character/meta sidecar, alongside where merges/renames persist so it survives re-extraction:
```jsonc
"narrator_link": {
  "enabled": false,             // off until user accepts a proposal
  "pov_character_id": null,     // book-level default POV owner
  "use_pov_voice": true,        // true = narration uses POV char's voice; false = keep a distinct narrator voice
  "focus_mode": "glow",         // "glow" | "spotlight" | "portrait" (staging treatment; see below)
  "show_pov_name": false,       // false = label stays "Narrator"; true = "Eizo" / "Eizo (thoughts)"
  "per_chapter": {              // overrides for alternating-POV books; chapterNum -> character_id
    "7": "heroine_id"
  }
}
```
Book-level default resolves per line as: `per_chapter[chapterOfLine] ?? pov_character_id`.

#### Mechanical POV detection (deterministic, $0 — no LLM)
Add `detectFirstPersonPOV(lines, characters)` (new util, e.g. `worker/_shared/pov-detect.js`):
1. Over **narration lines only** (`kind === "narration"`), count first-person-singular pronoun tokens (`I, me, my, mine, myself`) vs. third-person (`he/she/they/him/her`). Dominant first-person ratio (e.g. FPS tokens present in >35% of narration lines) ⇒ flag first-person.
2. Pick the candidate POV character: the speaking character with the highest presence + dialogue-line count in first-person chapters (the protagonist is almost always the most-present speaker). Optionally corroborate with name-proximity to first-person cues. Return `{ isFirstPerson, confidence, candidatePovId, perChapterCandidates }`.
3. **Propose, never auto-apply.** Surface a dismissible banner: *"This looks like a first-person story narrated by **Eizo** — link them so his voice and character show during narration?"* with the POV pick editable from a short list. One tap accepts; it writes `narrator_link` and applies book-wide.

Run detection at the end of extraction (it's cheap and deterministic); store the proposal so the UI can show it without recomputation.

#### Touchpoints (all verified against the current code)
- **Voice — `worker/_shared/voice-assign.js`:** leave `assignVoices`/`assignVoicesIncremental` as-is (they correctly `continue` past `"narrator"` — it isn't a real character to assign a pool slot to). Resolve the link at the **narration→voice lookup** instead: when `narrator_link.enabled && use_pov_voice`, a narration line's voice = the POV character's already-assigned voice (from `assignVoices`) for that chapter's POV owner; otherwise fall back to `narratorVoice(gender)` / the user's chosen narrator voice. Cleanest place is compile (`compile-playback.js`) stamping the resolved voice onto narration lines, keeping the client dumb per the architecture guardrail.
- **Staging spotlight — `web/src/audio/lineKinds.js`:** `spotlightCharacterId` currently early-returns `null` for `character_id === "narrator"`. Add a POV-aware path: when a link is active for the line's chapter, return `povCharacterId` for narration lines *plus a focus mode* (introduce `narrationFocus(lines, index, link) → { id, mode }` rather than overloading the bare-id return, so the Stage can distinguish a gentle "narrating" treatment from a full speaking spotlight).
- **Stage layout — `web/src/audio/timing.js`:** `stageLayout(present, speakerId, maxFocused)` already takes a speaker id and computes spotlight/dim — feed it the resolved POV id. **Edge case to handle:** a pure-monologue scene may not list the protagonist in `scene.present_character_ids` (confirmed: `compile-playback.js` builds `present` from that field), so `stageLayout` would get an empty/POV-less present set. When a link is active and the line is narration, **inject the POV character into the present set** (using their sprite) at the client resolution layer — `Player.jsx`'s `lineSprites`/`spotlightId` memos are the hook.
- **Focus treatment — CSS (`web/src/styles.css`):** add `.vae-sprite.narrating` — a *gentle* glow (soft drop-shadow / slight scale), distinct from the existing full `.spot` (scale-up + dim others) — so narration while others are on stage doesn't yank focus back and forth on every interjection. Also add an optional `.vae-pov-portrait` corner-portrait element for `focus_mode: "portrait"` (shows whose head we're in without touching scene staging — closest to how VNs handle first-person).
- **Display — `web/src/components/DialogueBox.jsx`:** it already special-cases `kind === "narration"` (renders "Narrator: " / `vae-speaker-narrator`). Respect `show_pov_name`: default keep "Narrator" (preserves the inner-voice feel); when true, show the POV name or "Eizo (thoughts)". `speakerName` is already a prop — resolve it upstream.
- **UI — `web/src/components/CharacterManager.jsx` / `PlayerMenu.jsx`:** add a **Narrator** row to the Characters section: a "Linked to" character dropdown (extracted characters + "— none —"), a "Use this character's voice for narration" toggle, a focus-mode picker (Glow / Spotlight / Corner portrait), and a per-chapter override affordance for alternating POV. This is where the auto-detected proposal is confirmed or edited.

#### Staging behavior (resolve the focus nuance explicitly)
- **POV alone on stage (pure inner monologue):** full spotlight on the POV sprite is fine (`focus_mode: "spotlight"`).
- **POV present while others speak/are shown:** use `"glow"` (gentle) so the stage doesn't strobe focus between a dialogue speaker and the narrator on every narration line.
- **Default:** `"glow"`. Ship the full-spotlight version as a selectable mode (your original idea), and the corner-portrait as the third option for people who prefer the scene staging untouched.

#### Acceptance criteria
- [ ] A first-person book triggers a POV proposal naming the correct protagonist; accepting it links narrator → POV and persists in the sidecar (survives re-extraction).
- [ ] With the link on and `use_pov_voice: true`, narration lines play in the POV character's assigned voice; with it off, narration uses the distinct narrator voice. Toggle flips live.
- [ ] Narration lines still render as narration (thought/narration box), NOT as dialogue — the distinction is preserved.
- [ ] During narration, the POV sprite is shown with the selected focus treatment; if the scene didn't list them present, they're injected (no empty stage).
- [ ] Focus mode `"glow"` does not full-spotlight/dim-others during narration when other characters are on stage; `"spotlight"` does; `"portrait"` shows a corner portrait and leaves scene staging unchanged.
- [ ] A **third-person** book produces no proposal and, if a user force-links anyway, the feature is clearly opt-in (no silent global behavior).
- [ ] An **alternating-POV** book honors `per_chapter` overrides — chapter 7's narration resolves to the heroine's voice/sprite while chapter 6's resolves to Eizo's.
- [ ] Detection is deterministic (no LLM call) and adds negligible time to extraction.

**How ($0):** entirely local logic + prompt-free heuristic + CSS; no new provider calls, no new infra. Detection is pure string counting; voice/sprite resolution reuses existing assignments; staging reuses `stageLayout`.
**Effort:** M. **Borrowed from:** visual-novel first-person framing (the corner-portrait convention) + your own character-merge tooling (#12), which this completes.

---

## Caveats & guardrails (read before building the flagged ones)

- **Voice cloning (#19, #52):** only ever clone voices you have the right to use — your own, public-domain, or a person who has given explicit, informed consent. Gate the feature behind a consent affirmation. Never ship celebrity/character voice presets. Note license terms: **Chatterbox is MIT (commercial-safe), Kokoro/Bark are Apache/MIT; XTTS v2 and F5-TTS are non-commercial** — fine for a personal project, but don't sell cloned output. Chatterbox watermarks its output (a feature, not a bug, for traceability).
- **Copyright on sharing/export (#48, #62-style clips):** the user's own generated art is theirs; the *book text* is not. Keep any shared/exported quote short (a sentence), and default all public demos to the public-domain sample book. Never build flows that export long copyrighted passages or full chapters as media.
- **The Edge TTS `express-as` spike (#15):** verify before you rely on it. It rides a consumer accessibility feature that Microsoft never blessed for this use; it may strip unsupported SSML. Spike it, measure it, then decide — don't build on an assumption.
- **The AI Studio scraping ideas in `FUNNY_IDEAS_BACKBURNER.md`:** still a no. They're ban-magnets and a bad portfolio look. The open-TTS + freemium-image chains are the honest, robust, $0 answer.
- **Model recommendations age fast.** The TTS landscape moved a lot in the last year (Chatterbox beating ElevenLabs is *recent*). Re-verify current best-in-class and license terms before you self-host — treat the specific model names here as "as of early 2026," not gospel.

---

## Suggested first five (highest value ÷ effort, all $0)

1. **#5 Media Session API** (lock-screen/headphone/car controls) — turns a webpage into an app. **S–M.**
2. **#1 + #2 Read-Along with word highlight** — the easy win you named, and the biggest daily-use + dyslexia payoff. **M.**
3. **#15 spike, then #17 DSP + #18 pacing** — cheapest path to a *noticeably* more expressive/cinematic voice before standing up a new model server. **S–M.**
4. **#21 Ken Burns + #23 mood lighting** — the two cheapest things that read as "cinematic." **S.**
5. **#13 Chatterbox tier** — once the cheap wins land, this is the legal, $0 answer to the ElevenLabs itch. **M–L.**

Then let the roadmap's Phase 2 (expression) and this list's Theme C converge — expressive extraction feeding an expressive voice engine is the whole ballgame for the "staging a performance" vision.

*Everything above holds the line: not one of these crosses the $0 ceiling. The ceiling isn't a constraint on ambition here — it's the reason the architecture is interesting.*
