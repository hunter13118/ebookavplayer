/**
 * Verbatim-coverage repair: diff the RAW EPUB source text for a chapter
 * against the LLM-reconstructed line text for that same chapter, and surface
 * any source words the reconstruction dropped (the extraction prompt
 * demands verbatim coverage — dialogue-rules.js's "VERBATIM COVERAGE" rule —
 * but nothing verifies compliance; an attribution tag like `he said quietly.`
 * silently vanishing is exactly this kind of drop).
 *
 * Same anchor-block reasoning scripts/local-align-server/server.py's
 * IncrementalAligner already uses for audio/text alignment, ported to a
 * text-vs-text diff (no ASR/timing involved, so no need to shell out to
 * Python): a run of MIN_ANCHOR_BLOCK_WORDS+ consecutive matching words is a
 * real anchor; isolated 1-2 word matches are noise (ordinary prose repeats
 * short phrases constantly). Source words between two anchors that never
 * show up in the reconstruction are what got dropped.
 */

// Lower than server.py's audio-alignment floor (6) on purpose: that value
// guards against coincidental matches across a fuzzy ASR transcript searched
// against an ENTIRE book. This is an exact, case/punctuation-normalized
// text-vs-text diff with a tightly bounded resync search
// (MAX_RESYNC_LOOKAHEAD words, not "the whole book"), and book dialogue is
// often genuinely short ("Wait." "What is it?") — a 6-word floor would fail
// to resync after a drop inside an otherwise ordinary short-dialogue scene.
// 3 consecutive exact-normalized words within a small window is still very
// unlikely to be a coincidental match.
const MIN_ANCHOR_BLOCK_WORDS = 3;

// Bounds how far ahead (in either text) a resync search looks after a
// mismatch — a missing span is expected to be a dropped sentence/tag, not a
// huge chunk, so this only needs to be generous enough to skip past that,
// not the whole chapter.
const MAX_RESYNC_LOOKAHEAD = 500;

