/**
 * Mechanical (non-LLM) script builder — the fast path that makes an
 * attached m4b's book immediately readable, before any LLM extraction runs
 * at all. Splits each chapter's already-verbatim EPUB text
 * (`epub-text.js`'s `chapters[].text`) into sentence-level lines (further
 * split at quote boundaries into narration/dialogue sub-lines — see
 * `segmentByQuotes` — so a later enrichment pass, LLM or BookNLP, only ever
 * has to patch `character_id`, never re-split text), and slots each
 * chapter's illustrations (already mechanically matched by
 * `matchIllustrationsToChapters` in chapter-extract-pipeline.js — no change
 * needed there) into their best-matching position using the image's own
 * `textContext` (the surrounding raw text `epub-images.js` already
 * captures) — no HTML/marker parsing needed, no LLM guess needed.
 *
 * Every line is voiced by the narrator until something enriches
 * `character_id` — including `kind:"dialogue"` lines, which render
 * quote-wrapped and per-line from the start, just narrator-voiced in the
 * meantime (no regression from the all-narrator baseline this replaces).
 *
 * Every line this produces already compiles and plays correctly as-is
 * (`compile-playback.js` defaults character_id/kind/expression/voice
 * cleanly for a plain narrator line) — an LLM enrichment pass only ever
 * PATCHES fields on top of these lines later (see chapter-extract-pipeline.js's
 * runCheckpointedExtraction), never regenerates the text itself, so there's
 * nothing for a verbatim-coverage repair pass to ever need to catch on this
 * path.
 *
 * `buildMechanicalScenes`/`buildMechanicalCharacters` output ALREADY-COMPILED
 * playback shape (idx, voice, pitch, rate, expression, environment,
 * intensity, illustration_url) — deliberately NOT run back through
 * `compilePlayback()`, since that function resolves illustration_url only
 * via a separate `media.inserts` map keyed by the FINAL post-chunking lineIdx
 * (a chicken-and-egg problem here), not by reading a line's own field.
 * Writing the final shape directly here keeps that indirection out of the
 * fast path entirely.
 */
import { narratorVoice } from "./voice-assign.js";

function illustrationCaption(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  return t.length > 72 ? `${t.slice(0, 72).trim()}…` : t;
}

/** The one character a mechanical script ever has — same shape
 *  compile-playback.js's compilePlayback() builds for narrator, so an
 *  enrichment pass replacing/extending `characters` later is a drop-in. */
export function buildMechanicalCharacters(narratorGender = "male") {
  const voice = narratorVoice(narratorGender);
  return {
    narrator: {
      name: "Narrator", importance: "primary", gender: narratorGender,
      sprite: "sprite:narrator", voice, pitch: "+0Hz", rate: "+0%", description: "",
    },
  };
}

