/**
 * "Who's pictured in this plate" — an LLM-backed pass that looks at an
 * illustration plate's actual image content (via a local vision-capable
 * Ollama model) plus its surrounding book text, and decides which character
 * (if any) the plate clearly depicts. Confirmed-only: the model is told to
 * answer "none"/null rather than guess, same spirit as expression-repass.js's
 * dialogue tagging — a wrong guess here is worse than no guess, since it
 * becomes that character's reference image for future portrait generation.
 *
 * Two-tier: vision-first (matchPlatesToCharactersVision, one call per plate
 * against a local Ollama vision model — default gemma3:27b, already
 * multimodal-capable, no separate pull needed) actually sees the plate's
 * pixels. Falls back to the original text-only heuristic
 * (matchPlatesToCharactersTextOnly) per-plate when vision is unavailable
 * (no LOCAL image bytes, no reachable Ollama, or a per-call error) — that
 * path never sees the image, so it's strictly weaker but still better than
 * nothing when local Ollama isn't running.
 */
import { freemiumExtract } from "./freemium-extract.js";

const MATCH_TEMPERATURE = 0.2;
const VISION_TIMEOUT_MS = 120_000;

const TEXT_SYSTEM_PROMPT = `You are matching illustration plates from a novel to the characters they depict.
For each numbered plate below, you're given the text immediately before/after where the plate
appears in the book, plus a list of known characters (id, name, description). Decide which ONE
character, if any, the plate clearly depicts — going only on the surrounding text, not the image
itself (you cannot see it). If the text doesn't make it clear, or describes a scene/group/object
rather than one specific character, answer null. Do not guess — a wrong match is worse than no match.
Return exactly: {"matches": [{"plate": 0, "character_id": "kuro"}, ...]} — one entry per plate given,
character_id is null when not confidently identifiable, nothing else in the response.`;

const VISION_SYSTEM_PROMPT = `You are looking at an illustration plate from a novel and matching it
to the character it depicts. You are given the plate image itself, the text immediately surrounding
where it appears in the book, and a list of known characters (id, name, description). Look at the
actual image — art style, physical features, clothing, hair, pose, setting — together with the text,
and decide which ONE character, if any, the plate clearly, unambiguously depicts. Answer null when:
the plate is a landscape/object/decoration with no person in it, it shows a group/crowd scene with no
single character standing out, it shows a character not in the known list, or you're not confident
which known character it is. Do not guess — a wrong match is worse than no match.
Return exactly this JSON and nothing else: {"character_id": "kuro"|null, "is_character_portrait": true|false}`;

const CROP_VISION_SYSTEM_PROMPT = `You are looking at a cropped close-up of a single character's
face/upper-body, taken from an illustration plate in a novel. You are given the crop image itself,
the surrounding book text near where the source plate appears, and a list of known characters (id,
name, description). Decide which ONE known character this crop depicts, based on physical features,
hair, clothing, and the surrounding text. Answer null if it doesn't clearly match any known character,
isn't actually a person (a background/object detection artifact), or you're not confident. Do not
guess — a wrong match is worse than no match, since this becomes that character's reference image.
Return exactly this JSON and nothing else: {"character_id": "kuro"|null}`;

export function rosterText(characters) {
  return characters
    .map((c) => `- ${c.id}: ${c.name}${c.description ? ` — ${c.description}` : ""}`)
    .join("\n");
}

/**
 * Real surrounding narrative text for a plate: its own captured HTML-adjacent
 * context (often boilerplate — see epub-images.js's textNear), plus the tail
 * of the chapter *before* it and the head of the chapter it precedes. Plates
 * conventionally sit on their own spine page between two chapters, so "who
 * just appeared/is about to appear" context lives in both neighbors, not just
 * the one this plate was attached to.
 */
export function surroundingContext(plate, chapters, chapterPos) {
  const own = (plate?.textContext || "").trim();
  const prevTail = (chapters?.[chapterPos - 1]?.text || "").slice(-500).trim();
  const nextHead = (chapters?.[chapterPos]?.text || "").slice(0, 600).trim();
  const parts = [];
  if (own) parts.push(`Plate's own nearby text: "${own.slice(0, 200)}"`);
  if (prevTail) parts.push(`End of the preceding chapter:\n"${prevTail}"`);
  if (nextHead) parts.push(`Opening of the chapter this plate precedes:\n"${nextHead}"`);
  return parts.length ? parts.join("\n\n") : "(no usable surrounding text found)";
}

