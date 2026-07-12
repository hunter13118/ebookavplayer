/**
 * Unit tests — external refs + illustration modes.
 * Run: npm run test:external-refs
 */
import assert from "node:assert";
import {
  normalizeExternalRefUrl,
  sanitizeExternalRefs,
  externalRefUrlsForCharacter,
} from "../worker/_shared/external-refs.js";
import {
  normalizeIllustrationMode,
  applyDirectIllustrations,
} from "../worker/_shared/illustrations.js";

assert.equal(normalizeExternalRefUrl("https://example.com/a.png"), "https://example.com/a.png");
assert.equal(normalizeExternalRefUrl("http://127.0.0.1/x.png"), null);
assert.equal(normalizeExternalRefUrl("ftp://x/y"), null);

const clean = sanitizeExternalRefs({
  characters: { mei: ["https://a.test/1.png", "http://127.0.0.1/bad"] },
  book: ["https://b.test/2.png"],
});
assert.deepEqual(clean.characters.mei, ["https://a.test/1.png"]);
assert.deepEqual(clean.book, ["https://b.test/2.png"]);
assert.deepEqual(
  externalRefUrlsForCharacter(clean, "mei"),
  ["https://a.test/1.png", "https://b.test/2.png"],
);

assert.equal(normalizeIllustrationMode("direct-use", "anime", 3), "direct-use");
// "moment" is a manual, opt-in, per-scene feature (POST /books/:id/moments/generate) —
// never applied automatically. "direct-use" is the only mode that automatically
// surfaces extracted EPUB plates as cover/character/background art, so when real
// plates exist, that should be the default regardless of art style.
assert.equal(normalizeIllustrationMode("auto", "anime", 3), "direct-use");
assert.equal(normalizeIllustrationMode("auto", "semi-real", 3), "direct-use");
// No real plates extracted — nothing to show, falls back to reference (server-side i2i hint only).
assert.equal(normalizeIllustrationMode("auto", "anime", 0), "reference");
// Explicit opt-in still wins over the size-based default.
assert.equal(normalizeIllustrationMode("moment", "anime", 3), "moment");

const analysis = {
  characters: [{ id: "mei", illustration_ref: 0 }],
  scenes: [{ id: "scene-0001", illustration_ref: 1 }],
};
const urls = { 0: "/media/x/illustrations/img_000.png", 1: "/media/x/illustrations/img_001.png" };
const playback = {
  cover: null,
  characters: { mei: { name: "Mei", sprite: "sprite:x" } },
  scenes: [{
    id: "scene-0001",
    background: "gradient:1,2",
    present: [{ character_id: "mei", sprite: "sprite:x" }],
    lines: [{ idx: 0, character_id: "mei", text: "Mei spoke." }],
  }],
};
const applied = applyDirectIllustrations(structuredClone(playback), analysis, urls);
assert.equal(applied.counts.characters, 1);
assert.equal(applied.counts.backgrounds, 1);
assert.equal(applied.counts.cover, 1);
// A matched plate never overwrites the rendered sprite — it unlocks as an
// illustration moment on the character's line instead (see illustrations.js).
assert.equal(applied.playback.characters.mei.sprite, "sprite:x");
assert.equal(applied.playback.scenes[0].lines[0].illustration_url, urls[0]);

console.log("external-refs + illustrations: ok");
