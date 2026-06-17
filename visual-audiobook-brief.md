# Project Brief: Visual Audiobook Engine

## Concept

A web app that turns a user's own ebook (EPUB) into a procedurally generated "visual audiobook" — a game-style reading experience where characters speak in their own voices over scene backgrounds, with synced text display. Think Stardew Valley / Pokémon dialogue boxes, but voiced via text-to-speech and driven by the actual book contents.

This is a **visual aid for listening**, not a cinematic product. The target experience is the level of ambient engagement someone gets watching a parkour video while listening to a lecture — enough visual anchoring to hold focus while listening (treadmill, passenger seat, study aid). Explicitly *not* trying to be a movie.

The user provides their own legally owned ebooks. The tool enhances a product they already own; it does not distribute or reproduce copyrighted content.

## Core Pipeline

1. **Ingest** an EPUB. Parse structure — chapters, text, and any embedded images.
2. **Single Gemini mega-pass** (one request per book to conserve rate limits): produces structured JSON containing:
   - Chapter/scene segmentation
   - Character extraction with descriptions
   - Line-to-character allocation (who says what)
   - Characters present per scene
   - Importance tier per character (primary / secondary / background)
   - Notable appearance changes and time skips (flags when a new image is warranted vs. when an old one can be reused)
   - Scene-reuse flags (recurring locations reuse backgrounds)
3. **Image generation** (batch of additional requests *after* the parse): generate character art and scene backgrounds for primary characters only. Secondary/background characters pull from a pre-generated pool of generic stock images to avoid request bloat. Retroactive generation if a side character becomes important.
   - Where the EPUB contains embedded images (common in light novels), extract them and pass to Gemini as **visual/color reference** for generated art to keep it consistent with the source.
4. **Voice synthesis** via Edge natural-voices TTS API (already used in user's existing audiobook generator). Stream in small segments so playback keeps pace with generation. Audio post-processing for: deduplicating voices when characters collide (pitch-shift to create deeper male / higher child voices), and context effects (e.g. echo in a cave).
5. **Playback**: backend serves lightweight scene JSON; client plays it.

## Tech Stack

- **Frontend**: React. CSS transitions for character fade in/out. (No 3D engine needed — Three/Babylon would be overkill.)
- **Sync**: Web Audio API as the timing orchestrator — fire audio stream start, sprite state change, and text reveal together off exact timestamps. Track play/stop per clip to drive progression. Sync drift is the main risk; keep one central orchestrator.
- **Parsing/creative**: Google Gemini API. The free tier now includes **image generation up to ~500 images/day** via Google AI Studio (no card required) — good fit. Fallbacks if exhausted: Cloudflare Workers AI (FLUX), Hugging Face inference, or local Stable Diffusion via the user's GPU.
- **TTS**: Edge natural-voices API.
- **Hosting**: Cloudflare Pages / Workers on the free plan. Backend is light (API orchestration, queueing, JSON management), so free tier should suffice for MVP/personal use. **Watch the Workers free-tier CPU timeout (~10s)** — the Gemini parse pass could brush against it. Structure code so it's easy to port if so.
  - **Fallback**: local orchestration on the user's own device (Node backend, optionally bundled, or a web worker) handling Gemini calls and orchestration locally — network/compute only, *not* GPU-intensive. Build Cloudflare-first but keep this portable.

## Backend vs. Gemini split

Gemini does the one-time creative heavy lifting (parse + image gen). Everything else — scene sequencing, JSON storage, script reading, firing Edge TTS requests, playback timing and state — lives in the backend, not Gemini. Keep the client dumb and fast; parse JSON server-side into a lightweight playback format the frontend just consumes.

## UI / UX Vision

- Game-style dialogue: character sprite + dialogue window, **typewriter text reveal** synced to the spoken line. Split into sentences or small chunks at a time.
- Narrator gets a customizable sprite and selectable male/female voice (like the existing audiobook generator).
- Sprites over a scene background. **Max ~2 characters on screen for 1:1 scenes.** For group scenes, **spotlight the speaker** (larger/foreground) with others smaller/semi-transparent.
- Optional sprite borders (toggle).
- Click-through advance **or** auto-advance (proceed when a line finishes). Speed settings.
- Periodic check-ins / checkpoints (catch if the listener fell asleep).
- Light/dark mode (media format — avoid blinding at night, brighter by day).
- **Three selectable display styles**:
  1. Pixel-art style dialogue boxes (retro game)
  2. Smooth-edge boxes (modern Final Fantasy-ish)
  3. Subtitle style — no dialogue window, high-contrast captions over the scene, still labels who's speaking
- **Art style toggle**: semi-realistic (clearly AI-gen) vs. pixel-art.

## Offline / Caching (PHASE 2 — down the line)

Optional full local caching of a book (images + audio clips), trading storage for zero latency. Default to streaming with **optional selective caching** (per chapter/book), not whole-library-by-default. Save streamed Edge TTS clips when offline mode is on; otherwise stream straight into the post-processor and to the user. ~50-word note only — storage scales with book size × voice/image variants, so plan compression and pruning early. **Not** part of MVP.

## MVP Scope (build this first)

Plug in a book → get a playable visual experience: distinct characters with individual voices, clear scenes, synced text + sprites + audio over backgrounds, character fade in/out. That's it. **Phase two**: character variants, all three UI presets, offline caching, advanced effects.

## Open items to confirm at handoff

- Provide a sample EPUB (ideally a light novel with embedded images) so EPUB parsing and image-reference extraction can be validated against real data.
- Confirm Cloudflare-first hosting with the local-orchestration fallback structured in from the start.

## Notes on the user's broader toolkit

This slots into an existing ecosystem of reading tools — an audiobook generator (shares the Edge TTS voice setup) and a parallel-reader project (JP/EN ebooks for language learning). Intended as a portfolio piece and a tool the user will personally use (user is dyslexic and values visual aid alongside audio).
