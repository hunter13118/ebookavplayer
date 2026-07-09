/**
 * "Who's pictured in this plate" — a narrow, LLM-backed pass that reads an
 * illustration plate's nearby text (already captured at extraction time,
 * see epub-images.js's textContext) plus a chapter's known character
 * roster, and decides which character (if any) the plate clearly depicts.
 * Confirmed-only: the model is told to answer "none" rather than guess, same
 * spirit as expression-repass.js's dialogue tagging — a wrong guess here is
 * worse than no guess, since it becomes that character's reference image
 * for future portrait generation.
 *
 * Deliberately does NOT crop the plate to just the character's face — no
 * image-manipulation capability exists anywhere in this codebase (no
 * canvas/sharp equivalent, and no Cloudflare Images binding configured), so
 * a matched plate is used whole. See docs/TODO_ILLUSTRATIONS_PROFILES_POLISH.md
 * for that follow-up.
 */
import { freemiumExtract } from "./freemium-extract.js";

const MATCH_TEMPERATURE = 0.2;

const SYSTEM_PROMPT = `You are matching illustration plates from a novel to the characters they depict.
For each numbered plate below, you're given the text immediately before/after where the plate
appears in the book, plus a list of known characters (id, name, description). Decide which ONE
character, if any, the plate clearly depicts — going only on the surrounding text, not the image
itself (you cannot see it). If the text doesn't make it clear, or describes a scene/group/object
rather than one specific character, answer null. Do not guess — a wrong match is worse than no match.
Return exactly: {"matches": [{"plate": 0, "character_id": "kuro"}, ...]} — one entry per plate given,
character_id is null when not confidently identifiable, nothing else in the response.`;

function buildPrompt(plates, characters, chapterTextSnippet) {
  const roster = characters
    .map((c) => `- ${c.id}: ${c.name}${c.description ? ` — ${c.description}` : ""}`)
    .join("\n");
  // A plate's own textNear() context is frequently useless — plates
  // conventionally live on their own dedicated, nearly-empty spine page
  // (just an <img> tag), so the "nearby text" captured there is often just
  // that page's own XML boilerplate, not narrative prose. Ground the match
  // in the actual opening of the chapter this plate was matched to instead
  // (matchIllustrationsToChapters already established that a plate attaches
  // to the chapter it precedes) — that's where the real "who's in this
  // scene" signal lives.
  const chapterHint = chapterTextSnippet
    ? `\n\nOpening of the chapter this plate precedes:\n"${chapterTextSnippet.slice(0, 600)}"`
    : "";
  const plateList = plates
    .map((p, i) => {
      const own = (p.textContext || "").trim();
      return `${i}.${own ? ` [plate's own nearby text: "${own.slice(0, 200)}"]` : " [no usable text near the plate itself]"}`;
    })
    .join("\n");
  return `Known characters in this chapter:\n${roster}\n\nPlates:\n${plateList}${chapterHint}`;
}

/**
 * @param {Map<number, Array<{index:number, textContext:string}>>} illustrationsByChapterPos
 *   chapterPos -> plates near that chapter (see matchIllustrationsToChapters).
 * @param {Array<{id, name, description}>} allCharacters known character roster (whole book).
 * @param {Array<{text?: string}>} chapters parsed EPUB chapters (same array/positions
 *   matchIllustrationsToChapters was given) — used for chapterTextSnippet fallback context.
 * @param {{env, preferProvider?}} opts
 * @returns {Promise<Map<number, string>>} plate index -> matched character id
 */
export async function matchPlatesToCharacters(illustrationsByChapterPos, allCharacters, chapters, { env, preferProvider } = {}) {
  const results = new Map();
  if (!illustrationsByChapterPos?.size || !allCharacters?.length) return results;

  const byId = new Map(allCharacters.map((c) => [c.id, c]));

  for (const [chapterPos, plates] of illustrationsByChapterPos) {
    if (!plates?.length) continue;
    // No chapter-scoped character list is threaded through
    // matchIllustrationsToChapters today — match against the whole book's
    // roster instead. A wrong-chapter false positive is still guarded
    // against by the "don't guess" instruction above.
    const characters = allCharacters.filter((c) => c.id !== "narrator");
    if (!characters.length) continue;

    const chapterTextSnippet = chapters?.[chapterPos]?.text || "";
    const userText = buildPrompt(plates, characters, chapterTextSnippet);
    let data;
    try {
      ({ data } = await freemiumExtract(userText, {
        systemPrompt: SYSTEM_PROMPT,
        preferProviderSoft: preferProvider || "ollama-7b",
        env,
        temperature: MATCH_TEMPERATURE,
      }));
    } catch {
      continue; // best-effort — one chapter's failure shouldn't lose the rest
    }

    const matches = Array.isArray(data) ? data : (data?.matches || []);
    for (const m of matches) {
      const plateIdx = plates[m?.plate]?.index;
      if (plateIdx == null) continue;
      const cid = m?.character_id;
      if (!cid || !byId.has(cid)) continue;
      if (!results.has(plateIdx)) results.set(plateIdx, cid);
    }
  }

  return results;
}
