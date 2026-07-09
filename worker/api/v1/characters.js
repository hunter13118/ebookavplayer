import { json } from "../../_shared/jobs-kv.js";
import {
  mergeCharacterInAnalysis, mergeCharacterInPlayback, renameCharacterInAnalysis, renameCharacterInPlayback,
  setCharacterTemperamentInAnalysis, setCharacterTemperamentInPlayback,
  setCharacterDescriptionInAnalysis, setCharacterDescriptionInPlayback,
  addCharacterReferenceImageInAnalysis, addCharacterReferenceImageInPlayback,
} from "../../_shared/character-merge.js";

async function loadPair(env, bookId) {
  const axObj = await env.VAE_PACKS.get(`books/${bookId}.analysis.json`);
  const pbObj = await env.VAE_PACKS.get(`books/${bookId}.json`);
  if (!axObj && !pbObj) return null;
  return {
    analysis: axObj ? await axObj.json() : null,
    playback: pbObj ? await pbObj.json() : null,
  };
}

async function savePair(env, bookId, { analysis, playback }) {
  if (analysis) {
    await env.VAE_PACKS.put(`books/${bookId}.analysis.json`, JSON.stringify(analysis, null, 2), {
      httpMetadata: { contentType: "application/json" },
    });
  }
  if (playback) {
    await env.VAE_PACKS.put(`books/${bookId}.json`, JSON.stringify(playback, null, 2), {
      httpMetadata: { contentType: "application/json" },
    });
  }
}

async function saveAlias(env, bookId, fromId, toId) {
  if (!env.VAE_JOBS) return;
  const raw = await env.VAE_JOBS.get(`aliases:${bookId}`);
  const aliasMap = raw ? JSON.parse(raw) : {};
  aliasMap[fromId] = toId;
  await env.VAE_JOBS.put(`aliases:${bookId}`, JSON.stringify(aliasMap), { expirationTtl: 86400 * 365 });
}

/** PATCH /books/:id/characters/merge — fold `from` character into `to`, retroactively + as a future alias. */
export async function onCharacterMergePatch({ request, env, bookId }) {
  if (!env.VAE_PACKS) return null;

  let body = {};
  try { body = await request.json(); } catch { /* empty */ }
  const { from, to } = body;
  if (!from || !to || from === to) return json({ error: "expected distinct { from, to } character ids" }, 400);

  const pair = await loadPair(env, bookId);
  if (!pair) return json({ error: "no such book" }, 404);

  const toExists = pair.playback?.characters?.[to] || (pair.analysis?.characters || []).some((c) => c.id === to);
  if (!toExists) return json({ error: `unknown target character "${to}"` }, 400);

  const analysis = pair.analysis ? mergeCharacterInAnalysis(pair.analysis, from, to) : null;
  const playback = pair.playback ? mergeCharacterInPlayback(pair.playback, from, to) : null;

  await savePair(env, bookId, { analysis, playback });
  await saveAlias(env, bookId, from, to);

  return json({ ok: true, characters: playback?.characters || null });
}

/** PATCH /books/:id/characters/rename — set a character's display name in place. */
export async function onCharacterRenamePatch({ request, env, bookId }) {
  if (!env.VAE_PACKS) return null;

  let body = {};
  try { body = await request.json(); } catch { /* empty */ }
  const { id, name } = body;
  if (!id || !name) return json({ error: "expected { id, name }" }, 400);

  const pair = await loadPair(env, bookId);
  if (!pair) return json({ error: "no such book" }, 404);

  const analysis = pair.analysis ? renameCharacterInAnalysis(pair.analysis, id, name) : null;
  const playback = pair.playback ? renameCharacterInPlayback(pair.playback, id, name) : null;

  await savePair(env, bookId, { analysis, playback });

  return json({ ok: true, characters: playback?.characters || null });
}

/** PATCH /books/:id/characters/temperament — set a character's baseline
 * emotional register (Expression Sensitivity Plan Phase 1f), used as context
 * for the expression re-pass, not a display field. */
