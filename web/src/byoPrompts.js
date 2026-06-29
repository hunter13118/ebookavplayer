/** BYO master prompts — mirror worker freemium-image + moment-inserts logic for copy-paste export. */
import { resolveReplaceArtStyle } from "./artMediaItems.js";
import { suggestedArtFilename } from "./byoArtPack.js";
import { mediaImageSrc } from "./media.js";

const SUBJECT_FRAMING = {
  character: {
    pre:
      "Portrait bust character sprite, head and shoulders, large readable face, "
      + "centered composition, expressive eyes and hair, front-facing or 3/4 view,",
    postTransparent:
      "character cutout on a fully transparent background (alpha channel), "
      + "no backdrop, no floor shadow, no scenery, even lighting, "
      + "face and hair fill most of the frame, thumbnail-friendly, "
      + "visual novel dialogue portrait ready.",
  },
  background: {
    pre:
      "Wide establishing background scene, environment art, no characters, "
      + "no people, strong sense of depth and atmosphere,",
    post: "full scene fills the frame, layered foreground/midground/background, usable as a game backdrop layer.",
  },
};

const STYLE_TEMPLATES = {
  realistic: "photorealistic, natural lighting",
  anime: "anime cel-shaded, bold outlines, vibrant colors",
  pixel: "pixel art, 16-bit RPG sprite, crisp pixels",
  comic: "cartoon comic style, bold outlines",
  neutral: "clean digital illustration",
};

const EXPRESSION_PROMPTS = {
  sad: "sad wistful expression, downturned eyes, soft melancholy",
  angry: "angry fierce expression, narrowed eyes, tense jaw",
  whisper: "quiet secretive expression, softened lips, intent gaze",
  yell: "shouting intense expression, open mouth, emphatic",
  happy: "bright happy smile, lively eyes",
  surprised: "surprised wide eyes, startled expression",
};

const OUTPUT_SPECS = {
  cover: "PNG, portrait ~768×1024 (book cover key art, no text)",
  characters: "PNG with transparent background, ~512×512 portrait bust",
  backgrounds: "PNG, landscape ~1024×576 (wide establishing scene, no people)",
  inserts: "PNG, portrait ~768×1024 (full-screen story moment)",
};

export function artStyleKey(artStyle) {
  const s = (artStyle || "").toLowerCase();
  if (s.includes("real") || s === "semi-real") return "realistic";
  if (s.includes("anime")) return "anime";
  if (s.includes("pixel")) return "pixel";
  if (s.includes("cartoon") || s.includes("comic")) return "comic";
  return "neutral";
}

export function composeImagePrompt(description, { subjectType = "character", style = "neutral" } = {}) {
  const subj = subjectType === "background" ? "background" : "character";
  const framing = SUBJECT_FRAMING[subj];
  const styleDesc = STYLE_TEMPLATES[style] || STYLE_TEMPLATES.neutral;
  const desc = String(description || "").trim().replace(/\s+/g, " ");
  const post = subj === "character" ? framing.postTransparent : framing.post;
  return `${framing.pre} ${desc} ${post} Art style: ${styleDesc}.`;
}

function lineExpression(line) {
  const raw = line?.expression;
  if (raw && String(raw).trim().toLowerCase() !== "normal") {
    return String(raw).trim().toLowerCase();
  }
  return "normal";
}

function expressionPromptSuffix(expression) {
  return EXPRESSION_PROMPTS[expression] || `${expression} facial expression`;
}

function findLineByIdx(book, lineIdx) {
  for (const scene of book?.scenes || []) {
    for (const line of scene.lines || []) {
      if (line.idx === lineIdx) return { scene, line };
    }
  }
  return null;
}

function characterGenDescription(c) {
  const parts = [c?.description, c?.name, c?.id].filter(Boolean);
  let desc = String(parts[0] || c?.id || "").trim();
  if (Array.isArray(c?.appearance_changes) && c.appearance_changes.length) {
    desc += `. Current look: ${c.appearance_changes.join("; ")}`;
  }
  return desc;
}

/** Port of worker momentDescription using compiled playback book shape. */
export function momentDescriptionFromBook(book, lineIdx) {
  const hit = findLineByIdx(book, lineIdx);
  if (!hit) return `Story moment at slide ${lineIdx + 1}.`;
  const { scene, line } = hit;
  const custom = line?.moment_prompt || "";
  if (String(custom).trim()) return String(custom).trim();

  const chars = book.characters || {};
  const cid = line?.character_id;
  const char = chars[cid];
  const name = char?.name || (cid === "narrator" ? "Narrator" : cid);
  const expr = lineExpression(line);
  const exprBit = expr !== "normal" ? expressionPromptSuffix(expr) : "dramatic expressive moment";
  const loc = scene?.location || scene?.title || "scene";
  const text = String(line?.text || "").trim().slice(0, 200);

  const presentIds = scene?.present_character_ids
    || (scene?.present || []).map((p) => p.character_id).filter(Boolean)
    || [cid].filter(Boolean);
  const cast = presentIds
    .map((id) => {
      const c = chars[id];
      const label = c?.name || id;
      const look = c?.description ? `: ${String(c.description).slice(0, 120)}` : "";
      return `${label}${look}`;
    })
    .join("; ");

  const appearance = char?.description
    ? `Keep ${name} visually consistent — ${String(char.description).slice(0, 160)}. `
    : "";

  return (
    `${loc}. Full-screen story moment. Characters present: ${cast || name}. `
    + `${appearance}${name}, ${exprBit}. Scene: ${scene?.title || scene?.id}. `
    + `Story beat: ${text}`
  ).trim();
}