// Trailing punctuation/quote/bracket characters that stay glued to the
// sentence-ending mark they follow (e.g. `."` `!”` `?)`), not a new sentence.
const TRAILING_GLUE_RE = /[.!?"'”’)\]]/;

/**
 * Character-scan sentence splitter — guaranteed lossless (every input
 * character ends up in exactly one output sentence), unlike a regex
 * requiring whitespace after `[.!?]` (epub-text.js's chunkChaptersStrict
 * uses that pattern for LLM-chunk budgeting, where a dropped boundary just
 * means one chunk absorbs more text — harmless there since the full text
 * still gets sent; NOT harmless here, where each "sentence" becomes its own
 * standalone line with nothing else picking up the slack). Confirmed
 * against a real book: a title like "The War Will Continue...But For Now"
 * (ellipsis directly glued to the next word, no space) made the
 * whitespace-requiring regex skip straight past "The War Will Continue...",
 * silently dropping it — this splitter processes every character exactly
 * once, so that's structurally impossible here.
 */
function splitSentences(text) {
  const raw = String(text || "");
  const out = [];
  let current = "";
  for (let i = 0; i < raw.length; i += 1) {
    current += raw[i];
    if (/[.!?]/.test(raw[i])) {
      while (i + 1 < raw.length && TRAILING_GLUE_RE.test(raw[i + 1])) {
        i += 1;
        current += raw[i];
      }
      const trimmed = current.trim();
      if (trimmed) out.push(trimmed);
      current = "";
    }
  }
  const trimmed = current.trim();
  if (trimmed) out.push(trimmed);
  return out;
}

function wordSet(text) {
  return new Set(String(text || "").toLowerCase().match(/[a-z0-9']+/g) || []);
}

// Minimum shared words before a textContext snippet is trusted to place an
// image at a specific sentence rather than falling back to "end of chapter"
// — same reasoning MIN_ANCHOR_BLOCK_WORDS-style floors use elsewhere in this
// codebase (server.py, verbatim-coverage.js): a couple of coincidentally
// shared common words isn't real positional signal.
const MIN_CONTEXT_OVERLAP = 3;

/**
 * Which sentence (by index) an image's surrounding text (`textContext` —
 * epub-images.js's ±400-char snippet, tags stripped) most likely sits right
 * after, scored by shared-word overlap against each candidate sentence.
 * Returns -1 if nothing clears MIN_CONTEXT_OVERLAP (caller falls back to the
 * chapter's last line — still shows the image, just not precisely placed).
 */
export function bestInsertionLine(sentences, textContext) {
  const ctxWords = wordSet(textContext);
  if (!ctxWords.size) return -1;
  let bestIdx = -1;
  let bestScore = 0;
  sentences.forEach((sentence, i) => {
    let score = 0;
    for (const w of wordSet(sentence)) if (ctxWords.has(w)) score += 1;
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  });
  return bestScore >= MIN_CONTEXT_OVERLAP ? bestIdx : -1;
}

// Double-quote delimiters only (straight " and curly “ ”) — single ' is NOT
// a delimiter: it's ambiguous with a contraction/possessive ("Kosuke's",
// "don't"), and dialogue almost never uses single quotes as its primary
// delimiter in practice. Scoped out of v1, same as BookNLP's own
// server.py — a single-quote line just stays narration, no regression.
const QUOTE_CHARS_RE = /["“”]/;

/**
 * Region-level quote segmentation: scans the WHOLE chapter (not sentence by
 * sentence — see below for why) and pairs every opening quote mark with its
 * next closing one, regardless of how many sentence-ending marks fall in
 * between. A multi-sentence quote — the dominant light-novel dialogue style
 * ("It is cold. The wind howls," she said.) — becomes ONE dialogue region
 * spanning both sentences, matching how BookNLP's own quote-span walk
 * (scripts/local-booknlp-server/server.py) already works.
 *
 * This MUST run before sentence-splitting, not after: `splitSentences`
 * breaks on `.!?`, so a per-sentence quote-scan would see a multi-sentence
 * quote as two already-unbalanced fragments and fall back to narration for
 * both — silently failing to split the majority of real dialogue.
 *
 * Lossless: every character lands in exactly one region; only the enclosing
 * quote marks themselves are dropped from a dialogue region's text (never
 * regenerated/rewritten) — verbatim-coverage.js's word-tokenizer already
 * elides punctuation, so this can never register as "missing" text, and it
 * matches the reader's own convention (web/src/reader/paragraphs.js adds
 * curly quotes back around any kind:"dialogue" line, unconditionally).
 * @returns {{type: "narration"|"dialogue", text: string}[]}
 */
export function segmentByQuotes(text) {
  const raw = String(text || "");
  if (!QUOTE_CHARS_RE.test(raw)) return [{ type: "narration", text: raw }];
  const regions = [];
  let i = 0;
  let narrStart = 0;
  const n = raw.length;
  while (i < n) {
    const ch = raw[i];
    if (ch !== "“" && ch !== '"') { i += 1; continue; }
    const close = ch === "“" ? raw.indexOf("”", i + 1) : raw.indexOf('"', i + 1);
    if (close === -1) break; // unbalanced open — conservative: rest stays narration
    if (i > narrStart) regions.push({ type: "narration", text: raw.slice(narrStart, i) });
    regions.push({ type: "dialogue", text: raw.slice(i + 1, close) });
    i = close + 1;
    narrStart = i;
  }
  if (narrStart < n) regions.push({ type: "narration", text: raw.slice(narrStart) });
  return regions;
}

/**
 * Build one chapter's mechanical, verbatim lines — narration sentence-split,
 * dialogue split off at quote boundaries (see `segmentByQuotes`) with no
 * `character_id` yet (unresolved, pending enrichment) — with illustrations
 * already attached at their best-guessed position.
 * @param {string} chapterText  Verbatim chapter text (epub-text.js).
 * @param {{index:number, textContext:string}[]} chapterImages  This
 *   chapter's images, from matchIllustrationsToChapters's byChapterPos.
 * @param {Record<number,string>} illustrationUrls  index -> real /media/ URL.
 * @returns {{character_id?:string, kind:string, text:string, illustration_url?:string}[]}
 */
export function buildMechanicalChapterLines(chapterText, chapterImages, illustrationUrls) {
  const regions = segmentByQuotes(chapterText);
  const lines = [];
  // Scoring text per emitted line, 1:1 with `lines` even when one region
  // (dialogue) or one sentence (narration) becomes multiple lines — keeps
  // bestInsertionLine a clean index-aligned lookup either way.
  const anchorTexts = [];
  for (const region of regions) {
    if (region.type === "dialogue") {
      const t = region.text.trim();
      if (t) { lines.push({ kind: "dialogue", text: t }); anchorTexts.push(t); }
    } else {
      for (const s of splitSentences(region.text)) {
        lines.push({ character_id: "narrator", kind: "narration", text: s });
        anchorTexts.push(s);
      }
    }
  }
  if (!lines.length) return lines;

  for (const img of chapterImages || []) {
    const url = illustrationUrls?.[img.index];
    if (!url) continue;
    const insertAt = bestInsertionLine(anchorTexts, img.textContext);
    const target = insertAt >= 0 ? lines[insertAt] : lines[lines.length - 1];
    // First image wins if two land on the same line (illustration_url is a
    // single slot) — rare (adjacent images with no text between them);
    // still shown, just not both at once.
    if (target && !target.illustration_url) target.illustration_url = url;
  }
  return lines;
}

/**
 * Build the whole book's mechanical scenes — one scene per real chapter
 * (finer scene grouping is an LLM-enrichment concern, see
 * chapter-extract-pipeline.js), lines flattened with a running idx and
 * already in final playback shape (voice/pitch/rate/expression/environment/
 * intensity), same fields `compilePlayback()` would set for an all-narrator
 * line, computed directly here instead.
 * @param {{index:number, title:string, text:string}[]} chapters
 * @param {Map<number, {index:number, textContext:string}[]>} illustrationsByChapterPos
 * @param {Record<number,string>} illustrationUrls
 * @param {{narratorGender?: string}} [opts]
 * @returns {{scenes: object[], lineCount: number}}
 */
export function buildMechanicalScenes(chapters, illustrationsByChapterPos, illustrationUrls, opts = {}) {
  const voice = narratorVoice(opts.narratorGender || "male");
  const scenes = [];
  let lineIdx = 0;
  chapters.forEach((chapter, chapterPos) => {
    const chapterImages = illustrationsByChapterPos?.get(chapterPos) || [];
    const mechanicalLines = buildMechanicalChapterLines(chapter.text, chapterImages, illustrationUrls);
    const lines = mechanicalLines.map((line) => {
      // Read from the mechanical line rather than hardcoding — a
      // quote-split dialogue line (segmentByQuotes) has kind:"dialogue" and
      // no character_id yet (unresolved, pending enrichment); narration
      // lines are unaffected (same values as before, now read instead of
      // hardcoded). Mechanical never resolves a real speaker name, so
      // speaker_name/voice stay Narrator's until a later pass patches
      // character_id.
      const cid = line.character_id || "narrator";
      const kind = line.kind || (cid === "narrator" ? "narration" : "dialogue");
      const lineOut = {
        idx: lineIdx,
        text: line.text,
        character_id: cid,
        speaker_name: cid === "narrator" ? "Narrator" : cid,
        kind,
        voice,
        pitch: "+0Hz",
        rate: "+0%",
        expression: "normal",
        environment: "indoor",
        intensity: 0.5,
      };
      lineIdx += 1;
      if (line.illustration_url) {
        lineOut.illustration_url = line.illustration_url;
        lineOut.illustration_caption = illustrationCaption(line.text);
        lineOut.visual_moment = true;
      }
      return lineOut;
    });
    scenes.push({
      id: `scene-mech-${String(chapterPos + 1).padStart(4, "0")}`,
      chapter: chapter.index,
      title: chapter.title || `Chapter ${chapter.index}`,
      location: "",
      background: null,
      present: [],
      lines,
    });
  });
  return { scenes, lineCount: lineIdx };
}
