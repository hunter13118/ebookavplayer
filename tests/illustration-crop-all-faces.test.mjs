/**
 * Unit test — cropAllFacesForPlate / bboxIoU
 * (worker/queue/illustration-character-match-consumer.js). Run:
 *   node tests/illustration-crop-all-faces.test.mjs
 *
 * Covers the "missing crops" fix: detect and crop EVERY face on a plate
 * (not just one), returning bboxes so the caller can skip a face already
 * identified another way (OCR name-caption pairing) instead of
 * re-cropping/re-identifying it as a near-duplicate.
 */
import assert from "node:assert";
import { cropAllFacesForPlate, bboxIoU } from "../worker/queue/illustration-character-match-consumer.js";

if (typeof btoa === "undefined") {
  globalThis.btoa = (s) => Buffer.from(s, "binary").toString("base64");
  globalThis.atob = (s) => Buffer.from(s, "base64").toString("binary");
}

// bboxIoU: identical boxes -> 1, disjoint boxes -> 0, partial overlap -> between.
assert.equal(bboxIoU([0, 0, 10, 10], [0, 0, 10, 10]), 1);
assert.equal(bboxIoU([0, 0, 10, 10], [100, 100, 10, 10]), 0);
assert.equal(bboxIoU(null, [0, 0, 10, 10]), 0);
{
  const iou = bboxIoU([0, 0, 10, 10], [5, 5, 10, 10]);
  assert.ok(iou > 0 && iou < 1, `expected partial overlap, got ${iou}`);
}

// cropAllFacesForPlate: requests a capped, not single, max_faces and pairs
// each returned crop with its bbox.
{
  const crop1B64 = Buffer.from([1, 1]).toString("base64");
  const crop2B64 = Buffer.from([2, 2]).toString("base64");
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    assert.equal(url, "http://127.0.0.1:7860/crop_faces");
    const body = JSON.parse(opts.body);
    assert.ok(body.max_faces > 1, "requests more than one face, unlike the old single-crop path");
    return {
      ok: true,
      json: async () => ({
        count: 2,
        crops: [crop1B64, crop2B64],
        bboxes: [[0, 0, 10, 10], [50, 50, 10, 10]],
      }),
    };
  };
  try {
    const faces = await cropAllFacesForPlate({ LOCAL_IMAGE_URL: "http://127.0.0.1:7860" }, new Uint8Array([9]).buffer, null);
    assert.equal(faces.length, 2);
    assert.deepEqual(faces[0].bbox, [0, 0, 10, 10]);
    assert.deepEqual(faces[0].cropBytes, new Uint8Array([1, 1]));
    assert.deepEqual(faces[1].bbox, [50, 50, 10, 10]);
  } finally {
    globalThis.fetch = origFetch;
  }
}

// No LOCAL_IMAGE_URL / zero detections / fetch failure -> empty array, never throws.
{
  const out = await cropAllFacesForPlate({}, new Uint8Array([9]).buffer, null);
  assert.deepEqual(out, []);
}
{
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ count: 0, crops: [], bboxes: [] }) });
  try {
    const out = await cropAllFacesForPlate({ LOCAL_IMAGE_URL: "http://127.0.0.1:7860" }, new Uint8Array([9]).buffer, null);
    assert.deepEqual(out, []);
  } finally {
    globalThis.fetch = origFetch;
  }
}

console.log("illustration-crop-all-faces.test.mjs: ok");
