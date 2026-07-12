/**
 * Unit test — matchPlatesToCharactersVision / matchPlatesToCharactersTextOnly
 * / matchPlatesToCharacters (worker/_shared/illustration-character-match.js).
 * Run: node tests/illustration-character-match-vision.test.mjs
 *
 * Mocks fetch (both the Ollama vision /api/chat call and freemiumExtract's
 * text-only fallback go through global fetch) to verify: vision resolves a
 * plate with image bytes without ever touching the text-only path; a plate
 * with no image bytes falls back to text-only; a vision call error falls
 * back to text-only for that plate only.
 */
import assert from "node:assert";
import {
  matchPlatesToCharacters,
  matchPlatesToCharactersVision,
  identifyCharacterInCrop,
} from "../worker/_shared/illustration-character-match.js";

if (typeof btoa === "undefined") {
  globalThis.btoa = (s) => Buffer.from(s, "binary").toString("base64");
  globalThis.atob = (s) => Buffer.from(s, "base64").toString("binary");
}

const characters = [
  { id: "kuro", name: "Kuro", description: "black-haired swordsman" },
  { id: "elara", name: "Elara", description: "red-haired blacksmith" },
];
const chapters = [{ text: "Chapter 0 text" }, { text: "Kuro drew his blade and Elara watched." }];

function mockOllamaChat(responder) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("/api/chat")) {
      const body = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ message: { content: JSON.stringify(responder(body)) } }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return () => { globalThis.fetch = orig; };
}

// Vision resolves a plate with image bytes directly — no unresolved fallback needed.
{
  const illustrationsByChapterPos = new Map([[1, [{ index: 5, textContext: "" }]]]);
  const restore = mockOllamaChat(() => ({ character_id: "kuro", is_character_portrait: true }));
  try {
    const { results, unresolved } = await matchPlatesToCharactersVision(
      illustrationsByChapterPos, characters, chapters,
      (idx) => (idx === 5 ? new Uint8Array([1, 2, 3]).buffer : null),
      { env: {} },
    );
    assert.equal(results.get(5), "kuro");
    assert.equal(unresolved.length, 0);
  } finally {
    restore();
  }
}

// No image bytes for a plate -> vision leaves it unresolved (caller falls back to text-only).
{
  const illustrationsByChapterPos = new Map([[1, [{ index: 7, textContext: "" }]]]);
  const { results, unresolved } = await matchPlatesToCharactersVision(
    illustrationsByChapterPos, characters, chapters,
    () => null,
    { env: {} },
  );
  assert.equal(results.size, 0);
  assert.deepEqual(unresolved, [{ plateIndex: 7, chapterPos: 1 }]);
}

// Vision call errors for one plate -> falls through to the text-only path
// (exercised for real against freemiumExtract's provider-resolution chain,
// which finds nothing configured in this bare test env) without throwing —
// graceful degradation, not a crash, is the property under test here.
{
  const illustrationsByChapterPos = new Map([[1, [{ index: 9, textContext: "Kuro stood nearby" }]]]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/chat")) return { ok: false, status: 500, text: async () => "boom" };
    return { ok: false, status: 404, text: async () => "" };
  };
  try {
    const matches = await matchPlatesToCharacters(illustrationsByChapterPos, characters, chapters, {
      env: {}, getPlateBytes: (idx) => (idx === 9 ? new Uint8Array([1]).buffer : null),
    });
    assert.equal(matches.size, 0, "no crash, just no match when both vision and text-only are unavailable");
  } finally {
    globalThis.fetch = origFetch;
  }
}

// identifyCharacterInCrop — the per-crop counterpart used for multi-face
// plates (a plate the whole-plate matcher correctly declines on, since no
// single character "clearly, unambiguously" dominates a busy scene, can
// still contribute per-crop matches once each face is isolated).
{
  const restore = mockOllamaChat(() => ({ character_id: "elara" }));
  try {
    const cid = await identifyCharacterInCrop(new Uint8Array([1, 2, 3]), characters, "some context", { env: {} });
    assert.equal(cid, "elara");
  } finally {
    restore();
  }
}
// Unknown character id in the response -> null, not a crash or a bad id leaking through.
{
  const restore = mockOllamaChat(() => ({ character_id: "not-a-real-character" }));
  try {
    const cid = await identifyCharacterInCrop(new Uint8Array([1, 2, 3]), characters, "context", { env: {} });
    assert.equal(cid, null);
  } finally {
    restore();
  }
}
// Vision call errors -> null, best-effort, never throws.
{
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
  try {
    const cid = await identifyCharacterInCrop(new Uint8Array([1, 2, 3]), characters, "context", { env: {} });
    assert.equal(cid, null);
  } finally {
    globalThis.fetch = origFetch;
  }
}

console.log("illustration-character-match-vision.test.mjs: ok");
