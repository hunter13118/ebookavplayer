/** Post-extract repair: structural fixes only — never rewrite line text (mirrors server/analyze/repair.py). */

export const PLAIN_VERBS = new Set([
  "said", "asked", "replied", "answered", "continued", "added", "exclaimed",
  "observed", "noted", "remarked", "demanded", "insisted", "declared",
  "announced", "explained", "offered", "suggested", "warned", "promised",
  "agreed", "protested", "mused", "wondered", "admitted", "confessed",
  "informed", "told", "reported", "finished", "concluded", "began",
  "started", "pressed", "urged", "pleaded", "begged", "commanded", "ordered",
  "interrupted", "went", "on",
]);

const STYLIZED_VERBS = new Set([
  "sang", "sung", "yelled", "shouted", "screamed", "whispered", "murmured",
  "muttered", "cried", "sobbed", "laughed", "chuckled", "snapped", "growled",
  "hissed", "stammered", "stuttered", "croaked", "mumbled", "breathed",
  "sighed", "gasped", "panted", "barked", "roared", "sneered", "taunted",
  "teased", "joked", "quipped", "grinned", "smiled", "frowned", "scowled",
  "wept", "nodded", "shrugged",
]);

// Expression Sensitivity Plan (docs/EXPRESSION_SENSITIVITY_PLAN.md) Phase 1b:
// a delivery verb already present in the text is a free, deterministic signal
// for what the (often under-triggered) `expression` tag should be — no LLM
// call needed, works identically regardless of which provider extracted.
const VERB_TO_BUCKET = {
  sang: "happy", sung: "happy",
  yelled: "yell", shouted: "yell", screamed: "yell", roared: "yell", barked: "yell",
  whispered: "whisper", murmured: "whisper", mumbled: "whisper", breathed: "whisper",
  cried: "sad", sobbed: "sad", wept: "sad", sighed: "sad", muttered: "whisper",
  laughed: "happy", chuckled: "happy", grinned: "happy", smiled: "happy",
  snapped: "angry", growled: "angry", hissed: "angry", scowled: "angry", frowned: "angry",
  stammered: "nervous", stuttered: "nervous", croaked: "nervous",
  gasped: "surprised", panted: "scared",
  sneered: "smug", taunted: "smug", teased: "smug", quipped: "smug", joked: "smug",
};

// Weaker signal (Phase 1b): an adverb tail on the attribution nudges bucket
// + intensity when no stylized verb was found.
const ADVERB_BUCKET = {
  quietly: { bucket: "whisper", delta: -0.2 },
  softly: { bucket: "whisper", delta: -0.2 },
  sharply: { bucket: "angry", delta: 0.2 },
  coldly: { bucket: "angry", delta: 0.2 },
};

function clampIntensity(v) {
  return Math.max(0, Math.min(1, v));
}

