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
// sprite/cover fields, so a manual assignment via the "Character settings" UI
// saved successfully but changed nothing visible in the player. Confirms the
// full manual-assignment chain (patch -> sync -> applyDirectIllustrations,
// the same function onIllustrationRefsPatch now calls) actually updates them.
{
  const playback2 = {
    cover: null,
    characters: { mei: { name: "Mei", sprite: "sprite:gradient:1,2" } },
    scenes: [{ id: "s1", present: [{ character_id: "mei", sprite: "sprite:gradient:1,2" }] }],
  };
  let synced = syncIllustrationRefsToPlayback(playback2, patched);
  const { playback: applied, counts } = applyDirectIllustrations(synced, patched, analysis.illustration_urls);
  assert.equal(applied.characters.mei.sprite, "/media/x/illustrations/img_001.png",
    "manually-assigned character plate actually becomes the rendered sprite");
  assert.equal(applied.scenes[0].present[0].sprite, "/media/x/illustrations/img_001.png",
    "denormalized scene.present sprite also updates, matching what the player reads");
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
