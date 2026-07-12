/**
 * character-merge — reference image add/remove (character-merge.js) and the
 * DELETE/assign/list endpoints built on top (characters.js). Run:
 *   node tests/character-reference-images.test.mjs
 *
 * Covers the "too many redundant/wrong reference pictures, need to manage
 * them and pick from existing crops" request: removing one image from a
 * character, reassigning an existing crop (currently on the wrong
 * character) to the right one, and listing every crop in the book tagged
 * by current owner for the picker UI.
 */
import assert from "node:assert";
import {
  addCharacterReferenceImageInAnalysis, addCharacterReferenceImageInPlayback,
  removeCharacterReferenceImageInAnalysis, removeCharacterReferenceImageInPlayback,
} from "../worker/_shared/character-merge.js";
import {
  onCharacterReferenceImageDelete, onCharacterReferenceImageAssignPost, onCharacterCropsGet,
} from "../worker/api/v1/characters.js";

// --- removeCharacterReferenceImageInAnalysis / InPlayback: unit-level ---
{
  let analysis = { characters: [{ id: "anne", name: "Anne", reference_images: [] }] };
  analysis = addCharacterReferenceImageInAnalysis(analysis, "anne", "/media/b/character-refs/anne/1.png");
  analysis = addCharacterReferenceImageInAnalysis(analysis, "anne", "/media/b/character-refs/anne/2.png");
  assert.equal(analysis.characters[0].reference_images.length, 2);

  analysis = removeCharacterReferenceImageInAnalysis(analysis, "anne", "/media/b/character-refs/anne/1.png");
  assert.deepEqual(analysis.characters[0].reference_images, ["/media/b/character-refs/anne/2.png"]);

  // Removing a url that isn't there / an unknown character is a no-op, not an error.
  const unchanged = removeCharacterReferenceImageInAnalysis(analysis, "anne", "/media/b/nope.png");
  assert.deepEqual(unchanged.characters[0].reference_images, ["/media/b/character-refs/anne/2.png"]);
  const unknownChar = removeCharacterReferenceImageInAnalysis(analysis, "ghost", "/media/b/character-refs/anne/2.png");
  assert.deepEqual(unknownChar, analysis);
}

{
  let playback = { characters: { anne: { name: "Anne", reference_images: [] } } };
  playback = addCharacterReferenceImageInPlayback(playback, "anne", "/media/b/character-refs/anne/1.png");
  playback = removeCharacterReferenceImageInPlayback(playback, "anne", "/media/b/character-refs/anne/1.png");
  assert.deepEqual(playback.characters.anne.reference_images, []);
}

// --- endpoint-level: a fake env.VAE_PACKS backed by an in-memory map, with
// a minimal R2-style .list() over a separately-seeded set of object keys
// (onCharacterCropsGet lists R2 directly now, not just reference_images, so
// an "unassigned" crop — never attached, or detached via DELETE — still
// shows up in the catalog). ---
function fakeEnv(bookId, { analysis, playback, cropKeys = [] }) {
  const store = new Map();
  if (analysis) store.set(`books/${bookId}.analysis.json`, JSON.stringify(analysis));
  if (playback) store.set(`books/${bookId}.json`, JSON.stringify(playback));
  return {
    VAE_PACKS: {
      get: async (key) => (store.has(key) ? { json: async () => JSON.parse(store.get(key)) } : null),
      put: async (key, val) => { store.set(key, val); },
      list: async ({ prefix }) => ({
        objects: cropKeys.filter((k) => k.startsWith(prefix)).map((key, i) => ({ key, uploaded: i })),
      }),
    },
    _store: store,
  };
}

