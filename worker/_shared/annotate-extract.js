/**
 * Annotate-in-place LLM enrichment (Plan One Phase 2 — see
 * ~/.claude/plans/declarative-plotting-flamingo.md). Generalizes
 * dialogue-attribute-llm.js's existing narrow "assign character_id by idx,
 * never rewrite text" contract (used today only for ambiguous multi-speaker
 * scene cleanup) into the PRIMARY per-chapter path: given
 * mechanical-script.js's already-split, already-verbatim lines, the model
 * only (1) declares the character roster and (2) assigns a speaker to each
 * dialogue line by idx — it never rewrites, re-splits, reorders, or invents
 * a single line of text. This eliminates the drift risk (and the need for
 * verbatim-coverage.js's after-the-fact repair pass) that full-regeneration
 * extraction (freemium-extract.js's extractChapterRaw) carries, at a much
 * lower LLM cost per chapter.
 *
 * No scene-stitching or line-merging machinery is needed (unlike
 * freemium-extract.js's mergeAnalysisDicts/mergeChapterScenes) — the lines
 * are already fixed before any LLM call, one scene per chapter (matching
 * mechanical-script.js's own granularity); only idx-keyed reassignment
 * across token-budget batches.
 */
import { freemiumExtract, resolveMaxChunkTokens } from "./freemium-extract.js";
import { buildMechanicalChapterLines } from "./mechanical-script.js";

const ANNOTATE_SYSTEM = `You annotate an already-segmented visual-audiobook script.
The lines are FIXED and VERBATIM. You must NEVER add, remove, reorder, re-split,
merge, or rewrite any line's text. You only (1) identify the speaking characters
and (2) assign a speaker to each dialogue line by its idx.

CHARACTERS — the roster of who speaks in this chapter:
  { "id": "lowercase-slug", "name": "string", "aliases": ["string"],
    "gender": "male|female|unknown", "importance": "primary|secondary|background",
    "description": "one sentence of visual appearance if the text gives it, else \\"\\"",
    "temperament": "one or two words, or \\"\\"" }
  - If a KNOWN CHARACTERS list is given, REUSE an existing id EXACTLY when the
    speaker matches one by name, alias, role, or description. Only invent a new
    id for a genuinely new character. Never merge two known characters; never
    invent an alias-style id ("the blacksmith", "he") for someone already known.
  - Be conservative with importance:"primary".

ASSIGNMENTS — for EVERY line whose kind is "dialogue", give the speaker's
character_id, keyed by that line's idx. Decide using:
  - adjacent narration speech tags ("he said", "said Mei") — a tag attributes the
    ADJACENT dialogue line, usually the one right before it;
  - turn-taking — alternate speakers among those present when there is no tag;
  - self-identification in the dialogue ("I'm Mei", "My name is Kuro") overrides turn order;
  - gender and the character roster.
  Never assign a character_id to a kind="narration" line. Never change any text.

Output JSON only:
{ "characters": [ ...roster... ],
  "assignments": [ { "idx": number, "character_id": "slug" } ] }
Include one assignment per dialogue line; each idx MUST match an input line's idx.`;

export function isAnnotateEnabled(env) {
  return String(env?.VAE_ANNOTATE_LLM ?? "false").toLowerCase() === "true";
}

