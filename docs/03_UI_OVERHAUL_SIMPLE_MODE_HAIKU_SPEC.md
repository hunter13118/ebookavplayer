# UI Overhaul — "Simple Mode" — Implementation Spec

**Audience: an implementing agent (optimized so Claude Haiku can execute it at Opus quality).**
**Read `01_AUDIT_AND_VERDICT.md` and `02_REVOLUTION_ROADMAP.md` first for context. This document is the build order.**

> **⟳ Implemented (July 13).** All 9 tasks are done: `uiMode`/`simpleFontScale` prefs (Task 1), `data-ui` root attribute + `--simple-font-scale` (Task 2), `SimpleLibrary.jsx` (Task 3), `Player.jsx` additive `uiMode === "full"` guards around `chapter-select`/`open-gap-nav`/`show-illustration`/`show-characters`/`progress-scrub`/`progress-time`/`sleep-timer-badge` (Task 4 — the Character Roster sheet is included since it's reachable only via `show-characters`), Simple-mode copy in `App.jsx`/`AddBookSheet.jsx` (Task 5), the scoped `[data-ui="simple"]` CSS block (Task 6), `SimpleSettingsSheet.jsx` (Task 7), the first-run hint + "Use simple view" row in `GlobalSettingsSheet.jsx` (Task 8), and `simple-mode.spec.js` with the existing suite forced to Full Mode via `fixtures.js` (Task 9). `orchestrator.js` is untouched; `npm run build` and the full `playwright test` suite (63/63) are green.

---

## 0. What you are building and why

**The goal, stated as an acceptance test:** a 70-year-old non-technical person (the owner's mother; primary language Vietnamese; comfortable with a phone, not with software) can, on her own, open the app, see her books, tap one, and listen — pausing, resuming, and going back — without ever encountering a technical word, a dead-end error, or a control whose purpose she can't guess. She never needs to open "settings" to succeed.

**The strategy:** introduce one preference, `uiMode`, with two values: `"simple"` (the new default) and `"full"` (everything that exists today, unchanged). Simple Mode **hides** complexity; it does not delete features. Full Mode is exactly the current app. A single toggle moves between them.

**The prime directive for the implementer:** *This overhaul is additive and low-risk by design.* You are (a) adding one preference, (b) creating a small number of NEW files, (c) adding conditional rendering around existing controls (`{uiMode === "full" && <existingThing/>}`), and (d) rewriting user-facing text. **You are not refactoring the orchestrator, the pipeline, the timing engine, or the playback logic. You are not editing `web/src/audio/orchestrator.js` at all.** If a task seems to require touching playback internals, you have misread it — stop and re-read.

---

## 1. Hard guardrails (violating any of these fails the task)

1. **DO NOT modify `web/src/audio/orchestrator.js`.** Not one line. It is the timing authority; it is correct; it is out of scope.
2. **DO NOT modify anything under `web/src/timing/`, `web/src/audio/playSpeech.js`, `web/src/audio/sharedAudioSource.js`, or the `worker/` backend.** Simple Mode is a presentation layer.
3. **DO NOT change any existing `data-testid` attribute.** The Playwright e2e suite in `web/tests/e2e/` depends on them. You may *add* new ones.
4. **DO NOT delete any existing component, prop, or feature.** Full Mode must remain byte-for-byte behaviorally identical to today. Everything you hide in Simple Mode must still render in Full Mode.
5. **DO NOT introduce a new dependency.** No UI library, no icon package, no state library. Use React (already present) and plain CSS. This project's zero-dependency discipline is a feature.
6. **Preserve the existing prefs mechanism.** Use `getPrefs()` / `setPref()` / `KEYS` from `web/src/audio/voicePrefs.js` exactly as the rest of the app does. Do not invent a parallel storage path.
7. **Every task ends green.** After each task, `cd web && npm run build` must succeed and the existing e2e specs must still pass. If a change reddens an existing spec, you broke Full Mode — revert and rethink.

---

## 2. The design system for Simple Mode

Grounded in the existing `web/src/styles.css` custom-property theme (`--bg`, `--panel`, `--text`, `--accent`, etc. — reuse them; do not hardcode colors). Simple Mode layers *size and spacing* on top of the existing palette.

**Tokens to add** (see Task 6 for where). Simple Mode is driven by a single attribute on the root, `data-ui="simple"`, so all Simple styles are scoped and cannot leak into Full Mode:

```css
:root[data-ui="simple"] {
  --simple-tap-min: 56px;      /* every interactive target is >= this tall */
  --simple-font-base: 1.25rem; /* ~20px body; scales up from the default */
  --simple-font-lg: 1.6rem;    /* titles */
  --simple-radius: 18px;       /* soft, friendly corners */
  --simple-gap: 16px;
}
```

**Design rules (apply only under `data-ui="simple"`):**
- **One primary action per screen, and it is the biggest thing.** Library → tap a book. Player → Play/Pause. Nothing competes with it visually.
- **Tap targets ≥ 56px.** Fingers, not cursors. Generous spacing so mis-taps are rare.
- **Text ≥ 20px, high contrast.** Meet WCAG AA (4.5:1) minimum; prefer AA-large everywhere. The existing dark theme already has good contrast; verify light theme too.
- **Words, not icons, for anything non-obvious.** The transport glyphs (▶ ❚❚) are universally understood and stay. But "☰", "✎", gear icons, etc. get replaced with a labeled button ("More" / "Settings") or hidden.
- **No technical vocabulary, ever.** See the copy table in Task 5. "Backend," "pack," "provider," "ingest," "extraction," "offline pack," "cache" — none of these appear in Simple Mode.
- **Failure states give direction, in the app's voice, never an apology or a stack of jargon.** "This book isn't ready yet — it's still being prepared. Check back in a few minutes." not "Backend unreachable — import an offline pack."
- **Respect `prefers-reduced-motion`.** (The app already uses CSS transitions; gate any new motion.)

**What Simple Mode's two screens look like (ASCII intent, not pixel spec):**

```
LIBRARY (simple)                         PLAYER (simple)
┌──────────────────────────┐            ┌──────────────────────────┐
│  My Books          [More] │            │ ‹ Back                    │
├──────────────────────────┤            │                          │
│ ┌──────┐                  │            │   ┌──────────────────┐   │
│ │cover │ The Silver Gate  │            │   │   scene + sprite │   │
│ │      │ ▶ Continue       │  ← 1 book  │   │   (the stage)    │   │
│ └──────┘   Chapter 3      │    = 1 big │   └──────────────────┘   │
├──────────────────────────┤    row     │   ┌──────────────────┐   │
│ ┌──────┐                  │            │   │  “dialogue text” │   │
│ │cover │ Lantern Owl Gate │            │   └──────────────────┘   │
│ │      │ ▶ Play           │            │                          │
│ └──────┘                  │            │      ⏮    ▶ / ❚❚    ⏭     │  ← big
├──────────────────────────┤            │         (that's it)      │
│  ┌────────────────────┐  │            └──────────────────────────┘
│  │  ＋  Add a book     │  │  ← 1 big
│  └────────────────────┘  │    button
└──────────────────────────┘
```

Note what's gone from the Player in Simple Mode vs. today: the chapter dropdown, the gap-nav button, the illustration button, the scrubber, the sleep-timer badge, the per-character voice/art/pipeline settings. All still exist in Full Mode. In Simple Mode the player is: back, stage, dialogue, and the transport dock (which already exists and is already good — `Controls.jsx`).

---

## 3. Prerequisite check (do this before Task 1)

Run these and confirm, so you're editing the tree this spec assumes:

```bash
cd web
test -f src/audio/voicePrefs.js && echo "prefs OK"
test -f src/App.jsx && echo "app OK"
test -f src/components/Player.jsx && echo "player OK"
test -f src/components/Library.jsx && echo "library OK"
test -f src/components/Controls.jsx && echo "controls OK"
grep -c 'data-testid' src/components/Player.jsx   # expect a nonzero count
npm run build                                       # must succeed BEFORE you start
```

If the build is not already green, stop — fix the environment first (likely `npm install`), do not build Simple Mode on a red baseline.

---

## 4. Implementation tasks (in order)

Each task is independently shippable and independently testable. Do them in order; each ends with `npm run build` green.

### Task 1 — Add the `uiMode` preference

**File:** `web/src/audio/voicePrefs.js`

**Edit A —** add the key to `KEYS`:
```js
// add inside the KEYS object, alongside the others:
uiMode: "vae-ui-mode",              // "simple" | "full"
simpleFontScale: "vae-simple-font", // "1" default; optional larger-text bump
```

**Edit B —** add to the object returned by `getPrefs()`:
```js
// add inside the returned object in getPrefs():
uiMode: g(KEYS.uiMode, "simple"),
simpleFontScale: parseFloat(g(KEYS.simpleFontScale, "1")) || 1,
```

**Acceptance:** `getPrefs().uiMode === "simple"` on a fresh profile (no localStorage). `setPref(KEYS.uiMode, "full")` then `getPrefs().uiMode === "full"`. `npm run build` green.

> **Default decision:** default is `"simple"`. Rationale: the mandate is the non-technical user; the owner (a power user) can flip to Full once and it persists. If you (owner) prefer to default yourself to Full, change the default in Edit B to `"full"` — but the *shipped* default for the accessibility goal should be `"simple"`.

---

### Task 2 — Apply the mode to the document root

**File:** `web/src/App.jsx`

There is already this effect for theme:
```js
useEffect(() => { document.documentElement.dataset.theme = prefs.theme; }, [prefs.theme]);
```
**Add an adjacent effect** (do not modify the theme one):
```js
useEffect(() => { document.documentElement.dataset.ui = prefs.uiMode; }, [prefs.uiMode]);
```
This sets `<html data-ui="simple">`, which every Simple-scoped CSS rule keys off. Because it's an attribute on the root, Full Mode (`data-ui="full"`) is completely unaffected — no Simple rule matches.

**Acceptance:** with `uiMode="simple"`, `document.documentElement.dataset.ui === "simple"`. Toggling the pref updates it live. Build green.

---

### Task 3 — Create `SimpleLibrary.jsx` (NEW FILE)

Rather than thread conditionals through the feature-rich `Library.jsx` (which has shelves, sort, multi-select, bulk actions, multi-connection health — all power-user surface), render a **separate, clean component** in Simple Mode. It consumes the *same* `catalog` and `onOpen` the existing Library already receives, so it needs no new data plumbing.

**File:** `web/src/components/SimpleLibrary.jsx` (new)

```jsx
import { resumeIndex } from "../library.js";

/**
 * Simple Mode library: one clean vertical list of books, big tap targets,
 * plain words. Consumes the same catalog + onOpen the full Library uses.
 * Deliberately omits: shelves, sort, multi-select, bulk actions, connection
 * health, drag-and-drop. Those live in Full Mode only.
 */
function bookAction(entry) {
  // A book you've started shows "Continue"; otherwise "Play".
  // A book still processing shows a friendly waiting state and is not tappable.
  if (entry.status === "processing" || (entry.progress != null && entry.progress < 0.45)) {
    return { kind: "processing", label: "Getting your book ready…" };
  }
  if (entry.status === "error") {
    return { kind: "error", label: "Something went wrong. Tap to try again." };
  }
  const resumed = resumeIndex(entry.book_id);
  return resumed && resumed > 0
    ? { kind: "continue", label: "Continue" }
    : { kind: "play", label: "Play" };
}

export default function SimpleLibrary({ catalog = [], onOpen, onAdd, onOpenSettings }) {
  const books = catalog.filter(Boolean);
  return (
    <div className="vae-simple-lib" data-testid="simple-library">
      <header className="vae-simple-lib-head">
        <h1>My books</h1>
        <button
          type="button"
          className="vae-simple-more"
          data-testid="simple-open-settings"
          onClick={onOpenSettings}
        >
          More
        </button>
      </header>

      {books.length === 0 && (
        <p className="vae-simple-empty" data-testid="simple-empty">
          You don’t have any books yet. Tap “Add a book” to begin.
        </p>
      )}

      <ul className="vae-simple-list">
        {books.map((b) => {
          const act = bookAction(b);
          const disabled = act.kind === "processing";
          return (
            <li key={b.book_id} className="vae-simple-row">
              <button
                type="button"
                className={`vae-simple-book vae-simple-book-${act.kind}`}
                data-testid="simple-book"
                disabled={disabled}
                onClick={() => onOpen(b)}
              >
                <span className="vae-simple-cover" aria-hidden>
                  {b.cover ? <img src={b.cover} alt="" /> : <span className="vae-simple-cover-blank" />}
                </span>
                <span className="vae-simple-book-text">
                  <span className="vae-simple-book-title">{b.title || "Untitled book"}</span>
                  <span className={`vae-simple-book-action vae-simple-action-${act.kind}`}>
                    {act.kind === "play" || act.kind === "continue" ? "▶ " : ""}{act.label}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        className="vae-simple-add"
        data-testid="simple-add-book"
        onClick={onAdd}
      >
        ＋ Add a book
      </button>
    </div>
  );
}
```

**Wire it in `App.jsx`:** in the `view === "library"` branch, choose which library to render based on mode. The existing branch renders `<Library ... />`. Change it to:

```jsx
{view === "library" ? (
  prefs.uiMode === "simple" ? (
    <SimpleLibrary
      catalog={catalog}
      onOpen={openBook}
      onAdd={() => setSettingsOpen(false) || openAddFlow()}
      onOpenSettings={() => setSettingsOpen(true)}
    />
  ) : (
    <Library
      catalog={catalog}
      offline={!serverOnline}
      serverOnline={serverOnline}
      onOpen={openBook}
      onCatalog={setCatalog}
      onOpenSettings={() => setSettingsOpen(true)}
      cacheBusy={cacheBusy}
      onContinueExtraction={handleContinueExtraction}
    />
  )
) : ( /* …existing player branch, unchanged… */ )}
```

**"Add a book" in Simple Mode:** the full Library owns the add-book sheet (`AddBookSheet.jsx` via `addOpen` state inside `Library.jsx`). For Simple Mode you need an add entry point at the App level. Simplest correct approach: lift the add flow to App by rendering `AddBookSheet` from App when in Simple Mode, OR (lower-risk) have `onAdd` set a new App-level `simpleAddOpen` state that renders the existing `AddBookSheet` component with the same props Library passes it. Read how `Library.jsx` instantiates `AddBookSheet` (search `AddBookSheet` in that file) and mirror those props exactly. Do not reimplement upload logic — reuse `AddBookSheet`.

**Acceptance:**
- With `uiMode="simple"`, the library shows one row per book, each with cover + title + a "Play"/"Continue"/"Getting your book ready…" label, plus a big "Add a book" button and a "More" button.
- A started book shows "Continue"; an unstarted one shows "Play"; a processing one is disabled and says it's getting ready.
- With `uiMode="full"`, the original `Library.jsx` renders exactly as before.
- Build green; existing `web/tests/e2e/library.spec.js` still passes (it runs in Full Mode — see Task 9 for how to keep the e2e suite in Full Mode).

---

### Task 4 — Simplify the Player via additive conditionals

**File:** `web/src/components/Player.jsx`
**You will add `{uiMode === "full" && ( … )}` wrappers around advanced controls. You will not restructure the component, move state, or touch effects.**

**Step 4a —** the Player receives `prefs`; read the mode near the top of the component body (after the existing destructure of props), with no new prop needed:
```js
const uiMode = prefs?.uiMode || "simple";
```

**Step 4b —** wrap each advanced control's JSX in `{uiMode === "full" && ( … )}`. Locate them by their existing `data-testid` (do not change the testids). The controls to hide in Simple Mode, with their current testids:

| Control | Locate by `data-testid` | Action in Simple Mode |
|---|---|---|
| Chapter dropdown | `chapter-select` | Hide (wrap in `uiMode === "full"`) |
| Gap-nav button | `open-gap-nav` | Hide |
| Illustration button | `show-illustration` | Hide |
| Progress scrubber | `progress-scrub` | Hide the *draggable* scrubber; keep a **non-interactive** thin progress bar if trivial, else hide entirely |
| Progress time readout | `progress-time` | Hide |
| Sleep-timer badge | `sleep-timer-badge` | Hide |
| The settings/menu button | `open-settings` | **Keep**, but it opens the *Simple* settings sheet (Task 7) when `uiMode==="simple"` |

**What stays visible in Simple Mode:** the `Stage` (scene + sprites), the `DialogueBox`, and the `Controls` dock (`player-dock` with rewind/play/pause/next). These are the whole experience. Do not hide them.

**Step 4c — keep the transport, make it bigger.** `Controls.jsx` is already accessible and correct. Do **not** rewrite it. Simple Mode enlarges it via CSS only (Task 6). If the speed pill (`speed-pill`) feels like clutter for the target user, you may hide it in Simple Mode with the same `uiMode==="full"` wrapper *inside `Controls.jsx`* — but that requires passing `uiMode` into `Controls`. If you do: add a `uiMode` prop to `Controls`, default `"full"`, and wrap only the `vae-dock-speed-wrap` block. Speed defaults to 1× which is correct for the target user. (This is optional; hiding it is the friendlier choice.)

**Acceptance:**
- In Simple Mode the player shows only: Back (from App header), Stage, DialogueBox, and the transport dock. No chapter dropdown, gap-nav, illustration, scrubber, sleep timer.
- In Full Mode every one of those controls renders exactly as today.
- Playback itself is byte-for-byte unchanged in both modes (you didn't touch the orchestrator or any handler — only wrapped JSX).
- Build green; existing player-related e2e specs pass in Full Mode.

---

### Task 5 — Rewrite user-facing copy (Simple Mode surfaces only)

Words are the biggest accessibility lever here. In every **Simple Mode surface** (SimpleLibrary, Simple settings sheet, and the App-level `note`/messages when `uiMode==="simple"`), replace technical language per this table. **Do not** change copy in Full-Mode-only components.

| Where it appears | Current (developer-facing) | Simple Mode (plain) |
|---|---|---|
| App `note`, no backend | "No backend — embedded demo only. Import an offline pack or connect the server." | "You’re offline right now. You can still open books you’ve already added." |
| App `note`, unreachable | "Backend unreachable — embedded demo. Import an offline pack for real books." | "Can’t reach your books right now. Check your internet and try again." |
| App `note`, still processing | "Still processing … (text ready ~45%)." | "This book is still being prepared. It’ll be ready in a few minutes." |
| Book row, processing | (spinner / "processing") | "Getting your book ready…" |
| Book row, error | "Ingest failed … Upload the EPUB again." | "Something went wrong. Tap to try again." |
| Add book button | "Upload EPUB" / "Add" (icon) | "＋ Add a book" |
| Add book sheet title | "Add book" / technical | "Add a book" + one line: "Choose an ebook file (it ends in .epub)." |
| Settings entry | "☰" (icon only) | "More" (labeled button) |
| Empty library | (varies) | "You don’t have any books yet. Tap “Add a book” to begin." |

**Rule of thumb for any string you write:** name what the person controls, use active voice, say what will happen, no apology, no jargon. ("Choose an ebook file," not "Select a valid EPUB document for ingestion.") If you're unsure whether a word is jargon, it is — replace it.

**Implementation note:** the App `note` strings live in `App.jsx`'s catalog-fetch and `openBook` logic. Gate the wording on mode: `const msg = prefs.uiMode === "simple" ? SIMPLE_MSG : TECH_MSG;`. Keep the Full-Mode strings exactly as they are.

**Acceptance:** no Simple Mode surface contains any of: "backend," "pack," "offline pack," "provider," "ingest," "extraction," "cache," "EPUB" (except the one gentle "it ends in .epub" hint), "server." Verify with grep against the Simple components.

---

### Task 6 — Add the Simple Mode CSS

**File:** `web/src/styles.css` (append a clearly-commented section at the end; do not edit existing rules)

Add the tokens from §2 and the component styles. Everything is scoped under `:root[data-ui="simple"]` or `[data-ui="simple"] .vae-simple-*` so it **cannot** affect Full Mode. Watch the specificity warning from the design skill: use single-class selectors, don't create competing `.section`/`.cta`-style padding fights.

```css
/* ============================================================
   SIMPLE MODE — scoped entirely under [data-ui="simple"].
   Full Mode (data-ui="full") matches none of these rules.
   ============================================================ */
:root[data-ui="simple"] {
  --simple-tap-min: 56px;
  --simple-font-base: 1.25rem;
  --simple-font-lg: 1.6rem;
  --simple-radius: 18px;
  --simple-gap: 16px;
}
[data-ui="simple"] body { font-size: var(--simple-font-base); }

/* Library */
[data-ui="simple"] .vae-simple-lib { max-width: 640px; margin: 0 auto; padding: 16px; }
[data-ui="simple"] .vae-simple-lib-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--simple-gap); }
[data-ui="simple"] .vae-simple-lib-head h1 { font-size: var(--simple-font-lg); margin: 0; }
[data-ui="simple"] .vae-simple-more { min-height: 44px; padding: 8px 18px; font-size: 1.05rem;
  border-radius: 12px; background: var(--panel); color: var(--text); border: 1px solid var(--box-border); cursor: pointer; }
[data-ui="simple"] .vae-simple-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--simple-gap); }
[data-ui="simple"] .vae-simple-book { display: flex; align-items: center; gap: 16px; width: 100%;
  min-height: 96px; padding: 12px 16px; text-align: left; cursor: pointer;
  background: var(--panel); color: var(--text);
  border: 1px solid var(--box-border); border-radius: var(--simple-radius); }
[data-ui="simple"] .vae-simple-book:disabled { opacity: .7; cursor: default; }
[data-ui="simple"] .vae-simple-cover { flex: 0 0 auto; width: 64px; height: 88px; border-radius: 10px; overflow: hidden; background: var(--bg); }
[data-ui="simple"] .vae-simple-cover img { width: 100%; height: 100%; object-fit: cover; }
[data-ui="simple"] .vae-simple-cover-blank { display: block; width: 100%; height: 100%;
  background: linear-gradient(135deg, var(--panel), var(--box-border)); }
[data-ui="simple"] .vae-simple-book-text { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
[data-ui="simple"] .vae-simple-book-title { font-size: 1.2rem; font-weight: 600; line-height: 1.25;
  overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
[data-ui="simple"] .vae-simple-book-action { font-size: 1.05rem; color: var(--accent); font-weight: 600; }
[data-ui="simple"] .vae-simple-action-processing { color: var(--muted); font-weight: 500; }
[data-ui="simple"] .vae-simple-action-error { color: var(--danger); }
[data-ui="simple"] .vae-simple-add { display: block; width: 100%; min-height: var(--simple-tap-min);
  margin-top: 24px; padding: 16px; font-size: 1.25rem; font-weight: 700; cursor: pointer;
  color: #fff; background: var(--accent); border: none; border-radius: var(--simple-radius); }
[data-ui="simple"] .vae-simple-empty { color: var(--muted); font-size: 1.1rem; text-align: center; margin: 32px 0; }

/* Player: enlarge the existing dock; hide anything that slipped through */
[data-ui="simple"] .vae-dock-skip { width: var(--simple-tap-min); height: var(--simple-tap-min); }
[data-ui="simple"] .vae-dock-play { width: 76px; height: 76px; }
[data-ui="simple"] .vae-dock-icon-lg { font-size: 2rem; }
[data-ui="simple"] .vae-back { min-height: 44px; font-size: 1.1rem; }

/* Motion: respect reduced-motion for any Simple-only animation you add */
@media (prefers-reduced-motion: reduce) {
  [data-ui="simple"] * { transition: none !important; animation: none !important; }
}
```

**Acceptance:** in Simple Mode, book rows and the transport are visibly larger; nothing in Full Mode changed (diff the rendered Full Mode against `main` — should be identical). Both themes (dark default, light) remain readable; check contrast on `--muted` text against `--panel` in light mode and darken `--muted` slightly *only if* it fails 4.5:1 (and if you do, do it in the light theme block, not inline).

---

### Task 7 — Create `SimpleSettingsSheet.jsx` (NEW FILE) and route to it

The current settings surfaces (`GlobalSettingsSheet.jsx`, and the in-player `PlayerMenu.jsx`) are dense power-user panels (art style, extraction provider, re-extract, replace art, plates, pipeline, per-character voices with chapter filters). **None of that belongs in Simple Mode.** Create a minimal sheet with only what a listener needs, plus the escape hatch to Full Mode.

**File:** `web/src/components/SimpleSettingsSheet.jsx` (new)

Contents — exactly these controls, nothing more:
1. **Bigger text** — a toggle or 3-step size control writing `KEYS.simpleFontScale` (1 / 1.15 / 1.3), applied by multiplying `--simple-font-base` (add a small effect in App that sets a CSS var from the pref).
2. **Day / Night** — theme toggle, writing `KEYS.theme` (reuse existing `setPref`, mirror how `GlobalSettingsSheet` does it). Label them "Day" (light) and "Night" (dark), not "light/dark theme."
3. **Narrator voice** — a simple two-choice "Man's voice / Woman's voice," writing `KEYS.narratorGender`. (This maps to the existing narrator voice defaults already in `voicePrefs.js`.) Do not expose per-character voices in Simple Mode.
4. **Reading speed** — three buttons: "Slower / Normal / Faster" → `KEYS.speed` = 0.85 / 1 / 1.15. Not a slider, not a numeric field, in Simple Mode.
5. **"Show advanced options"** — a clearly secondary button at the bottom that does `setPref(KEYS.uiMode, "full")` and updates app state. Copy: "Show advanced options" with a one-line hint "Turns on chapters, art, voices, and more." This is the one-way (well, reversible) door to the full app.

Model the sheet's open/close and backdrop on the existing `PlayerMenu.jsx` sheet markup (`vae-sheet-backdrop` / `vae-sheet` classes) so it looks native and you reuse existing sheet CSS. It takes `open`, `onClose`, `prefs`, `setPrefs` props — same shape as `GlobalSettingsSheet`.

**Routing:** in `App.jsx`, when `uiMode==="simple"`, render `<SimpleSettingsSheet>` instead of `<GlobalSettingsSheet>` for the settings entry point. In the Player, when `uiMode==="simple"`, the `open-settings` button opens this simple sheet (you may hoist a callback, or render the simple sheet from App and have the player call an `onOpenSimpleSettings` prop). Keep `GlobalSettingsSheet` and `PlayerMenu` fully intact for Full Mode.

**Acceptance:** in Simple Mode, "More" / the player settings button opens a sheet with exactly the five items above. "Show advanced options" flips `uiMode` to `"full"` and the full app (with the original settings sheets) is immediately available and persists across reload. No provider/pipeline/character/plates controls are reachable from any Simple Mode surface.

---

### Task 8 — First-run and the reversible door

**Goal:** the very first time the app opens (empty localStorage), it's in Simple Mode (Task 1 default handles this). Add a tiny, dismissible first-run hint on the Simple library the first time only: a one-line banner "Tip: tap a book to start listening." stored via a `setPref("vae-simple-seen-hint", "1")`. Keep it a single sentence; dismiss on any tap.

**The door back to Simple:** Full Mode's existing `GlobalSettingsSheet.jsx` should gain one row: "Use simple view" → `setPref(KEYS.uiMode, "simple")`. This makes the toggle symmetric (Simple→Full via "Show advanced options"; Full→Simple via "Use simple view"). This is the *only* edit to a Full-Mode component's behavior in this whole spec, and it's purely additive (one new row).

**Acceptance:** fresh profile boots into Simple Mode with a one-time hint. A user can move Simple↔Full from each mode's settings and it persists.

---

### Task 9 — Tests (keep the suite honest)

**Keep existing e2e in Full Mode.** The Playwright specs assume the full UI. The cleanest way: have the e2e bootstrap force Full Mode so existing specs are unaffected. In `web/tests/e2e/fixtures.js` (the shared setup), where it already sets `localStorage['vae-e2e']='1'`, also set `localStorage['vae-ui-mode']='full'`. This one line keeps all ~20 existing specs valid without editing them individually.

**Add new Simple Mode specs.** Create `web/tests/e2e/simple-mode.spec.js` covering the core journey. Model structure/mocking on an existing spec (e.g. `library.spec.js`, `controls.spec.js`) — reuse their API-mock fixtures. Cases:

1. **Boots simple by default:** fresh context (no `vae-ui-mode`), app shows `[data-testid="simple-library"]` and NOT the full `[data-testid="library-toolbar"]`.
2. **Book list is plain:** each `[data-testid="simple-book"]` shows a title and a "Play" or "Continue" label; a processing book is `disabled` and shows the "getting ready" text.
3. **Open and play:** tapping a ready `simple-book` enters the player; `[data-testid="player-dock"]` is present; chapter dropdown `[data-testid="chapter-select"]` is **absent**; `[data-testid="show-illustration"]` is **absent**.
4. **Play/Pause/Back work:** `[data-testid="play"]` → `[data-testid="pause"]` appears; Back returns to the simple library. (Reuse the Audio stub the existing controls spec uses — do not test real audio.)
5. **No jargon:** assert the simple library and simple settings DOM text does not contain `/backend|offline pack|provider|ingest|extraction/i`.
6. **Escape hatch:** open simple settings → "Show advanced options" → `[data-testid="library-toolbar"]` (full) now renders; reload → still full.

**Acceptance:** `npm run test:e2e` passes with both the (Full-Mode-forced) existing specs and the new `simple-mode.spec.js`. `npm run build` green.

---

## 5. Definition of done (the whole overhaul)

- [ ] Fresh profile boots into Simple Mode; a non-technical user can open→play→pause→resume→back with zero jargon and no dead ends.
- [ ] Simple Mode surfaces contain no technical vocabulary (grep-verified per Task 5).
- [ ] All tap targets in Simple Mode are ≥ 56px; body text ≥ 20px; contrast ≥ WCAG AA in both day and night.
- [ ] Full Mode is behaviorally identical to `main` (the orchestrator, pipeline, timing, and all existing components are untouched except the two additive rows in Tasks 7–8 and JSX conditionals in Task 4).
- [ ] `web/src/audio/orchestrator.js` diff vs `main` is **empty**.
- [ ] No existing `data-testid` changed; no new runtime dependency added.
- [ ] `cd web && npm run build` green; `npm run test:e2e` green (existing specs forced to Full Mode + new `simple-mode.spec.js`).
- [ ] Simple↔Full toggle is reachable from both modes and persists across reload.

## 6. If you get stuck

- **A task seems to need orchestrator/pipeline changes** → you've misread; Simple Mode is presentation-only. Re-read §0 and §1.
- **An existing e2e spec goes red** → you changed Full Mode behavior or a testid. Revert that change; the fix is almost always "wrap in `uiMode==='full'`" not "modify the existing thing."
- **"Add a book" wiring is unclear in Simple Mode** → read exactly how `Library.jsx` renders `AddBookSheet` (its props and the `addOpen` state) and mirror that at the App level. Reuse `AddBookSheet`; never reimplement upload.
- **Copy uncertainty** → shorter and plainer wins. Name what the person taps; say what happens; no apology; no jargon.

---

*This spec is intentionally additive and reversible. Done correctly, it gives the owner's mother an app she can use on her own, gives the owner the full power tool one tap away, and doesn't put a scratch on the excellent playback core that makes this project special.*
