/**
 * Unit tests — reference image helpers.
 * Run: npm run test:reference-images
 */
import assert from "node:assert";
import {
  guessImageExt,
  illustrationPublicUrl,
  mediaUrlToR2Key,
  r2IllustrationKey,
  absoluteMediaUrl,
  referenceTargetsForCharacter,
} from "../worker/_shared/reference-images.js";
import { buildPollinationsImageParam } from "../worker/_shared/freemium-image.js";
import { momentDescription } from "../worker/_shared/moment-inserts.js";

{
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]).buffer;
  assert.equal(guessImageExt(png), ".png");
}

{
  assert.equal(r2IllustrationKey("book_a", "img_000.png"), "media/book_a/illustrations/img_000.png");
  assert.equal(illustrationPublicUrl("book_a", "img_000.png"), "/media/book_a/illustrations/img_000.png");
  assert.equal(
    mediaUrlToR2Key("/media/book_a/illustrations/img_000.png?v=1"),
    "media/book_a/illustrations/img_000.png",
  );
  assert.equal(
    absoluteMediaUrl("https://example.com/api", "/media/book_a/anime/char_x.png"),
    "https://example.com/api/media/book_a/anime/char_x.png",
  );
}

{
  const param = buildPollinationsImageParam({
    referenceImageUrls: [
      "https://example.com/a.png",
      "https://example.com/b.png",
    ],
  });
  assert.equal(param, "https://example.com/a.png|https://example.com/b.png");
}

{
  const analysis = {
    characters: [{ id: "mei", name: "Mei", description: "silver hair, red coat" }],
    scenes: [{ id: "s1", title: "Alley", location: "rainy alley", present_character_ids: ["mei"] }],
  };
  const scene = analysis.scenes[0];
  const line = { character_id: "mei", text: "Wait!", expression: "surprised" };
  const prompt = momentDescription(analysis, scene, line);
  assert.match(prompt, /silver hair/i);
  assert.match(prompt, /Characters present/i);
  assert.match(prompt, /Mei/i);
}

// referenceTargetsForCharacter: a character with no illustration_ref set
// must NOT fall back to an arbitrary catalog plate, even when the book's
// illustration catalog is non-empty. Regression for a real bug: the old
// fallback grabbed the first few catalog plates unconditionally, with no
// guarantee any of them depicted this character — and worse, any non-empty
// reference forces generateImage() (freemium-image.js) down a Gemini/
// Pollinations-i2i-only path that never reaches local_sd, so on a book with
// EPUB plates but no confirmed character matches, every character portrait
// silently required cloud API keys even for a fully local setup.
{
  async function noopR2() { return null; }
  const env = { VAE_PACKS: { get: noopR2, put: async () => {} } };
  const analysis = {
    illustration_urls: { 0: "/media/book_a/illustrations/img_000.png", 1: "/media/book_a/illustrations/img_001.png" },
    characters: [{ id: "kuro", name: "Kuro" }], // no illustration_ref
  };
  const { bytes, urls } = await referenceTargetsForCharacter(env, "book_a", analysis, "kuro", "anime");
  assert.deepEqual(bytes, [], "no bytes without a confirmed illustration_ref");
  assert.deepEqual(urls, [], "no urls without a confirmed illustration_ref");
}

// ...but an explicitly-set illustration_ref (model-matched or user-assigned
// via EpubPlatesSheet) still resolves normally.
{
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
  const store = { "media/book_a/illustrations/img_000.png": pngBytes.buffer };
  const env = {
    VAE_PACKS: {
      get: async (key) => (store[key] ? { arrayBuffer: async () => store[key] } : null),
      put: async () => {},
    },
  };
  const analysis = {
    illustration_urls: { 0: "/media/book_a/illustrations/img_000.png" },
    characters: [{ id: "kuro", name: "Kuro", illustration_ref: 0 }],
  };
  const { bytes } = await referenceTargetsForCharacter(env, "book_a", analysis, "kuro", "anime");
  assert.equal(bytes.length, 1, "confirmed illustration_ref still resolves a reference");
}

// character.reference_images (uploaded refs / cropped matches) is the
// highest-priority source — previously stored on the character (visible in
// Character settings) but never actually read by referenceTargetsForCharacter
// at all, so it never reached generateImage().
{
  const store = {
    "media/book_a/character-refs/kuro/123.png": new Uint8Array([9, 9, 9, 9]).buffer,
  };
  const env = {
    VAE_PACKS: {
      get: async (key) => (store[key] ? { arrayBuffer: async () => store[key] } : null),
      put: async () => {},
    },
  };
  const analysis = {
    illustration_urls: { 0: "/media/book_a/illustrations/img_000.png" },
    characters: [{
      id: "kuro", name: "Kuro", illustration_ref: 0,
      reference_images: ["/media/book_a/character-refs/kuro/123.png"],
    }],
  };
  const { bytes } = await referenceTargetsForCharacter(env, "book_a", analysis, "kuro", "anime");
  assert.equal(bytes.length, 1, "reference_images resolves even with illustration_ref also set");
  assert.deepEqual(new Uint8Array(bytes[0]), new Uint8Array([9, 9, 9, 9]),
    "reference_images wins over illustration_ref — pushed first in priority order");
}

console.log("reference-images.test.mjs: ok");
