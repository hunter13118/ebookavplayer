import { json } from "../../_shared/jobs-kv.js";
import {
  mergeCharacterInAnalysis, mergeCharacterInPlayback, renameCharacterInAnalysis, renameCharacterInPlayback,
  setCharacterTemperamentInAnalysis, setCharacterTemperamentInPlayback,
  setCharacterDescriptionInAnalysis, setCharacterDescriptionInPlayback,
  setCharacterIsHumanoidInAnalysis, setCharacterIsHumanoidInPlayback,
  addCharacterReferenceImageInAnalysis, addCharacterReferenceImageInPlayback,
  removeCharacterReferenceImageInAnalysis, removeCharacterReferenceImageInPlayback,
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

/** PATCH /books/:id/characters/is-humanoid — mark a character as humanoid
 * (default) or not, e.g. an animal/creature character like "Lucy" or "Krul".
 * Feeds image generation's gendered aesthetic-boost gating (edge-imaging.js/
 * freemium-image.js) — see CharacterManager.jsx for the toggle UI. */
export async function onCharacterIsHumanoidPatch({ request, env, bookId }) {
  if (!env.VAE_PACKS) return null;

  let body = {};
  try { body = await request.json(); } catch { /* empty */ }
  const { id, is_humanoid: isHumanoid } = body;
  if (!id || typeof isHumanoid !== "boolean") return json({ error: "expected { id, is_humanoid: boolean }" }, 400);

  const pair = await loadPair(env, bookId);
  if (!pair) return json({ error: "no such book" }, 404);

  const analysis = pair.analysis ? setCharacterIsHumanoidInAnalysis(pair.analysis, id, isHumanoid) : null;
  const playback = pair.playback ? setCharacterIsHumanoidInPlayback(pair.playback, id, isHumanoid) : null;

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

/**
 * DELETE /books/:id/characters/:charId/reference-image — body { url }.
 * Detaches one reference image from a character (a redundant near-duplicate
 * crop from re-running auto-match, or a mismatched face) — requested after
 * a real book accumulated many redundant references from repeated matching
 * passes. Does not delete the underlying R2 object, just the character's
 * pointer to it (cheap; re-attachable via the assign endpoint below if
 * removed by mistake).
 */
export async function onCharacterReferenceImageDelete({ request, env, bookId, charId }) {
  if (!env.VAE_PACKS) return null;
  if (!charId || charId === "narrator") return json({ error: "invalid character id" }, 400);

  let body = {};
  try { body = await request.json(); } catch { /* empty */ }
  const { url } = body;
  if (!url) return json({ error: "expected { url }" }, 400);

  const pair = await loadPair(env, bookId);
  if (!pair) return json({ error: "no such book" }, 404);

  const analysis = pair.analysis ? removeCharacterReferenceImageInAnalysis(pair.analysis, charId, url) : null;
  const playback = pair.playback ? removeCharacterReferenceImageInPlayback(pair.playback, charId, url) : null;
  await savePair(env, bookId, { analysis, playback });

  return json({ ok: true, characters: playback?.characters || null });
}

/**
 * POST /books/:id/characters/:charId/reference-image/assign — body { url }.
 * Attaches an *already-stored* media URL (typically another character's
 * crop that was actually a mismatch, or any character-refs/illustrations
 * asset the caller already knows about) as this character's reference
 * image — the "pick from our cropped images" counterpart to the multipart
 * upload endpoint above, for correcting a wrong auto-match without
 * re-uploading a file. Requires the URL to be this book's own media (same
 * SSRF-avoidance reasoning as the upload endpoint — these must be
 * same-worker URLs, not arbitrary remote ones; use external-refs.js for
 * that case instead).
 */
export async function onCharacterReferenceImageAssignPost({ request, env, bookId, charId }) {
  if (!env.VAE_PACKS) return null;
  if (!charId || charId === "narrator") return json({ error: "invalid character id" }, 400);

  let body = {};
  try { body = await request.json(); } catch { /* empty */ }
  const { url } = body;
  if (!url || !String(url).startsWith(`/media/${bookId}/`)) {
    return json({ error: "expected { url } pointing at this book's own /media/ assets" }, 400);
  }

  const pair = await loadPair(env, bookId);
  if (!pair) return json({ error: "no such book" }, 404);
  const knownChar = pair.playback?.characters?.[charId]
    || (pair.analysis?.characters || []).some((c) => c.id === charId);
  if (!knownChar) return json({ error: `unknown character "${charId}"` }, 404);

  const analysis = pair.analysis ? addCharacterReferenceImageInAnalysis(pair.analysis, charId, url) : null;
  const playback = pair.playback ? addCharacterReferenceImageInPlayback(pair.playback, charId, url) : null;
  await savePair(env, bookId, { analysis, playback });

  return json({ ok: true, url, characters: playback?.characters || null });
}

/**
 * GET /books/:id/character-crops — the full crop catalog: every crop image
 * ever stored for this book (R2-listed under media/{id}/character-refs/**),
 * whether or not it's currently attached to a character — "mapped or not
 * mapped" per the user's ask, since a plate can be cropped/OCR-paired
 * without a confident enough character match, and a crop detached via the
 * DELETE reference-image endpoint below stays in R2 (cheap) but would
 * otherwise become invisible. Each entry is tagged with `owner_id`/
 * `owner_name` (null when nothing currently points at it) by cross-
 * referencing every character's `reference_images`, so the catalog UI can
 * show "Unassigned" and offer to attach it to any character.
 */
export async function onCharacterCropsGet({ env, bookId }) {
  if (!env.VAE_PACKS) return null;

  const pair = await loadPair(env, bookId);
  if (!pair) return json({ error: "no such book" }, 404);

  const characters = pair.analysis?.characters || Object.entries(pair.playback?.characters || {})
    .map(([id, c]) => ({ id, name: c.name, reference_images: c.reference_images }));
  const byId = new Map(characters.map((c) => [c.id, c]));

  const ownerByUrl = new Map();
  for (const c of characters) {
    for (const url of c.reference_images || []) {
      if (!ownerByUrl.has(url)) ownerByUrl.set(url, c.id);
    }
  }

  const { mediaUrl } = await import("../../_shared/freemium-image.js");
  const prefix = `media/${bookId}/character-refs/`;
  const listed = await env.VAE_PACKS.list({ prefix, limit: 1000 });

  const crops = listed.objects
    .map((obj) => {
      const rest = obj.key.slice(prefix.length); // "{charId}/{filename}"
      const slash = rest.indexOf("/");
      if (slash < 0) return null;
      const storedUnder = rest.slice(0, slash);
      const filename = rest.slice(slash + 1);
      const url = mediaUrl(bookId, "character-refs", `${storedUnder}/${filename}`);
      const ownerId = ownerByUrl.get(url) || null;
      return {
        url,
        stored_under: storedUnder,
        owner_id: ownerId,
        owner_name: ownerId ? (byId.get(ownerId)?.name || ownerId) : null,
        uploaded: obj.uploaded,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.uploaded || 0) - (a.uploaded || 0) || a.url.localeCompare(b.url));

  return json({ crops });
}
