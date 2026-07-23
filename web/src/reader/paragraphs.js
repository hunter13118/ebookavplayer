// Groups flattened, per-line (~per-sentence) book lines into flowing
// PARAGRAPH blocks for the reader view — reconstructing the paragraph and
// quotation structure that per-line extraction necessarily discards. Each
// narration sentence and each narration/dialogue transition is its own
// `line` in the compiled book (needed for cinematic staging: one speaker,
// one voice, one sprite per line), so rendering one <p> per line reads as
// fragmented — this re-flows them into the paragraphs a printed book would
// actually have.
//
// Pure heuristic over data every book already carries (kind, character_id,
// trailing punctuation) — no pipeline or extraction changes. A fully
// EPUB-extracted book (dialogue/narration + speaker per line) groups
// accurately; a line with no `kind` (e.g. a raw M4B-first transcript before
// retro-extraction has attributed it) is treated as narration and simply
// keeps flowing — the SAME grouper gets more accurate "for free" once
// retro-extraction adds real attribution, no special-casing needed here.

import { formatDeliveryText } from "../dialogueFormat.js";

const TERMINAL_RE = /[.!?…]["'”’)\]]*\s*$/;
const TAG_MAX_WORDS = 12;

// A long run of pure narration (no dialogue/scene change) has nothing else to
// force a break, so shouldBreak() alone would merge it into ONE paragraph of
// unbounded size — pagination.js can't split a paragraph across pages (a lone
// oversized one just gets its own page, "never split mid-sentence"), so an
// unbounded merge can end up many times taller than any page and get clipped
// by the reader stage's overflow:hidden, permanently hiding the rest of it.
// This cap forces a break (still only ever AT a real line boundary) once a
// paragraph's accumulated text passes it, comfortably smaller than a single
// page even at a large font size / small viewport. As a side effect it also
// keeps tap-to-seek (paragraph-granularity — see ReaderView's onSeekLine) and
// the skip-forward button useful on long passages: both were effectively
// "seek to the start of this 3000-character blob" before.
const MAX_PARAGRAPH_CHARS = 400;

/** No strong terminal punctuation (comma, colon, dash, or none) at the end of
 *  `text` — the NEXT line continues the same sentence, so it can never start
 *  a new paragraph (e.g. narration trailing into a quote: "...muster a
 *  feeble," + "I see."). */
function endsOpen(text) {
  return !TERMINAL_RE.test((text || "").trim());
}

function isTagLike(text) {
  const words = (text || "").trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= TAG_MAX_WORDS;
}

function utteranceKind(line) {
  return line?.kind === "dialogue" || line?.kind === "delivery" ? "dialogue" : "narration";
}

/** Should a new paragraph start at `cur`, given the immediately preceding
 *  line `prev`? Both are real lines — the caller handles the very first line
 *  and scene-boundary forcing separately. */
function shouldBreak(prev, cur) {
  if (endsOpen(prev.text)) return false; // mid-sentence continuation, never break

  const prevKind = utteranceKind(prev);
  const curKind = utteranceKind(cur);

  if (prevKind === "dialogue" && curKind === "narration") {
    // Narration right after a quote stays as its attribution tag if short
    // ("she asked, her tone dubious.") regardless of the quote's own
    // terminal punctuation — a long passage is a fresh descriptive beat.
    return !isTagLike(cur.text);
  }
  if (prevKind === "narration" && curKind === "dialogue") {
    // A fresh line of dialogue after completed narration starts a new
    // paragraph — standard prose convention (each speaker turn, its own para).
    return true;
  }
  if (prevKind === "dialogue" && curKind === "dialogue") {
    // Same speaker continuing (a long quote split across extracted lines)
    // stays together; a different speaker starts a new paragraph.
    return (prev.character_id || null) !== (cur.character_id || null);
  }
  return false; // narration -> narration: keep flowing as one paragraph
}

/** Yield {kind:'plain'|'quote', words:[{text,lineIdx}]} segments, in order,
 *  for lines[start,end). A 'quote' segment merges a contiguous run of
 *  dialogue by the SAME speaker (a long quote split into several extracted
 *  lines) into one span instead of re-quoting each fragment. */
function* walkSegments(lines, start, end) {
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (line.kind === "dialogue") {
      const speaker = line.character_id;
      let j = i + 1;
      while (j < end && lines[j].kind === "dialogue" && lines[j].character_id === speaker) j += 1;
      const words = [];
      for (let k = i; k < j; k++) {
        (lines[k].text || "").trim().split(/\s+/).filter(Boolean)
          .forEach((w) => words.push({ text: w, lineIdx: k }));
      }
      yield { kind: "quote", words };
      i = j;
    } else if (line.kind === "delivery") {
      const words = formatDeliveryText(line).split(/\s+/).filter(Boolean)
        .map((w) => ({ text: w, lineIdx: i }));
      yield { kind: "plain", words };
      i += 1;
    } else {
      const words = (line.text || "").trim().split(/\s+/).filter(Boolean)
        .map((w) => ({ text: w, lineIdx: i }));
      yield { kind: "plain", words };
      i += 1;
    }
  }
}

