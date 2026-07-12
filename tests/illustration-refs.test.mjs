/**
 * Unit tests — illustration ref patch helpers.
 * Run: npm run test:illustration-refs
 */
import assert from "node:assert";
import {
  applyIllustrationRefsPatch,
  syncIllustrationRefsToPlayback,
  validateIllustrationRef,
} from "../worker/_shared/illustration-refs.js";
import { applyDirectIllustrations } from "../worker/_shared/illustrations.js";

const analysis = {
  illustration_urls: {
    0: "/media/x/illustrations/img_000.png",
    1: "/media/x/illustrations/img_001.png",
  },
  characters: [{ id: "mei", name: "Mei" }],
};

assert.equal(validateIllustrationRef(0, analysis.illustration_urls), true);
assert.equal(validateIllustrationRef(9, analysis.illustration_urls), false);
assert.equal(validateIllustrationRef(null, analysis.illustration_urls), true);

const patched = applyIllustrationRefsPatch(analysis, {
  cover_illustration_ref: 0,
  characters: { mei: 1 },
});
assert.equal(patched.cover_illustration_ref, 0);
assert.equal(patched.characters[0].illustration_ref, 1);

const playback = { characters: { mei: { name: "Mei" } } };
syncIllustrationRefsToPlayback(playback, patched);
assert.equal(playback.characters.mei.illustration_ref, 1);

// Regression: PATCH /books/:id/illustration-refs used to save cover_illustration_ref
// and a character's illustration_ref as pure metadata numbers — nothing ever
// resolved them against the catalog or wrote them onto the actual rendered
// cover/moment fields, so a manual assignment via the "Character settings" UI
// saved successfully but changed nothing visible in the player. Confirms the
// full manual-assignment chain (patch -> sync -> applyDirectIllustrations,
// the same function onIllustrationRefsPatch now calls) actually updates them.
//
// A character's matched/assigned plate must NEVER become their rendered
// sprite — a raw EPUB plate is often a multi-character scene or a caption
// montage, not a clean portrait (see illustrations.js's applyDirectIllustrations
// docstring). It surfaces instead as an unlocked illustration "moment" on
// that character's first line, same data shape the Illustrations gallery
// (illustrationGallery.js's collectIllustrations) already reads.
{
  const playback2 = {
    cover: null,
    characters: { mei: { name: "Mei", sprite: "sprite:gradient:1,2" } },
    scenes: [{
      id: "s1",
      present: [{ character_id: "mei", sprite: "sprite:gradient:1,2" }],
      lines: [{ idx: 0, character_id: "mei", text: "Mei looked up." }],
    }],
  };
  let synced = syncIllustrationRefsToPlayback(playback2, patched);
  const { playback: applied, counts } = applyDirectIllustrations(synced, patched, analysis.illustration_urls);
  assert.equal(applied.characters.mei.sprite, "sprite:gradient:1,2",
    "a matched/assigned plate never overwrites the character's rendered sprite");
  assert.equal(applied.scenes[0].present[0].sprite, "sprite:gradient:1,2",
    "denormalized scene.present sprite is untouched too");
  assert.equal(applied.scenes[0].lines[0].illustration_url, "/media/x/illustrations/img_001.png",
    "the plate instead unlocks as an illustration moment on the character's first line");
  assert.equal(applied.scenes[0].lines[0].visual_moment, true);
  assert.equal(applied.inserts["0"], "/media/x/illustrations/img_001.png",
    "moment is also recorded in playback.inserts so it survives a recompile");
  assert.equal(applied.cover, "/media/x/illustrations/img_000.png",
    "explicit cover_illustration_ref is honored even before this fix's opportunistic fallback would have kicked in");
  assert.equal(counts.characters, 1);
  assert.equal(counts.cover, 1);
}

// A cover-only assignment (no character/scene matches at all) still applies —
// the old code's `counts.characters + counts.backgrounds > 0` gate meant an
// explicit cover-only assignment was silently dropped.
{
  const coverOnlyAnalysis = { cover_illustration_ref: 0, characters: [], scenes: [] };
  const playback3 = { cover: null, characters: {}, scenes: [] };
  const { playback: applied } = applyDirectIllustrations(playback3, coverOnlyAnalysis, analysis.illustration_urls);
  assert.equal(applied.cover, "/media/x/illustrations/img_000.png");
}

console.log("illustration-refs: ok");