function findStylizedVerbInText(text) {
  const words = String(text || "").toLowerCase().match(/[a-z']+/g) || [];
  for (let i = words.length - 1; i >= 0; i -= 1) {
    if (VERB_TO_BUCKET[words[i]]) return words[i];
  }
  return null;
}

const PRONOUN_TAG = /^(?<pronoun>he|she|they)\s+(?<verb>\w+)(?<rest>.*)$/i;
const LONE_VERB = /^(?<verb>said|asked|replied|answered|continued|added)(?<rest>.*)$/i;
const ADVERB_TAIL = /^(quietly|softly|slowly|firmly|coldly|flatly|evenly|simply|carefully|gently|sharply)(?<punct>[.,!?]?)$/i;
const EMBEDDED_TAG_SPLIT = /^(?<tag>(?:he|she|they)\s+(?:said|asked|replied|whispered|muttered|continued|added))(?<punct>[,.])?\s+(?<rest>.+)$/i;
const STANDALONE_TAG = /^(?:he|she|they)\s+(?:said|asked|replied|whispered|muttered|continued|added)(?:\s+(?:quietly|softly|slowly|firmly|evenly|simply|carefully|gently|sharply))?[.,!?]?$/i;
const TAGISH = /^(?:(?:he|she|they)\s+)?(?:said|asked|replied|answered|continued|added|whispered|murmured|muttered|exclaimed|observed|noted|remarked|demanded|insisted|declared|announced|explained|offered|suggested|warned|promised|agreed|protested|mused|wondered|admitted|confessed|informed|told|reported|finished|concluded|began|started|pressed|urged|pleaded|begged|commanded|ordered|interrupted)(?:\s+\w+)*[.,!?]?$/i;

function firstVerbToken(text) {
  const t = String(text || "").trim();
  let m = PRONOUN_TAG.exec(t);
  if (m) return m.groups.verb.toLowerCase();
  m = LONE_VERB.exec(t);
  if (m) return m.groups.verb.toLowerCase();
  const parts = t.split(/\s+/);
  return parts[0]?.toLowerCase().replace(/[.,!?]+$/, "") || "";
}

export function isPlainSpeechTagLine(line) {
  if (!line || !["narration", "delivery"].includes(line.kind)) return false;
  const verb = (line.delivery_verb || firstVerbToken(line.text)).toLowerCase();
  if (PLAIN_VERBS.has(verb)) return true;
  const text = String(line.text || "").trim();
  if (!text) return false;
  if (line.kind === "delivery" && !STYLIZED_VERBS.has(verb)) return true;
  return TAGISH.test(text) && !STYLIZED_VERBS.has(verb);
}

function normalizeDeliveryLine(line) {
  const verb = (line.delivery_verb || firstVerbToken(line.text)).toLowerCase();
  if (line.kind !== "delivery") return line;
  if (STYLIZED_VERBS.has(verb)) return line;
  return { ...line, kind: "narration", line_weight: "normal", delivery_verb: null };
}

// Expression Sensitivity Plan Phase 1c: the inverse of normalizeDeliveryLine.
// A model sometimes correctly captures a stylized attribution tag ("I
// shouted at the two of them") verbatim but mis-classifies it kind=narration
// instead of kind=delivery — this is upstream of Phase 1b's verb inference,
// since that inference is much more reliable once the tag is on its own
// properly-kinded line rather than folded into generic narration.
function promoteStylizedNarrationToDelivery(line) {
  if (!line || line.kind !== "narration" || line.character_id !== "narrator") return line;
  const text = String(line.text || "").trim();
  // Short attribution tag, not a full narration paragraph that merely
  // contains one of these verbs in passing (e.g. "she sighed and looked away
  // for a long moment, thinking of everything that had happened since...").
  if (!text || text.split(/\s+/).length > 12) return line;
  const verb = line.delivery_verb ? String(line.delivery_verb).toLowerCase() : findStylizedVerbInText(text);
  if (!verb || !VERB_TO_BUCKET[verb]) return line;
  return { ...line, kind: "delivery", line_weight: "minor", delivery_verb: verb };
}

// Expression Sensitivity Plan Phase 1b: overwrite a still-"normal" dialogue/
// thought line's expression using whatever stylized-verb or adverb-tail
// signal is available — on the line's own text, or an adjacent delivery/
// narration line's tag — before falling through to whatever the extraction
// pass produced.
export function inferExpressionFromDelivery(lines) {
  const out = lines.map((l) => ({ ...l }));
  for (let i = 0; i < out.length; i += 1) {
    const line = out[i];
    if (!["dialogue", "thought"].includes(line.kind)) continue;
    if (String(line.expression || "normal").toLowerCase() !== "normal") continue;

    let verb = line.delivery_verb ? String(line.delivery_verb).toLowerCase() : findStylizedVerbInText(line.text);
    if (!verb) {
      const next = out[i + 1];
      const prev = out[i - 1];
      const neighbor = next && ["delivery", "narration"].includes(next.kind)
        ? next
        : (prev && ["delivery", "narration"].includes(prev.kind) ? prev : null);
      if (neighbor) {
        verb = neighbor.delivery_verb
          ? String(neighbor.delivery_verb).toLowerCase()
          : findStylizedVerbInText(neighbor.text);
      }
    }
    const bucket = verb ? VERB_TO_BUCKET[verb] : null;
    if (bucket) {
      out[i] = { ...line, expression: bucket };
      continue;
    }

    // Weaker fallback: adverb tail on an adjacent narration/delivery line.
    for (const adj of [out[i + 1], out[i - 1]]) {
      if (!adj || !["narration", "delivery"].includes(adj.kind)) continue;
      const tail = String(adj.text || "").trim().match(/\b(quietly|softly|sharply|coldly)\b[.,!?]?$/i);
      if (!tail) continue;
      const nudge = ADVERB_BUCKET[tail[1].toLowerCase()];
      if (nudge) {
        const baseIntensity = typeof line.intensity === "number" ? line.intensity : 0.5;
        out[i] = { ...line, expression: nudge.bucket, intensity: clampIntensity(baseIntensity + nudge.delta) };
      }
      break;
    }
  }
  return out;
}

function mergeTagFragments(lines) {
  if (lines.length < 2) return lines;
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const cur = lines[i];
    if (
      i + 1 < lines.length
      && ["narration", "delivery"].includes(cur.kind)
      && ["narration", "delivery"].includes(lines[i + 1].kind)
      && isPlainSpeechTagLine(cur)
      && ADVERB_TAIL.test(String(lines[i + 1].text || "").trim())
    ) {
      out.push({
        ...cur,
        text: `${String(cur.text).trimEnd()} ${String(lines[i + 1].text).trimStart()}`.trim(),
        kind: "narration",
        line_weight: "normal",
        delivery_verb: null,
      });
      i += 2;
      continue;
    }
    out.push(cur);
    i += 1;
  }
  return out;
}

function normalizeTagMetadata(line) {
  if (!isPlainSpeechTagLine(line)) return line;
  return {
    ...line,
    kind: "narration",
    character_id: "narrator",
    line_weight: "normal",
    delivery_verb: null,
  };
}

function splitMergedTagNarration(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const ln = lines[i];
    const text = String(ln.text || "").trim();
    const prev = out.length ? out[out.length - 1] : (i > 0 ? lines[i - 1] : null);
    const m = EMBEDDED_TAG_SPLIT.exec(text);
    if (
      m
      && ln.kind === "narration"
      && prev
      && prev.kind === "dialogue"
      && !STANDALONE_TAG.test(text)
      && m.groups.rest.split(/\s+/).length > 2
    ) {
      const punct = m.groups.punct || ",";
      out.push({ ...ln, text: `${m.groups.tag}${punct}` });
      out.push({ ...ln, text: m.groups.rest.trim() });
      continue;
    }
    out.push(ln);
  }
  return out;
}