export async function onCharacterTemperamentPatch({ request, env, bookId }) {
  if (!env.VAE_PACKS) return null;

  let body = {};
  try { body = await request.json(); } catch { /* empty */ }
  const { id, temperament } = body;
  if (!id || typeof temperament !== "string") return json({ error: "expected { id, temperament }" }, 400);

  const pair = await loadPair(env, bookId);
  if (!pair) return json({ error: "no such book" }, 404);

  const analysis = pair.analysis ? setCharacterTemperamentInAnalysis(pair.analysis, id, temperament) : null;
  const playback = pair.playback ? setCharacterTemperamentInPlayback(pair.playback, id, temperament) : null;

  await savePair(env, bookId, { analysis, playback });

  return json({ ok: true, characters: playback?.characters || null });
}

/** PATCH /books/:id/characters/description — user-editable character
 * description shown in the character profile viewer (CharacterManager.jsx).
 * Overrides whatever the extraction model wrote; display-only. */
export async function onCharacterDescriptionPatch({ request, env, bookId }) {
  if (!env.VAE_PACKS) return null;

  let body = {};
  try { body = await request.json(); } catch { /* empty */ }
  const { id, description } = body;
  if (!id || typeof description !== "string") return json({ error: "expected { id, description }" }, 400);

  const pair = await loadPair(env, bookId);
  if (!pair) return json({ error: "no such book" }, 404);

  const analysis = pair.analysis ? setCharacterDescriptionInAnalysis(pair.analysis, id, description) : null;
  const playback = pair.playback ? setCharacterDescriptionInPlayback(pair.playback, id, description) : null;

  await savePair(env, bookId, { analysis, playback });

  return json({ ok: true, characters: playback?.characters || null });
}

/**
 * POST /books/:id/characters/:charId/reference-image — user-uploaded
 * reference picture of their own choosing (multipart, single `file` field),
 * per docs/TODO_ILLUSTRATIONS_PROFILES_POLISH.md item 3. Stored in R2 under
 * its own media path and recorded on the character as `reference_images`
 * (see addCharacterReferenceImageInAnalysis/InPlayback) — shown in the
 * character profile viewer. Deliberately NOT routed through
 * external-refs.js's URL-fetch mechanism: that one is for arbitrary remote
 * URLs and its SSRF guard blocks internal/localhost hosts by design, which
 * would strip a same-worker URL right back out in local dev. Not yet wired
 * into image generation as a reference source — see
 * docs/TODO_ILLUSTRATIONS_PROFILES_POLISH.md item 2 for that follow-up.
 */
export async function onCharacterReferenceImageUploadPost({ request, env, bookId, charId }) {
  if (!env.VAE_PACKS) return null;
  if (!charId || charId === "narrator") return json({ error: "invalid character id" }, 400);

  const pair = await loadPair(env, bookId);
  if (!pair) return json({ error: "no such book" }, 404);
  const knownChar = pair.playback?.characters?.[charId]
    || (pair.analysis?.characters || []).some((c) => c.id === charId);
  if (!knownChar) return json({ error: `unknown character "${charId}"` }, 404);

  const form = await request.formData();
  const file = form.get("file");
  if (!file || typeof file === "string") return json({ error: "file required" }, 400);

  let ext = ".png";
  const origName = file.name || "ref.png";
  const dot = origName.lastIndexOf(".");
  if (dot >= 0) {
    const candidate = origName.slice(dot).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".webp"].includes(candidate)) ext = candidate;
  }
  let contentType = file.type || "image/png";
  if (!contentType.startsWith("image/")) {
    contentType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
      : ext === ".webp" ? "image/webp" : "image/png";
  }

  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > 12_000_000) return json({ error: "file too large (12MB max)" }, 400);

  const filename = `${charId}/${Date.now()}${ext}`;
  const { r2MediaKey, mediaUrl } = await import("../../_shared/freemium-image.js");
  await env.VAE_PACKS.put(r2MediaKey(bookId, "character-refs", filename), bytes, {
    httpMetadata: { contentType },
  });
  const url = mediaUrl(bookId, "character-refs", filename);

  const analysis = pair.analysis ? addCharacterReferenceImageInAnalysis(pair.analysis, charId, url) : null;
  const playback = pair.playback ? addCharacterReferenceImageInPlayback(pair.playback, charId, url) : null;
  await savePair(env, bookId, { analysis, playback });

  return json({ ok: true, url, characters: playback?.characters || null });
}
