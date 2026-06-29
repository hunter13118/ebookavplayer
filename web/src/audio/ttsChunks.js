/** Split line text into fixed-size TTS clips — punctuation-first, then word fallback. */

export const TTS_CHUNK_MAX_CHARS = 160;
export const TTS_CHUNK_MIN_TAIL = 40;

const SENT_PUNCT = new Set([".", "!", "?", "…", "‽"]);
const CLAUSE_PUNCT = new Set([";", ":", "—", "–", "\u2014", "\u2013"]);
const PHRASE_PUNCT = new Set([","]);

function isPunctuation(ch) {
  return SENT_PUNCT.has(ch) || CLAUSE_PUNCT.has(ch) || PHRASE_PUNCT.has(ch);
}

function extendPastClosing(window, endExclusive) {
  let j = endExclusive;
  while (j < window.length && /["'\u201c\u201d\u2018\u2019)\]\s]/.test(window[j])) j += 1;
  return j;
}

export function findPunctuationSplit(window) {
  if (!window) return -1;

  const tryTier = (isMatch) => {
    for (let i = window.length; i >= 1; i -= 1) {
      const ch = window[i - 1];
      if (!isMatch(ch)) continue;
      return extendPastClosing(window, i);
    }
    return -1;
  };

  let at = tryTier((ch) => SENT_PUNCT.has(ch));
  if (at > 0) return at;
  at = tryTier((ch) => CLAUSE_PUNCT.has(ch));
  if (at > 0) return at;
  at = tryTier((ch) => PHRASE_PUNCT.has(ch));
  if (at > 0) return at;

  if (![...window].some(isPunctuation)) return -1;

  for (let i = window.length; i >= 1; i -= 1) {
    if (isPunctuation(window[i - 1])) return extendPastClosing(window, i);
  }
  return -1;
}

export function findWordSplit(window, maxChars) {
  const lastSpace = window.lastIndexOf(" ");
  if (lastSpace > 0) return lastSpace;
  return Math.min(maxChars, window.length);
}

export function splitTextChunks(text, maxChars = TTS_CHUNK_MAX_CHARS) {
  return splitTextChunksWithOffsets(text, maxChars).map((p) => p.text);
}

export function splitTextChunksWithOffsets(text, maxChars = TTS_CHUNK_MAX_CHARS) {
  const full = String(text || "");
  const t = full.trim();
  if (!t) return [];
  const lead = full.indexOf(t);
  const end = lead + t.length;

  if (t.length <= maxChars) {
    return [{ text: t, charStart: lead, charEnd: end }];
  }

  const parts = [];
  let start = 0;

  while (start < t.length) {
    const remaining = t.length - start;
    if (remaining <= maxChars) {
      const tail = t.slice(start).trim();
      if (tail) {
        const charStart = lead + t.indexOf(tail, start);
        parts.push({ text: tail, charStart, charEnd: charStart + tail.length });
      }
      break;
    }

    const window = t.slice(start, start + maxChars);
    let splitLen = findPunctuationSplit(window);
    if (splitLen <= 0) splitLen = findWordSplit(window, maxChars);

    const piece = t.slice(start, start + splitLen).trim();
    if (!piece) {
      start += Math.max(1, splitLen);
      continue;
    }
    const charStart = lead + t.indexOf(piece, start);
    parts.push({ text: piece, charStart, charEnd: charStart + piece.length });
    start += splitLen;
    while (start < t.length && /\s/.test(t[start])) start += 1;
  }

  return mergeTinyTail(parts, TTS_CHUNK_MIN_TAIL);
}

function mergeTinyTail(chunks, minTail) {
  if (chunks.length < 2) return chunks;
  const last = chunks[chunks.length - 1];
  if (last.text.length >= minTail) return chunks;
  const out = chunks.slice(0, -1);
  const prev = out[out.length - 1];
  out[out.length - 1] = {
    text: `${prev.text} ${last.text}`,
    charStart: prev.charStart,
    charEnd: last.charEnd,
  };
  return out;
}

export function buildSpeechUnits(lines, startLineIndex = 0) {
  const units = [];
  for (let i = startLineIndex; i < (lines || []).length; i += 1) {
    const line = lines[i];
    const full = line?.text ?? "";
    if (!String(full).trim()) continue;
    const splitParts = splitTextChunksWithOffsets(full);
    for (let p = 0; p < splitParts.length; p += 1) {
      const { text, charStart, charEnd } = splitParts[p];
      units.push({
        lineIndex: i,
        line,
        text,
        partIndex: p,
        partTotal: splitParts.length,
        charStart,
        charEnd,
      });
    }
  }
  return units;
}

export function unitToLine(unit) {
  return { ...unit.line, text: unit.text };
}

export function lineUsesOfflineWholeLine(line) {
  return line?.idx != null;
}