function arrayBufferToBase64(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function ollamaVisionMatch({ env, systemPrompt, roster, context, imageBytes, timeoutMs = VISION_TIMEOUT_MS }) {
  const base = (env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/$/, "");
  const model = env.OLLAMA_MODEL_VISION || "gemma3:27b";
  const userText = `Known characters:\n${roster}\n\n${context}`;
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText, images: [arrayBufferToBase64(imageBytes)] },
      ],
      format: "json",
      stream: false,
      think: false,
      options: { temperature: MATCH_TEMPERATURE },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`ollama-vision: HTTP ${res.status} ${detail.slice(0, 160)}`);
  }
  const data = await res.json();
  const content = data?.message?.content;
  if (!content) throw new Error("ollama-vision: empty response");
  return JSON.parse(content);
}

/**
 * Identify which known character a single face/upper-body CROP depicts —
 * the per-crop counterpart to matchPlatesToCharactersVision's per-plate
 * matching. Isolating one person before asking "who is this" is far more
 * reliable than asking about a whole busy multi-character plate (which
 * matchPlatesToCharactersVision correctly declines on rather than guess) —
 * this is what actually lets a multi-character plate contribute more than
 * one reference crop. Returns a character id or null (no confident match,
 * or the vision call itself failed — best-effort, never throws).
 */
const CROP_VISION_TIMEOUT_MS = 45_000; // crops are small — should resolve in ~10s (measured); fail fast rather than risk a long stall blocking the rest of the plate/job

export async function identifyCharacterInCrop(cropBytes, allCharacters, context, { env } = {}) {
  const byId = new Map(allCharacters.map((c) => [c.id, c]));
  const characters = allCharacters.filter((c) => c.id !== "narrator");
  if (!characters.length) return null;
  const roster = rosterText(characters);
  try {
    const data = await ollamaVisionMatch({
      env, systemPrompt: CROP_VISION_SYSTEM_PROMPT, roster, context, imageBytes: cropBytes,
      timeoutMs: CROP_VISION_TIMEOUT_MS,
    });
    const cid = data?.character_id;
    return cid && byId.has(cid) ? cid : null;
  } catch {
    return null;
  }
}

/**
 * Vision-first matching pass — one call per plate, real image content
 * included. Returns { results: Map<plateIndex, characterId>, unresolved:
 * Array<{plateIndex, chapterPos}> } — unresolved plates had no usable image
 * bytes or the vision call itself failed, and should fall back to the
 * text-only pass.
 * @param {Map<number, Array<{index:number, textContext:string}>>} illustrationsByChapterPos
 * @param {Array<{id, name, description}>} allCharacters
 * @param {Array<{text?: string}>} chapters
 * @param {(plateIndex:number) => ArrayBuffer|Uint8Array|null} getPlateBytes
 * @param {{env}} opts
 */
export async function matchPlatesToCharactersVision(illustrationsByChapterPos, allCharacters, chapters, getPlateBytes, { env } = {}) {
  const results = new Map();
  const unresolved = [];
  if (!illustrationsByChapterPos?.size || !allCharacters?.length) return { results, unresolved };

  const byId = new Map(allCharacters.map((c) => [c.id, c]));
  const characters = allCharacters.filter((c) => c.id !== "narrator");
  if (!characters.length) return { results, unresolved };
  const roster = rosterText(characters);

  for (const [chapterPos, plates] of illustrationsByChapterPos) {
    if (!plates?.length) continue;
    for (const plate of plates) {
      const imageBytes = getPlateBytes?.(plate.index);
      if (!imageBytes) {
        unresolved.push({ plateIndex: plate.index, chapterPos });
        continue;
      }
      const context = surroundingContext(plate, chapters, chapterPos);
      try {
        const data = await ollamaVisionMatch({ env, systemPrompt: VISION_SYSTEM_PROMPT, roster, context, imageBytes });
        const cid = data?.character_id;
        if (cid && byId.has(cid)) results.set(plate.index, cid);
        // is_character_portrait:false or null character_id both correctly
        // resolve to "no match" — no fallback needed, the model looked and
        // confirmed there's nothing to match.
      } catch {
        unresolved.push({ plateIndex: plate.index, chapterPos }); // vision call failed — try text-only fallback
      }
    }
  }

  return { results, unresolved };
}