function subjectTypeForItem(item) {
  if (item.kind === "cover" || item.kind === "backgrounds") return "background";
  return "character";
}

function rawDescription(book, item) {
  if (item.kind === "cover") {
    const title = book?.title || book?.book_id || "Untitled";
    return `Evocative book cover key art for '${title}'. No text.`;
  }
  if (item.kind === "characters") {
    return characterGenDescription(book?.characters?.[item.id] || { id: item.id });
  }
  if (item.kind === "backgrounds") {
    const scene = (book?.scenes || []).find((s) => s.id === (item.sceneId || item.id));
    return scene?.location || scene?.title || scene?.id || item.id;
  }
  if (item.kind === "inserts") {
    const lineIdx = parseInt(item.id, 10);
    return momentDescriptionFromBook(book, lineIdx);
  }
  return item.label || "";
}

function resolveRefUrl(path, apiBase) {
  if (!path) return null;
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  if (apiBase) {
    const base = String(apiBase).replace(/\/$/, "");
    return `${base}${path}`;
  }
  return mediaImageSrc(path);
}

function illustrationRefUrl(book, refIndex, apiBase) {
  if (refIndex == null || !Number.isFinite(Number(refIndex))) return null;
  const catalog = book?.illustration_urls || {};
  const path = catalog[refIndex] ?? catalog[String(refIndex)];
  return resolveRefUrl(path, apiBase);
}

function collectReferenceUrls(book, item, { apiBase } = {}) {
  const urls = [];
  const catalog = book?.illustration_urls || {};

  if (item.kind === "cover") {
    const ref = book?.cover_illustration_ref;
    const u = illustrationRefUrl(book, ref, apiBase);
    if (u) urls.push({ label: "Cover EPUB plate", url: u });
    else if (Object.keys(catalog).length) {
      const first = illustrationRefUrl(book, 0, apiBase);
      if (first) urls.push({ label: "EPUB plate 0", url: first });
    }
  }

  if (item.kind === "characters") {
    const char = book?.characters?.[item.id];
    const u = illustrationRefUrl(book, char?.illustration_ref, apiBase);
    if (u) urls.push({ label: `${char?.name || item.id} EPUB plate`, url: u });
    const ext = book?.external_refs?.characters?.[item.id] || [];
    for (const url of ext) {
      urls.push({ label: `${char?.name || item.id} external ref`, url });
    }
  }

  for (const url of book?.external_refs?.book || []) {
    urls.push({ label: "Book external ref", url });
  }

  if (item.kind === "inserts") {
    const lineIdx = parseInt(item.id, 10);
    const hit = findLineByIdx(book, lineIdx);
    const u = illustrationRefUrl(book, hit?.line?.illustration_ref, apiBase);
    if (u) urls.push({ label: "Line EPUB plate", url: u });
  }

  return urls;
}

function outputSpecForKind(kind) {
  return OUTPUT_SPECS[kind] || "PNG";
}

/** Single art slot → markdown prompt block. */
export function buildByoPrompt(book, item, opts = {}) {
  const style = resolveReplaceArtStyle(book);
  const styleKey = artStyleKey(style);
  const subjectType = subjectTypeForItem(item);
  const description = rawDescription(book, item);
  const masterPrompt = composeImagePrompt(description, { subjectType, style: styleKey });
  const refs = collectReferenceUrls(book, item, opts);
  const title = book?.title || book?.book_id || "Book";

  const lines = [
    `# ${title} — ${item.label} (${style})`,
    "",
    "## Master prompt",
    masterPrompt,
    "",
    "## Output specs",
    `- Format: ${outputSpecForKind(item.kind)}`,
    `- Save as: ${suggestedArtFilename(item) || "see manifest"}`,
  ];

  if (refs.length) {
    lines.push("", "## Reference URLs");
    for (const r of refs) {
      lines.push(`- ${r.label}: ${r.url}`);
    }
  }

  return lines.join("\n");
}

/** Full markdown pack for selected items. */
export function buildByoPromptPack(book, items, opts = {}) {
  return items.map((item) => buildByoPrompt(book, item, opts)).join("\n\n---\n\n");
}

/** JSON array for power users / automation. */
export function buildByoPromptJson(book, items, opts = {}) {
  const style = resolveReplaceArtStyle(book);
  const styleKey = artStyleKey(style);
  return items.map((item) => {
    const subjectType = subjectTypeForItem(item);
    const description = rawDescription(book, item);
    return {
      key: item.key,
      kind: item.kind,
      id: item.id,
      label: item.label,
      style,
      styleKey,
      subjectType,
      description,
      masterPrompt: composeImagePrompt(description, { subjectType, style: styleKey }),
      outputSpecs: outputSpecForKind(item.kind),
      suggestedFilename: suggestedArtFilename(item),
      referenceUrls: collectReferenceUrls(book, item, opts),
    };
  });
}