function normalizeWord(w) {
  return String(w || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Tokenize into {norm, raw} words, dropping empty tokens (pure punctuation). */
function tokenize(text) {
  const raw = String(text || "").split(/\s+/).filter(Boolean);
  const out = [];
  for (const w of raw) {
    const norm = normalizeWord(w);
    if (norm) out.push({ norm, raw: w });
  }
  return out;
}

/** Build a map from ANCHOR-word n-gram key -> list of start indices in `words`. */
function buildNgramIndex(words, n) {
  const index = new Map();
  for (let i = 0; i + n <= words.length; i += 1) {
    const key = words.slice(i, i + n).map((w) => w.norm).join(" ");
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(i);
  }
  return index;
}

function ngramKey(words, start, n) {
  return words.slice(start, start + n).map((w) => w.norm).join(" ");
}

/** How far src[i2..]/recon[j2..] keep agreeing word-for-word, from a
 *  candidate anchor start — used to prefer the LONGEST nearby match instead
 *  of just the first MIN_ANCHOR_BLOCK_WORDS-sized coincidence found, the same
 *  way difflib prefers longest-common-substring over a minimal fixed floor. */
function extensionLength(src, recon, i2, j2) {
  let len = 0;
  while (i2 + len < src.length && j2 + len < recon.length && src[i2 + len].norm === recon[j2 + len].norm) {
    len += 1;
  }
  return len;
}

/**
 * Find the best resync point after a mismatch at (i, j): among every
 * i2 >= i (within MAX_RESYNC_LOOKAHEAD) where src[i2..i2+ANCHOR) also appears
 * as a contiguous run in recon at some j2 >= j (also within the lookahead
 * bound), pick the one whose match extends furthest — a longer corroborated
 * run is much less likely to be a coincidental short-phrase collision than
 * just the minimal anchor block. Returns null if no anchor exists in range.
 */
function findResync(src, recon, i, j, reconIndex) {
  const iMax = Math.min(src.length - MIN_ANCHOR_BLOCK_WORDS, i + MAX_RESYNC_LOOKAHEAD);
  const jMax = j + MAX_RESYNC_LOOKAHEAD;
  let best = null;
  for (let i2 = i; i2 <= iMax; i2 += 1) {
    const key = ngramKey(src, i2, MIN_ANCHOR_BLOCK_WORDS);
    const candidates = reconIndex.get(key);
    if (!candidates) continue;
    for (const j2 of candidates) {
      if (j2 < j || j2 > jMax) continue;
      const len = extensionLength(src, recon, i2, j2);
      if (!best || len > best.len || (len === best.len && i2 < best.i2)) {
        best = { i2, j2, len };
      }
    }
  }
  return best;
}

/**
 * Diff `sourceText` (verbatim EPUB chapter text) against `reconstructedText`
 * (the LLM-extracted lines' text, concatenated in reading order) and return
 * every span of source text the reconstruction dropped.
 *
 * @returns {{words: string[], text: string, afterReconWordIndex: number}[]}
 *   `afterReconWordIndex` is the reconstruction word index this span should
 *   be reinserted after (-1 meaning "before everything").
 */
export function findMissingVerbatimText(sourceText, reconstructedText) {
  const src = tokenize(sourceText);
  const recon = tokenize(reconstructedText);
  if (!src.length) return [];
  if (!recon.length) {
    return src.length ? [{ words: src.map((w) => w.raw), text: src.map((w) => w.raw).join(" "), afterReconWordIndex: -1 }] : [];
  }

  const reconIndex = buildNgramIndex(recon, MIN_ANCHOR_BLOCK_WORDS);
  const missing = [];
  let i = 0;
  let j = 0;

  while (i < src.length) {
    if (j < recon.length && src[i].norm === recon[j].norm) {
      i += 1; j += 1;
      continue;
    }

    const resync = findResync(src, recon, i, j, reconIndex);
    if (!resync) {
      // Nothing left to resync against — the remaining source text never
      // reappears in the reconstruction at all (dropped, or reconstruction
      // simply ended early for this chapter).
      missing.push({
        words: src.slice(i).map((w) => w.raw),
        text: src.slice(i).map((w) => w.raw).join(" "),
        afterReconWordIndex: j - 1,
      });
      break;
    }

    const { i2, j2 } = resync;
    if (i2 > i) {
      missing.push({
        words: src.slice(i, i2).map((w) => w.raw),
        text: src.slice(i, i2).map((w) => w.raw).join(" "),
        afterReconWordIndex: j - 1,
      });
    }
    i = i2;
    j = j2;
  }

  return missing;
}

/**
 * Repair a chapter's reconstructed `scenes[].lines[]` against its verbatim
 * source text: find anything the extraction dropped (findMissingVerbatimText)
 * and splice each missing span back in as a new
 * `{character_id:"narrator", kind:"narration", text}` line, immediately after
 * whichever existing line it followed in the source. Pure — returns new
 * scene objects, never mutates the input.
 *
 * @returns {{scenes: object[], insertedCount: number, missing: object[]}}
 */
export function repairChapterVerbatimCoverage(scenes, sourceText) {
  if (!scenes?.length) return { scenes: scenes || [], insertedCount: 0, missing: [] };

  // Flatten every line's words in reading order, remembering which
  // (sceneIdx, lineIdx) each word came from so a missing span's
  // `afterReconWordIndex` can be mapped back to a real insertion point.
  const wordMap = [];
  const reconWords = [];
  scenes.forEach((scene, si) => {
    (scene.lines || []).forEach((line, li) => {
      const words = String(line.text || "").split(/\s+/).filter(Boolean);
      words.forEach((w) => {
        reconWords.push(w);
        wordMap.push({ sceneIdx: si, lineIdx: li });
      });
    });
  });

  const missing = findMissingVerbatimText(sourceText, reconWords.join(" "));
  if (!missing.length) return { scenes, insertedCount: 0, missing: [] };

  const targets = missing.map((m, origIdx) => {
    const anchor = m.afterReconWordIndex >= 0 && m.afterReconWordIndex < wordMap.length
      ? wordMap[m.afterReconWordIndex]
      : null;
    return { ...m, origIdx, sceneIdx: anchor?.sceneIdx ?? 0, lineIdx: anchor?.lineIdx ?? -1 };
  });
  // Splice from the END backwards (by scene, then line, then original order)
  // so each insertion's target index is still valid when it's applied —
  // otherwise an earlier splice would shift every later target's index.
  targets.sort((a, b) => (b.sceneIdx - a.sceneIdx) || (b.lineIdx - a.lineIdx) || (b.origIdx - a.origIdx));

  const newScenes = scenes.map((s) => ({ ...s, lines: [...(s.lines || [])] }));
  for (const t of targets) {
    newScenes[t.sceneIdx].lines.splice(t.lineIdx + 1, 0, {
      character_id: "narrator", kind: "narration", text: t.text,
    });
  }

  return { scenes: newScenes, insertedCount: missing.length, missing };
}
