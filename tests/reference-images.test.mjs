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

console.log("reference-images.test.mjs: ok");
