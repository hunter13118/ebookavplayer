/**
 * Unit test — fuzzyMatchCharacterName / ocrNamedCropsForPlate
 * (worker/queue/illustration-character-match-consumer.js). Run:
 *   node tests/illustration-plate-ocr.test.mjs
 *
 * Covers the "plate 8" case (docs/TODO_ILLUSTRATIONS_PROFILES_POLISH.md):
 * a plate captions character names directly on the image, OCR extracts
 * them, and each gets fuzzy-matched to the book's character roster —
 * including tolerance for Tesseract dropping a leading/trailing character
 * on small in-image text (e.g. "Elara" read as "lara").
 */
import assert from "node:assert";
import { fuzzyMatchCharacterName, ocrNamedCropsForPlate } from "../worker/queue/illustration-character-match-consumer.js";

if (typeof btoa === "undefined") {
  globalThis.btoa = (s) => Buffer.from(s, "binary").toString("base64");
  globalThis.atob = (s) => Buffer.from(s, "base64").toString("binary");
}

const characters = [
  { id: "elara", name: "Elara Vance" },
  { id: "kuro", name: "Kuro" },
];

// Exact name match.
assert.equal(fuzzyMatchCharacterName("Kuro", characters), "kuro");
// Partial OCR read (dropped leading char) still matches via containment.
assert.equal(fuzzyMatchCharacterName("lara", characters), "elara");
// Full multi-word name.
assert.equal(fuzzyMatchCharacterName("Elara Vance", characters), "elara");
// No plausible match -> null, not a guess.
assert.equal(fuzzyMatchCharacterName("Bystander", characters), null);
// Single-letter junk never matches anything.
assert.equal(fuzzyMatchCharacterName("K", characters), null);

// ocrNamedCropsForPlate: end-to-end against a mocked /ocr_faces response —
// two labeled faces on one plate, one maps to a known character, one is OCR
// noise that matches nothing and should be dropped.
{
  const cropB64 = Buffer.from([1, 2, 3]).toString("base64");
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    assert.equal(url, "http://127.0.0.1:7860/ocr_faces");
    JSON.parse(opts.body); // shape check
    return {
      ok: true,
      json: async () => ({
        count: 2,
        matches: [
          { label: "lara", bbox: [0, 0, 10, 10], crop_b64: cropB64 },
          { label: "xyzzy", bbox: [50, 50, 10, 10], crop_b64: cropB64 },
        ],
      }),
    };
  };
  try {
    const out = await ocrNamedCropsForPlate({ LOCAL_IMAGE_URL: "http://127.0.0.1:7860" }, new Uint8Array([9]).buffer, characters, null);
    assert.equal(out.length, 1, "only the confidently-matched label produces a crop");
    assert.equal(out[0].charId, "elara");
    assert.deepEqual(out[0].cropBytes, new Uint8Array([1, 2, 3]));
  } finally {
    globalThis.fetch = origFetch;
  }
}

// No LOCAL_IMAGE_URL configured -> skips cleanly, no fetch attempted.
{
  let fetchCalled = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; };
  try {
    const out = await ocrNamedCropsForPlate({}, new Uint8Array([9]).buffer, characters, null);
    assert.deepEqual(out, []);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = origFetch;
  }
}

console.log("illustration-plate-ocr.test.mjs: ok");
