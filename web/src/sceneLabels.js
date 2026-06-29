/** Setting-style scene labels for stage + art picker. */

const CHAPTER_TITLE_RE =
  /^(?:chapter|ch\.?|part|book|section|prologue|epilogue)\s*[\dIVXLCDM]+(?:\s*[:\-.—]\s*.+)?$/i;

const TIME_HINTS = [
  { re: /\b(at night|midnight|moonlit|starlit)\b/i, label: "at Night" },
  { re: /\b(at dawn|at sunrise|sunrise|daybreak)\b/i, label: "at Dawn" },
  { re: /\b(at dusk|at sunset|sunset|twilight|gloaming)\b/i, label: "at Sunset" },
  { re: /\b(in the morning|morning light)\b/i, label: "in the Morning" },
  { re: /\b(in the evening|evening)\b/i, label: "in the Evening" },
  { re: /\b(at noon|midday)\b/i, label: "at Noon" },
  { re: /\b(in the rain|rain(?:y|ing)?)\b/i, label: "in the Rain" },
];

function titleCaseWords(s) {
  return String(s || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function inferTimeSuffix(...parts) {
  const hay = parts.filter(Boolean).join(" ");
  for (const { re, label } of TIME_HINTS) {
    if (re.test(hay)) return label;
  }
  return "";
}

function looksLikeChapterTitle(title) {
  return CHAPTER_TITLE_RE.test(String(title || "").trim());
}

function hasTimePhrase(text) {
  return TIME_HINTS.some(({ re }) => re.test(String(text || "")));
}

export function sceneDisplayTitle(scene) {
  const title = String(scene?.title || "").trim();
  const location = String(scene?.location || "").trim();
  const desc = String(scene?.background_desc || scene?.background || "").trim();
  const time = inferTimeSuffix(title, location, desc);

  if (title && !looksLikeChapterTitle(title)) {
    if (time && !hasTimePhrase(title)) {
      return `${title}${time.startsWith(" at") || time.startsWith(" in") ? time : ` ${time}`}`;
    }
    return title;
  }

  const place = location || desc.split(/[.,]/)[0]?.trim() || "";
  if (!place) return title || "Scene";
  const base = titleCaseWords(place.replace(/^(a|an|the)\s+/i, ""));
  return time ? `${base} ${time}` : base;
}