/** Flatten walkSegments into a single token stream, wrapping each 'quote'
 *  segment's first/last word in typographic quotes (matching the curly
 *  apostrophes extraction already produces elsewhere in the text). */
function segmentsToTokens(lines, start, end) {
  const tokens = [];
  for (const seg of walkSegments(lines, start, end)) {
    if (!seg.words.length) continue;
    if (seg.kind === "quote") {
      const w = seg.words.map((x) => ({ ...x }));
      w[0].text = `“${w[0].text}`;
      w[w.length - 1].text = `${w[w.length - 1].text}”`;
      tokens.push(...w);
    } else {
      tokens.push(...seg.words);
    }
  }
  return tokens;
}

/**
 * Group `lines` into paragraph blocks.
 * @param {Array} lines  Flattened book lines (array position = global index).
 * @param {number[]} [sceneOf]  Parallel array, scene index per line — forces
 *   a paragraph break at every scene change (a visual/setting change should
 *   never be papered over by the text-continuity heuristic).
 * @returns {{startLine:number, endLine:number, text:string}[]}  endLine is
 *   EXCLUSIVE. `text` is the fully assembled paragraph (quote marks + spacing
 *   already applied) — render it directly for a non-active paragraph.
 */
export function groupIntoParagraphs(lines, sceneOf) {
  const paras = [];
  if (!lines || !lines.length) return paras;
  let start = 0;
  let charsSinceStart = (lines[0].text || "").length;
  for (let i = 1; i <= lines.length; i++) {
    const atEnd = i === lines.length;
    const sceneChanged = sceneOf && !atEnd ? sceneOf[i] !== sceneOf[i - 1] : false;
    const tooLong = !atEnd && charsSinceStart >= MAX_PARAGRAPH_CHARS;
    if (atEnd || sceneChanged || tooLong || shouldBreak(lines[i - 1], lines[i])) {
      const tokens = segmentsToTokens(lines, start, i);
      paras.push({ startLine: start, endLine: i, text: tokens.map((t) => t.text).join(" ") });
      start = i;
      charsSinceStart = atEnd ? 0 : (lines[i].text || "").length;
    } else {
      charsSinceStart += (lines[i].text || "").length;
    }
  }
  return paras;
}

/** Index of the paragraph containing global line index `lineIdx` (0 if none
 *  — an empty/not-yet-grouped state shouldn't throw). Mirrors pagination.js's
 *  pageOfLine: paragraphs are contiguous and ordered, so a plain scan is fine
 *  at book-paragraph-count scale. */
export function paragraphIndexOfLine(paragraphs, lineIdx) {
  if (!paragraphs || !paragraphs.length) return 0;
  for (let p = 0; p < paragraphs.length; p++) {
    if (lineIdx < paragraphs[p].endLine) return p;
  }
  return paragraphs.length - 1;
}

/** Where to splice a synthetic gap paragraph among `paragraphs`, given the
 *  paragraph index containing the orchestrator's pinned real line
 *  (`realIndex`, from paragraphIndexOfLine) and whether the gap plays before
 *  that line has actually started (`leading` — see orchestrator.js's
 *  _resolvePosition). A leading gap (e.g. a book's opening publisher bumper)
 *  splices BEFORE the pinned paragraph so the reader sees text in the order
 *  it's actually spoken; any other gap splices after it, as before. */
export function gapInsertIndex(realIndex, leading) {
  return leading ? realIndex : realIndex + 1;
}

/** Word tokens (with originating lineIdx) for ONE paragraph span — used to
 *  render the currently-active paragraph's per-word karaoke reveal. Cheap to
 *  compute on demand for a single paragraph; groupIntoParagraphs doesn't
 *  build tokens for every paragraph up front. */
export function paragraphTokens(lines, startLine, endLine) {
  return segmentsToTokens(lines, startLine, endLine);
}
