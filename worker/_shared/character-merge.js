/**
 * User-driven character identity fixes: merge one character id into another
 * (e.g. "unnamed-male-protagonist" -> "eizo") or rename one in place. Unlike
 * character-reconcile.js (an automatic heuristic run once at extraction
 * time), these are explicit user actions applied retroactively across the
 * whole book, and persisted as an alias so future-extracted chapters get the
 * same id on arrival — see applyCharacterAliases, consulted from
 * chapter-extract-pipeline.js on every newly-produced chapter.
 */

function remapId(id, fromId, toId) {
  return id === fromId ? toId : id;
}

/** Merge fromId into toId across the book's analysis.json (source-of-truth character list + scenes). */
export function mergeCharacterInAnalysis(analysis, fromId, toId) {
  const from = (analysis.characters || []).find((c) => c.id === fromId);
  const to = (analysis.characters || []).find((c) => c.id === toId);
  if (!from || !to || fromId === toId) return analysis;

  const merged = {
    ...to,
    aliases: [...new Set([...(to.aliases || []), ...(from.aliases || []), from.name].filter(Boolean))],
    description: (to.description || "").length >= (from.description || "").length ? to.description : from.description,
  };

  const characters = (analysis.characters || [])
    .filter((c) => c.id !== fromId && c.id !== toId)
    .concat(merged);

  const scenes = (analysis.scenes || []).map((s) => ({
    ...s,
    present_character_ids: (s.present_character_ids || []).map((id) => remapId(id, fromId, toId)),
    lines: (s.lines || []).map((l) => (l.character_id ? { ...l, character_id: remapId(l.character_id, fromId, toId) } : l)),
  }));

  return { ...analysis, characters, scenes };
}

/** Merge fromId into toId across the compiled playback.json (baked speaker_name/sprite/voice on every line). */
export function mergeCharacterInPlayback(playback, fromId, toId) {
  const to = playback.characters?.[toId];
  if (!playback.characters?.[fromId] || !to || fromId === toId) return playback;

  const characters = { ...playback.characters };
  delete characters[fromId];

  const scenes = (playback.scenes || []).map((scene) => ({
    ...scene,
    present: (scene.present || []).map((p) => (p.character_id === fromId
      ? { character_id: toId, name: to.name, sprite: to.sprite, importance: to.importance }
      : p)),
    lines: (scene.lines || []).map((l) => (l.character_id === fromId
      ? {
        ...l, character_id: toId, speaker_name: to.name, voice: to.voice, pitch: to.pitch, rate: to.rate,
      }
      : l)),
  }));

  return { ...playback, characters, scenes };
}

/** Rename toId in place (no merge) — updates the display name everywhere it's baked into playback. */
export function renameCharacterInAnalysis(analysis, id, name) {
  if (!(analysis.characters || []).some((c) => c.id === id)) return analysis;
  return { ...analysis, characters: analysis.characters.map((c) => (c.id === id ? { ...c, name } : c)) };
}

export function renameCharacterInPlayback(playback, id, name) {
  if (!playback.characters?.[id]) return playback;
  const characters = { ...playback.characters, [id]: { ...playback.characters[id], name } };
  const scenes = (playback.scenes || []).map((scene) => ({
    ...scene,
    present: (scene.present || []).map((p) => (p.character_id === id ? { ...p, name } : p)),
    lines: (scene.lines || []).map((l) => (l.character_id === id ? { ...l, speaker_name: name } : l)),
  }));
  return { ...playback, characters, scenes };
}

/**
 * Applied to a freshly-extracted chapter's analysis before it's compiled,
 * so a user-confirmed alias (from an earlier merge) is honored the moment a
 * placeholder reappears, without waiting on the heuristic reconcile's
 * description/gender scoring to happen to match again.
 */
export function applyCharacterAliases(chapterAnalysis, aliasMap) {
  if (!aliasMap || !Object.keys(aliasMap).length) return chapterAnalysis;
  const resolve = (id) => {
    const seen = new Set();
    let cur = id;
    while (aliasMap[cur] && !seen.has(cur)) {
      seen.add(cur);
      cur = aliasMap[cur];
    }
    return cur;
  };

  const idMap = new Map();
  const chars = chapterAnalysis.characters || [];
  const renamed = chars.map((c) => {
    const target = resolve(c.id);
    if (target === c.id) return c;
    idMap.set(c.id, target);
    return { ...c, id: target, aliases: [...new Set([...(c.aliases || []), c.name].filter(Boolean))] };
  });
  if (!idMap.size) return chapterAnalysis;

  const dedupedById = new Map();
  for (const c of renamed) {
    const existing = dedupedById.get(c.id);
    if (!existing) { dedupedById.set(c.id, { ...c }); continue; }
    existing.aliases = [...new Set([...(existing.aliases || []), ...(c.aliases || [])])];
  }

  const remap = (id) => idMap.get(id) || id;
  const scenes = (chapterAnalysis.scenes || []).map((s) => ({
    ...s,
    present_character_ids: (s.present_character_ids || []).map(remap),
    lines: (s.lines || []).map((l) => (l.character_id ? { ...l, character_id: remap(l.character_id) } : l)),
  }));

  return { ...chapterAnalysis, characters: [...dedupedById.values()], scenes };
}