// DELETE /books/:id/characters/:charId/reference-image
{
  const bookId = "b1";
  const analysis = { characters: [{ id: "anne", name: "Anne", reference_images: ["/media/b1/character-refs/anne/1.png", "/media/b1/character-refs/anne/2.png"] }] };
  const playback = { characters: { anne: { name: "Anne", reference_images: [...analysis.characters[0].reference_images] } } };
  const env = fakeEnv(bookId, { analysis, playback });

  const res = await onCharacterReferenceImageDelete({
    request: { json: async () => ({ url: "/media/b1/character-refs/anne/1.png" }) },
    env, bookId, charId: "anne",
  });
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.characters.anne.reference_images, ["/media/b1/character-refs/anne/2.png"]);

  const savedAnalysis = JSON.parse(env._store.get(`books/${bookId}.analysis.json`));
  assert.deepEqual(savedAnalysis.characters[0].reference_images, ["/media/b1/character-refs/anne/2.png"],
    "analysis is persisted too, not just playback");
}

// POST /books/:id/characters/:charId/reference-image/assign — reassign a
// crop currently sitting on the WRONG character to the right one.
{
  const bookId = "b2";
  const wrongUrl = "/media/b2/character-refs/kuro/9.png"; // actually a crop of Elara, mismatched by auto-match
  const analysis = {
    characters: [
      { id: "kuro", name: "Kuro", reference_images: [wrongUrl] },
      { id: "elara", name: "Elara", reference_images: [] },
    ],
  };
  const playback = {
    characters: {
      kuro: { name: "Kuro", reference_images: [wrongUrl] },
      elara: { name: "Elara", reference_images: [] },
    },
  };
  const env = fakeEnv(bookId, { analysis, playback });

  const res = await onCharacterReferenceImageAssignPost({
    request: { json: async () => ({ url: wrongUrl }) },
    env, bookId, charId: "elara",
  });
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.characters.elara.reference_images, [wrongUrl],
    "the crop is now attached to elara (assign doesn't remove it from kuro — caller can also DELETE from kuro)");

  // Rejects a URL that isn't this book's own media (SSRF-avoidance guard).
  const bad = await onCharacterReferenceImageAssignPost({
    request: { json: async () => ({ url: "https://evil.example/x.png" }) },
    env, bookId, charId: "elara",
  });
  assert.equal(bad.status, 400);

  // Rejects an unknown character.
  const badChar = await onCharacterReferenceImageAssignPost({
    request: { json: async () => ({ url: wrongUrl }) },
    env, bookId, charId: "ghost",
  });
  assert.equal(badChar.status, 404);
}

// GET /books/:id/character-crops — the FULL catalog (R2-listed), mapped and
// unmapped alike. A crop that exists in storage but isn't in anyone's
// reference_images (never attached, or detached via DELETE) must still show
// up, tagged as unassigned — that's the whole point of this endpoint now.
{
  const bookId = "b3";
  const analysis = {
    characters: [
      { id: "kuro", name: "Kuro", reference_images: ["/media/b3/character-refs/kuro/1.png"] },
      { id: "elara", name: "Elara", reference_images: ["/media/b3/character-refs/elara/1.png"] },
    ],
  };
  const cropKeys = [
    "media/b3/character-refs/kuro/1.png",
    "media/b3/character-refs/elara/1.png",
    "media/b3/character-refs/elara/2-orphaned.png", // detached from elara, still in R2
  ];
  const env = fakeEnv(bookId, { analysis, playback: null, cropKeys });
  const res = await onCharacterCropsGet({ env, bookId });
  const body = await res.json();
  assert.equal(body.crops.length, 3, "unassigned crop is included, not just what's in reference_images");
  const kuroCrop = body.crops.find((c) => c.url === "/media/b3/character-refs/kuro/1.png");
  assert.equal(kuroCrop.owner_id, "kuro");
  assert.equal(kuroCrop.owner_name, "Kuro");
  const orphan = body.crops.find((c) => c.url === "/media/b3/character-refs/elara/2-orphaned.png");
  assert.equal(orphan.owner_id, null, "detached/never-attached crop has no owner");
  assert.equal(orphan.owner_name, null);
  assert.equal(orphan.stored_under, "elara", "still knows which folder it was originally cropped into");
}

console.log("character-reference-images.test.mjs: ok");
