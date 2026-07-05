import { json } from "../../_shared/jobs-kv.js";
import {
  mergeCharacterInAnalysis, mergeCharacterInPlayback, renameCharacterInAnalysis, renameCharacterInPlayback,
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