/**
 * Original text-only heuristic — never sees the image. Used as a fallback
 * for plates the vision pass couldn't handle (no bytes, or Ollama
 * unreachable/erroring).
 * @param {Array<{plateIndex:number, chapterPos:number}>} targets which plates to attempt
 * @param {Map<number, Array<{index:number, textContext:string}>>} illustrationsByChapterPos
 * @param {Array<{id, name, description}>} allCharacters
 * @param {Array<{text?: string}>} chapters
 * @param {{env, preferProvider?}} opts
 * @returns {Promise<Map<number, string>>} plate index -> matched character id
 */
export async function matchPlatesToCharactersTextOnly(targets, illustrationsByChapterPos, allCharacters, chapters, { env, preferProvider } = {}) {
  const results = new Map();
  if (!targets?.length || !allCharacters?.length) return results;

  const byId = new Map(allCharacters.map((c) => [c.id, c]));
  const characters = allCharacters.filter((c) => c.id !== "narrator");
  if (!characters.length) return results;
  const roster = rosterText(characters);

  const byChapterPos = new Map();
  for (const t of targets) {
    if (!byChapterPos.has(t.chapterPos)) byChapterPos.set(t.chapterPos, []);
    byChapterPos.get(t.chapterPos).push(t.plateIndex);
  }

  for (const [chapterPos, plateIndexes] of byChapterPos) {
    const allPlates = illustrationsByChapterPos.get(chapterPos) || [];
    const plates = allPlates.filter((p) => plateIndexes.includes(p.index));
    if (!plates.length) continue;

    const plateList = plates
      .map((p, i) => `${i}. ${surroundingContext(p, chapters, chapterPos)}`)
      .join("\n\n");
    const userText = `Known characters in this chapter:\n${roster}\n\nPlates:\n${plateList}`;

    let data;
    try {
      ({ data } = await freemiumExtract(userText, {
        systemPrompt: TEXT_SYSTEM_PROMPT,
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

/**
 * Combined entry point: tries vision first (real image content), falls back
 * to the text-only heuristic for whatever vision couldn't resolve.
 * @param {Map<number, Array<{index:number, textContext:string}>>} illustrationsByChapterPos
 * @param {Array<{id, name, description}>} allCharacters
 * @param {Array<{text?: string}>} chapters
 * @param {{env, preferProvider?, getPlateBytes?: (plateIndex:number) => ArrayBuffer|Uint8Array|null}} opts
 * @returns {Promise<Map<number, string>>} plate index -> matched character id
 */
export async function matchPlatesToCharacters(illustrationsByChapterPos, allCharacters, chapters, { env, preferProvider, getPlateBytes } = {}) {
  if (!illustrationsByChapterPos?.size || !allCharacters?.length) return new Map();

  if (typeof getPlateBytes === "function") {
    const { results, unresolved } = await matchPlatesToCharactersVision(
      illustrationsByChapterPos, allCharacters, chapters, getPlateBytes, { env },
    );
    if (unresolved.length) {
      const fallback = await matchPlatesToCharactersTextOnly(
        unresolved, illustrationsByChapterPos, allCharacters, chapters, { env, preferProvider },
      );
      for (const [plateIdx, cid] of fallback) {
        if (!results.has(plateIdx)) results.set(plateIdx, cid);
      }
    }
    return results;
  }

  // No image-bytes accessor given — text-only across every plate (legacy behavior).
  const allTargets = [];
  for (const [chapterPos, plates] of illustrationsByChapterPos) {
    for (const p of plates || []) allTargets.push({ plateIndex: p.index, chapterPos });
  }
  return matchPlatesToCharactersTextOnly(allTargets, illustrationsByChapterPos, allCharacters, chapters, { env, preferProvider });
}
