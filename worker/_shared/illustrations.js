/** EPUB illustration modes — edge port of server/playback/illustrations.py */

export function defaultIllustrationMode(artStyle, imageCount) {
  // "moment" is a manual, opt-in, per-scene feature — never applied
  // automatically. "direct-use" is the only mode that automatically surfaces
  // extracted EPUB plates as cover/character/background art, so when real
  // plates exist, use them rather than silently discarding them into
  // "reference" (server-side i2i hint only, never shown to the user).
  if (imageCount > 0) return "direct-use";
  return "reference";
}

export function normalizeIllustrationMode(mode, artStyle, imageCount) {
  const m = String(mode || "auto").toLowerCase().trim();
  if (["direct", "direct-use", "direct_use", "use"].includes(m)) return "direct-use";
  if (["moment", "flash", "insert"].includes(m)) return "moment";
  if (m === "reference") return "reference";
  return defaultIllustrationMode(artStyle, imageCount);
}

function catalogUrl(catalog, ref) {
  if (ref == null) return null;
  return catalog?.[ref] ?? catalog?.[String(ref)] ?? null;
}

function illustrationCaption(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  return t.length > 72 ? `${t.slice(0, 72).trim()}…` : t;
}

/** First line in reading order spoken by (or, failing that, present with)
 * this character — where a matched plate's "moment" should unlock. Prefers
 * an actual dialogue/narration line credited to the character over a mere
 * presence entry, since that's the more narratively meaningful reveal. */
function firstLineForCharacter(playback, charId) {
  let presentFallback = null;
  for (const scene of playback?.scenes || []) {
    for (const line of scene.lines || []) {
      if (line.character_id === charId) return line;
      if (!presentFallback && (scene.present || []).some((p) => p.character_id === charId)) {
        presentFallback = line;
      }
    }
  }
  return presentFallback;
}

/**
 * Map illustration_ref → book cover / background slots, and character
 * illustration_ref → an unlocked illustration "moment" on that character's
 * first line — NEVER onto character.sprite. A raw EPUB plate (whole page,
 * often multi-character, sometimes a caption-sheet montage) is not a
 * portrait — the portrait a listener sees on stage must stay either the
 * placeholder gradient or actual generated art (reference-conditioned via
 * character.reference_images, see reference-images.js), same as this
 * codebase already treats reference_images as generation input, never
 * display art (see illustration-character-match-consumer.js). The plate
 * itself belongs in the Illustrations gallery / as a story moment instead —
 * see illustrationGallery.js's collectIllustrations, which reads exactly
 * the inserts/line.illustration_url fields set below.
 */
export function applyDirectIllustrations(playback, analysis, illustrationUrls) {
  const counts = { characters: 0, backgrounds: 0, cover: 0 };
  if (!playback || !illustrationUrls || !Object.keys(illustrationUrls).length) {
    return { playback, counts };
  }

  // An explicit cover_illustration_ref (model-matched at extraction time, or
  // user-assigned via the "Cover reference plate" dropdown) always wins —
  // this used to be entirely unread here, so assigning a cover plate saved
  // successfully but never actually changed playback.cover; the loops below
  // only ever set a cover *opportunistically*, as a fallback reusing
  // whichever character/scene plate happened to match first.
  const explicitCoverUrl = catalogUrl(illustrationUrls, analysis?.cover_illustration_ref);
  let coverUrl = explicitCoverUrl || (playback.cover && String(playback.cover).startsWith("/media/")
    ? playback.cover
    : null);

  playback.inserts = playback.inserts || {};
  for (const c of analysis?.characters || []) {
    if (!c?.id) continue;
    const url = catalogUrl(illustrationUrls, c.illustration_ref);
    if (!url || !playback.characters?.[c.id]) continue;
    const line = firstLineForCharacter(playback, c.id);
    if (line) {
      line.illustration_url = url;
      line.illustration_caption = line.illustration_caption || illustrationCaption(line.text);
      line.visual_moment = true;
      playback.inserts[String(line.idx)] = url;
      counts.characters += 1;
    }
    if (!coverUrl) coverUrl = url;
  }

  for (const s of analysis?.scenes || []) {
    if (s.reuse_background_of) continue;
    const url = catalogUrl(illustrationUrls, s.illustration_ref);
    if (!url) continue;
    const sceneOut = (playback.scenes || []).find((sc) => sc.id === s.id);
    if (!sceneOut) continue;
    sceneOut.background = url;
    counts.backgrounds += 1;
    if (!coverUrl) coverUrl = url;
  }

  if (coverUrl && (explicitCoverUrl || counts.characters + counts.backgrounds > 0)) {
    playback.cover = coverUrl;
    counts.cover = 1;
  }

  return { playback, counts };
}