// Reserve headroom for the system prompt + known-character briefs; the rest
// of the budget is line text. Mirrors freemiumExtractBookByChapter's own
// resolveMaxChunkTokens-based chunking, just applied to already-split lines
// instead of raw prose.
function batchLinesByBudget(lines, env) {
  const budgetChars = Math.max(2000, resolveMaxChunkTokens(env) * 4 - 4000);
  const batches = [];
  let cur = [];
  let curChars = 0;
  for (const ln of lines) {
    const c = (ln.text || "").length + 24; // idx/kind JSON overhead
    if (cur.length && curChars + c > budgetChars) {
      batches.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(ln);
    curChars += c;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

function briefs(chars) {
  return (chars || []).filter((c) => c.id && c.id !== "narrator").map((c) => ({
    id: c.id, name: c.name || c.id, gender: c.gender || "unknown",
    description: String(c.description || "").slice(0, 200),
  }));
}

function buildBatchUser(chapter, roster, batchLines) {
  const payload = {
    chapter: chapter.index,
    chapter_title: chapter.title || "",
    known_characters: briefs(roster),
    lines: batchLines.map((ln) => ({ idx: ln.idx, kind: ln.kind || "narration", text: ln.text })),
  };
  return `Annotate this chapter. Reuse known_characters ids where they match; `
    + `assign character_id for every dialogue line by idx; never change text.\n\n${JSON.stringify(payload, null, 2)}`;
}

/** idx-keyed, dialogue-only — mirrors dialogue-attribute-llm.js's
 * applyAssignments invariant: narration lines and line text are never
 * touched, only a matching dialogue line's character_id. */
function applyAssignments(lines, assignments) {
  const byIdx = new Map((assignments || []).filter((a) => a?.character_id).map((a) => [a.idx, a.character_id]));
  for (const ln of lines) {
    if (ln.kind !== "dialogue") continue;
    const cid = byIdx.get(ln.idx);
    if (cid) {
      ln.character_id = cid;
      ln.attribution_source = "annotate";
    }
  }
}

/** Known/earlier declarations win — preserves cross-batch/cross-chapter
 * continuity the same way chapter-extract-pipeline.js's
 * getKnownCharacters()/mergedAnalysisCharacters already does for the LLM
 * full-regeneration path. */
function mergeRoster(existing, declared) {
  const byId = new Map(existing.map((c) => [c.id, c]));
  for (const c of declared || []) {
    if (!c?.id || c.id === "narrator") continue;
    if (!byId.has(c.id)) byId.set(c.id, c);
  }
  return [...byId.values()];
}

/**
 * Annotate one chapter's mechanical lines in place — LLM only assigns
 * speakers + declares the character roster, never touches text/boundaries.
 * @returns {Promise<{chapterAnalysis: {characters:object[], scenes:object[], chapterIndex:number, chapterTitle:string}, provider:string, model:string}>}
 */
export async function annotateChapter({
  chapter, chapterText, knownCharacters = [], env, preferProvider, onProgress,
}) {
  // Same split lines the instant mechanical baseline uses (no illustrations
  // here — see the plan's "Illustrations" note: deferred, matching BookNLP's
  // own gap, not wired up for this slice).
  const mechLines = buildMechanicalChapterLines(chapterText, [], {});
  const lines = mechLines.map((ln, idx) => ({ ...ln, idx }));

  const batches = batchLinesByBudget(lines, env);
  let roster = mergeRoster([], knownCharacters);
  let usedProvider = preferProvider || null;
  let usedModel = "";

  for (let b = 0; b < batches.length; b += 1) {
    onProgress?.({ batch: b + 1, batchTotal: batches.length });
    const user = buildBatchUser(chapter, roster, batches[b]);
    const result = await freemiumExtract(user, { systemPrompt: ANNOTATE_SYSTEM, preferProvider, env });
    if (!usedProvider) usedProvider = result.provider;
    if (!usedModel) usedModel = result.model;
    const data = result.data || {};
    roster = mergeRoster(roster, data.characters);
    applyAssignments(lines, data.assignments || data.lines || []);
  }

  const speakers = [...new Set(
    lines.filter((l) => l.kind === "dialogue" && l.character_id).map((l) => l.character_id),
  )];
  const characters = roster.map((c) => ({ ...c, importance: c.importance || "secondary" }));
  const chapterAnalysis = {
    characters,
    scenes: [{
      id: "scene-0001", // compileChapterPlayback re-qualifies with the chapter index anyway
      chapter: chapter.index,
      title: chapter.title || `Chapter ${chapter.index}`,
      location: "",
      present_character_ids: speakers,
      lines: lines.map(({ idx, ...rest }) => rest), // drop the batching-local idx; compile re-numbers
    }],
    chapterIndex: chapter.index,
    chapterTitle: chapter.title || "",
  };
  return { chapterAnalysis, provider: usedProvider, model: usedModel };
}
