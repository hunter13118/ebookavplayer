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

/** Expression Sensitivity Plan Phase 1f: set/edit a character's baseline
 * temperament in place — no scene/line rewrite needed, it's context for the
 * expression re-pass (worker/_shared/expression-repass.js), not a display field. */
export function setCharacterTemperamentInAnalysis(analysis, id, temperament) {
  if (!(analysis.characters || []).some((c) => c.id === id)) return analysis;
  return {
    ...analysis,
    characters: analysis.characters.map((c) => (c.id === id ? { ...c, temperament } : c)),
  };
}

export function setCharacterTemperamentInPlayback(playback, id, temperament) {
  if (!playback.characters?.[id]) return playback;
  return {
    ...playback,
    characters: { ...playback.characters, [id]: { ...playback.characters[id], temperament } },
  };
}

/** User-editable character description — overrides whatever the extraction
 * model wrote, same shape/pattern as temperament above. Display-only (shown
 * in the character profile viewer), not fed back into any prompt. */
export function setCharacterDescriptionInAnalysis(analysis, id, description) {
  if (!(analysis.characters || []).some((c) => c.id === id)) return analysis;
  return {
    ...analysis,
    characters: analysis.characters.map((c) => (c.id === id ? { ...c, description } : c)),
  };
}

export function setCharacterDescriptionInPlayback(playback, id, description) {
  if (!playback.characters?.[id]) return playback;
  return {
    ...playback,
    characters: { ...playback.characters, [id]: { ...playback.characters[id], description } },
  };
}

const MAX_REFERENCE_IMAGES = 8;

/** User-uploaded reference pictures of their own choosing, shown in the
 * character profile viewer — R2-backed media URLs (own /media/ route), not
 * routed through external_refs.js's fetch-based mechanism (that one is for
 * arbitrary remote URLs and deliberately blocks internal/localhost hosts as
 * an SSRF guard; these are always same-worker URLs anyway). Not yet wired
 * into image generation as a reference source — see
 * docs/TODO_ILLUSTRATIONS_PROFILES_POLISH.md item 2 for that follow-up. */
export function addCharacterReferenceImageInAnalysis(analysis, id, url) {
  if (!(analysis.characters || []).some((c) => c.id === id)) return analysis;
  return {
    ...analysis,
    characters: analysis.characters.map((c) => (c.id === id ? {
      ...c,
      reference_images: [...new Set([...(c.reference_images || []), url])].slice(-MAX_REFERENCE_IMAGES),
    } : c)),
  };
}

export function addCharacterReferenceImageInPlayback(playback, id, url) {
  if (!playback.characters?.[id]) return playback;
  const c = playback.characters[id];
  return {
    ...playback,
    characters: {
      ...playback.characters,
      [id]: {
        ...c,
        reference_images: [...new Set([...(c.reference_images || []), url])].slice(-MAX_REFERENCE_IMAGES),
      },
    },
  };
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