function fixThirdPersonThought(line) {
  if (!line || !["thought", "dialogue"].includes(line.kind)) return line;
  const text = String(line.text || "").trim();
  if (!text || line.character_id === "narrator") return line;
  const cid = String(line.character_id || "").toLowerCase();
  const nameHint = cid.replace(/_/g, " ");
  const third = new RegExp(
    `^(?:${nameHint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|${cid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\s+(?:thought|wondered|remembered|realized|recalled|considered|felt)\\b`,
    "i",
  );
  if (third.test(text) || /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+(?:thought|wondered|remembered|realized|recalled)\b/.test(text)) {
    return { ...line, kind: "narration", character_id: "narrator" };
  }
  if (line.kind === "thought" && text.split(/\s+/).length > 18 && !/^["'I]/.test(text)) {
    return { ...line, kind: "narration", character_id: "narrator" };
  }
  return line;
}

export function repairSceneLines(lines) {
  let fixed = lines.map(normalizeDeliveryLine);
  fixed = fixed.map(promoteStylizedNarrationToDelivery);
  fixed = fixed.map(fixThirdPersonThought);
  fixed = mergeTagFragments(fixed);
  fixed = splitMergedTagNarration(fixed);
  fixed = fixed.map(normalizeTagMetadata);
  return inferExpressionFromDelivery(fixed);
}

export function repairAnalysis(analysis) {
  const scenes = (analysis.scenes || []).map((scene) => ({
    ...scene,
    lines: repairSceneLines(scene.lines || []),
  }));
  return { ...analysis, scenes };
}
