/**
 * Unit test — cropAndStoreReference (illustration-character-match-consumer.js).
 * Run: node tests/illustration-character-crop.test.mjs
 *
 * Verifies the crop -> R2 store -> reference_images patch chain in isolation
 * from any real book/plate, since whether a *specific* plate has a
 * detectable face is a property of that image, not the wiring. Mocks fetch
 * (the local-image-server /crop_faces call) and env.VAE_PACKS.put.
 */
import assert from "node:assert";
import { cropAndStoreReference } from "../worker/queue/illustration-character-match-consumer.js";
import { addCharacterReferenceImageInAnalysis } from "../worker/_shared/character-merge.js";

// btoa/atob polyfill for Node (Workers runtime has these globally).
if (typeof btoa === "undefined") {
  globalThis.btoa = (s) => Buffer.from(s, "binary").toString("base64");
  globalThis.atob = (s) => Buffer.from(s, "base64").toString("binary");
}

// A face was detected: crop bytes come back, R2 put happens, a media URL is returned.
{
  const cropPngBytes = new Uint8Array([1, 2, 3, 4]);
  const cropB64 = Buffer.from(cropPngBytes).toString("base64");
  let putKey = null;
  let putBytes = null;
  const env = {
    LOCAL_IMAGE_URL: "http://127.0.0.1:7860",
    VAE_PACKS: {
      put: async (key, bytes) => { putKey = key; putBytes = new Uint8Array(bytes); },
    },
    __fetch: async (url, opts) => {
      assert.equal(url, "http://127.0.0.1:7860/crop_faces");
      const body = JSON.parse(opts.body);
      assert.equal(body.max_faces, 1);
      return {
        ok: true,
        json: async () => ({ count: 1, crops: [cropB64] }),
      };
    },
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = env.__fetch;
  try {
    const url = await cropAndStoreReference(env, "book_a", "kuro", new Uint8Array([9, 9]).buffer, "anime", null);
    assert.match(url, /character-refs\/kuro\//, "returns a character-refs media URL");
    assert.ok(putKey?.includes("character-refs/kuro/"), "R2 put targets character-refs/<charId>/");
    assert.deepEqual(putBytes, cropPngBytes, "R2 put stores the decoded crop bytes");

    const analysis = { characters: [{ id: "kuro", name: "Kuro" }] };
    const patched = addCharacterReferenceImageInAnalysis(analysis, "kuro", url);
    assert.deepEqual(patched.characters[0].reference_images, [url], "patch applies the returned URL");
  } finally {
    globalThis.fetch = origFetch;
  }
}

// No face detected: cropAndStoreReference returns null, no R2 put, no throw.
{
  let putCalled = false;
  const env = {
    LOCAL_IMAGE_URL: "http://127.0.0.1:7860",
    VAE_PACKS: { put: async () => { putCalled = true; } },
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ count: 0, crops: [] }) });
  try {
    const url = await cropAndStoreReference(env, "book_a", "kuro", new Uint8Array([9, 9]).buffer, "anime", null);
    assert.equal(url, null, "no crops -> null, not an error");
    assert.equal(putCalled, false, "no R2 put when nothing to store");
  } finally {
    globalThis.fetch = origFetch;
  }
}

// LOCAL_IMAGE_URL not configured: skips cleanly, no fetch attempted.
{
  let fetchCalled = false;
  const env = { VAE_PACKS: { put: async () => {} } };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; };
  try {
    const url = await cropAndStoreReference(env, "book_a", "kuro", new Uint8Array([9, 9]).buffer, "anime", null);
    assert.equal(url, null);
    assert.equal(fetchCalled, false, "never calls the crop endpoint without LOCAL_IMAGE_URL");
  } finally {
    globalThis.fetch = origFetch;
  }
}

console.log("illustration-character-crop.test.mjs: ok");
