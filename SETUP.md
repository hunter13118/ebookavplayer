# Setup: EbookAVPlayer on a Fresh Machine

Quick reference for bringing up the full stack locally. Every command and path cited directly from repo.

## Prerequisites

- **Node.js 18+** (for `wrangler` + web dev; [package.json:4](package.json#L4))
- **Python 3.10+** (if running local `server/app.py`; optional for web-only work)
- **npm** (ships with Node)
- **Git** (to clone)

## Clone & Install

```bash
git clone <this-repo> && cd ebookavplayer
npm install                          # root devDeps: wrangler, fflate, pngjs
cd web && npm install && cd ..       # web dependencies
```

Verify:
```bash
npm run test:character-merge         # should print "character-merge: all assertions passed"
node --version                       # v18+
npx wrangler --version               # 4.104.0+
```

## Env Setup

```bash
cp .env.example .env
# Edit .env: set GEMINI_API_KEY (or leave blank for AI Studio credentials)
# See .env.example lines 1-7 for free-tier Gemini setup
```

File refs:
- [.env.example:1-50](.env.example) — all toggles and keys
- [.env.example:59-65](.env.example) — local server ports (API_PORT=8600)

## Core Test Suites

All cite real test files in [tests/](tests/).

### Worker logic (no server needed)
```bash
npm run test:character-merge         # [tests/character-merge.test.mjs](tests/character-merge.test.mjs)
npm run test:character-reconcile     # [tests/character-reconcile.test.mjs](tests/character-reconcile.test.mjs)
npm run test:illustration-refs       # [tests/illustration-refs.test.mjs](tests/illustration-refs.test.mjs)
npm run test:external-refs           # [tests/external-refs.test.mjs](tests/external-refs.test.mjs)
npm run test:compile-chapter-playback # [tests/compile-chapter-playback.test.mjs](tests/compile-chapter-playback.test.mjs)
npm run test:ordered-drain           # [tests/ordered-drain.test.mjs](tests/ordered-drain.test.mjs)
```

### Web frontend
```bash
cd web
npm run test                         # Playwright e2e (installs browsers on first run)
npm run build                        # Production bundle
cd ..
```

See [web/package.json](web/package.json) for test/build scripts.

## Run Locally

### Dev Servers (in parallel)

Terminal 1 — Worker at :8600 ([worker/wrangler.toml:12](worker/wrangler.toml#L12)):
```bash
npm run dev:worker
# Runs [scripts/sync-dev-vars.mjs](scripts/sync-dev-vars.mjs) + wrangler dev
# Emulates R2 + KV locally with `.wrangler/state/` files
```

Terminal 2 — Web at :5173:
```bash
cd web && npm run dev
# Vite dev server; proxies /projects/ebookavplayer/api/* to :8600
# See [web/vite.config.js](web/vite.config.js) for proxy config
```

Then open: **http://localhost:5173**

### Local FastAPI Server (legacy; optional)

If you want to use the Python [server/app.py](server/app.py) instead of Cloudflare:

```bash
pip install -r requirements.txt
export GEMINI_API_KEY=<key>
uvicorn server.app:app --port 8600 --reload --reload-dir server
```

See [server/app.py:1](server/app.py) for main FastAPI app definition.

---

## Character Management (New Feature)

A chapter-extracted "Unnamed male protagonist" that's really "Eizo"? Fix it retroactively:

1. **In Settings** (⚙ button in player) → **Characters** tab
   - Lists every character by importance
   - Click a name to rename in-place
   - Pick another character in "Merge into…" dropdown
2. **Result:**
   - All past scenes + lines rewritten (id, sprite, voice)
   - Alias persisted so future chapters land on same canonical ID
   
**API:** [worker/api/v1/characters.js](worker/api/v1/characters.js)
- `PATCH /books/:id/characters/merge {from, to}`
- `PATCH /books/:id/characters/rename {id, name}`

**Logic:** [worker/_shared/character-merge.js](worker/_shared/character-merge.js)
- Merges across analysis.json + playback.json
- Alias applied at extraction time via [chapter-extract-pipeline.js:99-101](worker/_shared/chapter-extract-pipeline.js#L99)

---

## Claude Code Setup

### This Project's CLAUDE.md

Create [.claude/CLAUDE.md](.claude/CLAUDE.md) with:

```markdown
# EbookAVPlayer

Visual audiobook: EPUB → procedurally generated scenes with character voices.

## Local Dev

- **Worker:** `npm run dev:worker` (port 8600)
- **Web:** `cd web && npm run dev` (port 5173)
- **Tests:** `npm run test:character-merge`, etc.

## Key Files

- **Character merge/rename:** [worker/api/v1/characters.js](worker/api/v1/characters.js), [worker/_shared/character-merge.js](worker/_shared/character-merge.js), [web/src/components/CharacterManager.jsx](web/src/components/CharacterManager.jsx)
- **Script extraction:** [worker/_shared/chapter-extract-pipeline.js](worker/_shared/chapter-extract-pipeline.js)
- **Playback compile:** [worker/_shared/compile-playback.js](worker/_shared/compile-playback.js)
- **Voice assignment:** [worker/_shared/voice-assign.js](worker/_shared/voice-assign.js)
- **Web player:** [web/src/components/Player.jsx](web/src/components/Player.jsx)

## Hooks (Settings → Hooks)

```json
{
  "postToolUse": {
    "Bash": "echo 'Command run in ebookavplayer'; rtk gain"
  }
}
```

This calls `rtk gain` after each bash command to show token savings (RTK installed globally).

## Skills

- **graphify**: codebase Q&A via knowledge graph
  - Trigger: `/graphify <question>`
  - Bootstrap: `graphify extract . --backend ollama` (local free LLM)
- **context-mode**: large log/output processing
  - Trigger: `ctx_execute` for analyzing test output, git log, etc.
  - Avoids loading raw 10k-line files into conversation
```

### Hooks Config

Edit [.claude/settings.json](.claude/settings.json) (or create it):

```json
{
  "hooks": {
    "postToolUse": {
      "Bash": "rtk gain --brief"
    }
  }
}
```

This runs RTK token-savings tracker after every bash command. (Requires `rtk` CLI installed: `npm install -g @reachingforthejack/rtk`)

### Skills Setup

#### graphify (Knowledge Graph)

One-time setup for codebase Q&A:

```bash
# Install locally if not already present
npm install -g @reachingforthejack/graphify

# Bootstrap the repo (uses local Ollama, free, no API key)
graphify extract . --backend ollama
# Creates ./graphify-out/ with knowledge graph
```

Then in Claude Code: `/graphify "how does character merge work?"` will query the graph instead of re-reading files.

#### context-mode

For processing large outputs (test logs, git diffs, build results):

```bash
npm install -g @anthropic-ai/claude-code-context-mode
# Or via plugin manager: /config → look for context-mode plugin
```

Usage: When a test produces 1000 lines of output, instead of reading it all:
```bash
npm run test:character-merge 2>&1 | wc -l   # Shows: 1 line
# vs.
ctx_execute node tests/character-merge.test.mjs  # Runs in sandbox, returns summary
```

---

## Testing Workflow

### Unit Tests (No Server)

```bash
npm run test:character-merge
npm run test:character-reconcile
npm run test:illustration-refs
npm run test:compile-chapter-playback
```

All in [tests/](tests/) directory. See [package.json:15-38](package.json#L15-L38) for full list.

### End-to-End (Requires Servers)

```bash
# In terminal 1:
npm run dev:worker

# In terminal 2 (from web/):
npm run dev

# In terminal 3:
cd web && npm run test
```

Playwright specs in [web/tests/](web/tests/). Uses mocked API unless running against real servers.

### Local Debugging

#### Character merge API

Create `test-merge.mjs`:

```javascript
import { onCharacterMergePatch } from "./worker/api/v1/characters.js";
import { mergeCharacterInAnalysis, mergeCharacterInPlayback } from "./worker/_shared/character-merge.js";

const analysis = {
  characters: [
    { id: "unnamed-m", name: "Unnamed male protagonist" },
    { id: "eizo", name: "Eizo" },
  ],
  scenes: [{ present_character_ids: ["unnamed-m"], lines: [{ character_id: "unnamed-m", text: "hi" }] }],
};

const merged = mergeCharacterInAnalysis(analysis, "unnamed-m", "eizo");
console.log("Merged:", merged.characters.map(c => c.id)); // ["eizo"]
```

Run: `node test-merge.mjs`

#### Web component live reload

In [web/src/components/CharacterManager.jsx](web/src/components/CharacterManager.jsx), make a change:
- `npm run dev:web` watches for changes and hot-reloads automatically
- No page refresh needed; just see the update in the browser

#### Inspect playback JSON

After extraction, check:
```bash
cat data/books/<book-id>.json | jq '.characters | keys'
# Lists all character IDs in the compiled book
```

---

## Subagent & Agent Usage with Claude

### Agents for Codebase Exploration

```
User: "Where is character voice assignment wired in?"

Claude (using /Agent with subagent_type: Explore):
- Triggers: Agent(description: "Find voice-assign usage", ...)
- Returns: [voice-assign.js:4], [compile-playback.js:3], [PlayerMenu.jsx:8], ...
- Fast targeted search across the codebase
```

**When to use:**
- Finding where a function is called
- Locating all references to a module
- Mapping data flow (e.g., "trace how character IDs flow from extraction → playback")

### Skills for Deep Dives

```
User: "Explain the character merge architecture"

Claude (using /Skill: graphify):
- Fetches from ./graphify-out/ (if bootstrapped)
- Queries knowledge graph for "character merge" connections
- Returns: relationships, dependencies, file map
```

**When to use:**
- Understanding system architecture
- Finding undocumented connections
- Answering "how do these three modules work together?"

### Workflows for Multi-Phase Work

```
User: "Audit the web components for prop drilling"

Claude (using Workflow):
- Phase 1: Scan all .jsx files for component tree
- Phase 2: Find prop chains > 3 levels (potential refactor)
- Phase 3: Verify useContext/hooks as alternatives
- Returns: findings + recommendations
```

**When to use:**
- Large refactors
- Cross-cutting concerns (security, performance)
- Parallel analysis (multiple files, multiple reviewers)

---

## Troubleshooting

| Issue | Fix |
|---|---|
| `wrangler dev` fails with "port 8600 in use" | Kill other process: `lsof -i :8600 \| kill -9` or set autoPort in launch.json |
| Tests fail with module not found | `npm install` in root + `cd web && npm install` |
| Web dev server proxy errors | Check [web/vite.config.js](web/vite.config.js) `target: 'http://localhost:8600'` |
| Character merge doesn't persist | Ensure VAE_JOBS KV binding is configured in [worker/wrangler.toml:31](worker/wrangler.toml#L31) |
| Graphify bootstrap fails | Install Ollama locally or use `--backend web` (requires API key) |

---

## Next Steps

1. **First time:** `npm install`, `npm run test:character-merge`, `npm run dev:worker` + `npm run dev:web`
2. **Writing code:** Make changes, hit save, see hot-reload in browser or test output
3. **Debugging:** Use Claude with `/Agent` for code location, `/Skill: graphify` for architecture questions
4. **Large refactors:** Use `Workflow` to coordinate multi-phase changes
5. **Commit:** Push to git; CI/CD handles Cloudflare Worker deployment (not covered here)

---

## References

| Topic | File(s) |
|---|---|
| Character management | [characters.js](worker/api/v1/characters.js), [character-merge.js](worker/_shared/character-merge.js), [CharacterManager.jsx](web/src/components/CharacterManager.jsx) |
| Script extraction | [chapter-extract-pipeline.js](worker/_shared/chapter-extract-pipeline.js), [freemium-extract.js](worker/_shared/freemium-extract.js) |
| Voice assignment | [voice-assign.js](worker/_shared/voice-assign.js), [PlayerMenu.jsx](web/src/components/PlayerMenu.jsx) |
| Playback compilation | [compile-playback.js](worker/_shared/compile-playback.js) |
| Web UI | [Player.jsx](web/src/components/Player.jsx), [vite.config.js](web/vite.config.js) |
| Tests | [tests/](tests/) directory, [package.json](package.json) scripts |
| Environment | [.env.example](.env.example), [worker/wrangler.toml](worker/wrangler.toml) |
