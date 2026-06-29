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

console.log("illustration-refs: ok");
