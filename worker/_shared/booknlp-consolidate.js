/**
 * Consolidate a BookNLP-extracted character roster down to the cast that
 * actually carries the book — the "demote BookNLP" half of the fix.
 *
 * BookNLP runs per-chapter and attributes every quote it finds to a coref
 * cluster; a real volume yields ~200 "characters", of which the long tail is
 * noise: onomatopoeia mis-tagged as proper names ("Ahh", "Gah"), one-off
 * pronoun-only speakers, and per-chapter `unnamed-<coref>` buckets that never
 * resolved to anyone. Surfacing all of them as the proposed cast (the
 * Characters sheet, the imaging roster) is unusable.
 *
 * The signal that separates cast from noise is simply how much a character
 * actually speaks across the whole book — computed here from the merged
 * scenes, not from BookNLP's own per-chapter stats (which don't survive into
 * the assembled book). Named characters clear a low bar; the noise-prone
 * `unnamed-*` buckets need a higher one. `narrator` is always kept.
 *
 * Dropped characters' lines are reassigned to the narrator (kind
 * "narration"), not left dangling — otherwise compile-playback.js's
 * synthesizeUndeclaredCharacters would just re-add every dropped id back into
 * the roster the next time playback rebuilds from analysis (e.g. on any art
 * regenerate). A mis-attributed one-off "quote" reading as narration is the
 * right failure mode anyway: the text is preserved verbatim, only the (wrong)
 * speaker/voice is dropped. This module never invents or rewrites text.
 */

export const DEFAULT_CONSOLIDATE_OPTS = {
  // Minimum spoken lines for a NAMED character (id not starting "unnamed") to
  // survive. 2 keeps anyone who speaks more than a single stray line while
  // still culling one-off gibberish names.
  namedMinLines: 2,
  // Higher bar for anonymous `unnamed-<coref>` buckets — these are far more
  // likely to be noise, so only keep ones with real presence (a genuine
  // recurring speaker BookNLP never named, e.g. a first-person protagonist).
  unnamedMinLines: 6,
  // Never dropped regardless of line count.
  alwaysKeep: ["narrator"],
};

/** True for BookNLP's anonymous coref buckets ("unnamed-0", "unnamed-143"). */
function isUnnamedId(id) {
  return /^unnamed-/.test(String(id || ""));
}

/** Count spoken lines per character_id across all scenes. */
function lineCountsByCharacter(scenes) {
  const counts = new Map();
  for (const scene of scenes || []) {
    for (const line of scene.lines || []) {
      const id = line.character_id;
      if (!id) continue;
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  return counts;
}

/**
 * Decide which character ids to keep.
 * @returns {Set<string>} ids that survive consolidation.
 */
export function keepCharacterIds(scenes, characters, opts = {}) {
  const o = { ...DEFAULT_CONSOLIDATE_OPTS, ...opts };
  const counts = lineCountsByCharacter(scenes);
  const keep = new Set(o.alwaysKeep);
  // Iterate the declared roster AND anyone who actually speaks — a character
  // can be referenced by lines without being in `characters`, and vice versa.
  const ids = new Set([
    ...Object.keys(characters || {}),
    ...(Array.isArray(characters) ? characters.map((c) => c.id) : []),
    ...counts.keys(),
  ]);
  for (const id of ids) {
    if (!id || keep.has(id)) continue;
    const n = counts.get(id) || 0;
    const min = isUnnamedId(id) ? o.unnamedMinLines : o.namedMinLines;
    if (n >= min) keep.add(id);
  }
  return keep;
}

/** Reassign a dropped-character line to the narrator, as narration. Text is
 *  preserved verbatim; speaker-specific fields that would misrender under a
 *  new speaker are cleared. */
function toNarration(line) {
  const out = { ...line, character_id: "narrator", kind: "narration" };
  delete out.speaker_name;
  delete out.sprite_url;
  delete out.expression;
  return out;
}

/** Filter a characters roster (object map keyed by id, or array) to `keep`. */
function filterRoster(characters, keep) {
  if (Array.isArray(characters)) {
    return characters.filter((c) => c && keep.has(c.id));
  }
  const out = {};
  for (const [id, c] of Object.entries(characters || {})) {
    if (keep.has(id)) out[id] = c;
  }
  return out;
}

/** Remap every dropped-character line in `scenes` to narration. Returns a new
 *  scenes array; input is not mutated. */
function remapScenes(scenes, keep) {
  return (scenes || []).map((scene) => ({
    ...scene,
    lines: (scene.lines || []).map((line) => (
      line.character_id && !keep.has(line.character_id) ? toNarration(line) : line
    )),
  }));
}

/**
 * Consolidate a book's characters + scenes.
 * @param {object|object[]} characters  roster (id-keyed map or array)
 * @param {object[]} scenes  merged scenes whose lines carry character_id
 * @param {object} [opts]  threshold overrides (see DEFAULT_CONSOLIDATE_OPTS)
 * @returns {{characters: (object|object[]), scenes: object[], keptIds: string[], droppedIds: string[]}}
 */
export function consolidateCharacters(characters, scenes, opts = {}) {
  // Reuse a caller-supplied keep-set when consolidating several views of the
  // same book (analysis roster + compiled playback roster) so both end up
  // with an identical cast even if their per-view line counts differ slightly.
  const keep = opts.keepIds instanceof Set
    ? opts.keepIds
    : keepCharacterIds(scenes, characters, opts);
  const declaredIds = Array.isArray(characters)
    ? characters.map((c) => c.id)
    : Object.keys(characters || {});
  const droppedIds = declaredIds.filter((id) => id && !keep.has(id));
  return {
    characters: filterRoster(characters, keep),
    scenes: remapScenes(scenes, keep),
    keptIds: [...keep],
    droppedIds,
  };
}
