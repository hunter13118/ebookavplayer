/**
 * Parallel per-chapter imaging (VAE_PARALLEL_IMAGING) — the pure merge step
 * and the existing-media aggregator, both testable without invoking
 * runEdgeImaging (real image-provider network calls). Plus the consumer's
 * guard clauses, which return before ever reaching runEdgeImaging.
 * Run: node tests/chapter-imaging.test.mjs
 */
import assert from "node:assert";
import { mergeMediaIntoPack, handleChapterImagingMessage } from "../worker/queue/chapter-imaging-consumer.js";
import { existingMediaFromChapterPacks } from "../worker/_shared/edge-imaging.js";

function makeR2(store) {
  return {
    get: async (k) => (store[k] !== undefined
      ? { text: async () => store[k] }
      : null),
    put: async (k, v) => { store[k] = typeof v === "string" ? v : JSON.stringify(v); },
  };
}

// mergeMediaIntoPack — character sprite, expressionSprites, and scene
// background all merge in; unrelated fields untouched; no-op reports unchanged.
{
  const pack = {
    characters: { kuro: { name: "Kuro" }, mei: { name: "Mei" } },
    scenes: [{ id: "scene-0001", title: "Forest" }, { id: "scene-0002", title: "Town" }],
  };
  const media = {
    characters: { kuro: "https://x/kuro.png" },
    expressionSprites: { kuro: { yell: "https://x/kuro_yell.png" } },
    backgrounds: { "scene-0001": "https://x/forest.png" },
  };
  const { pack: merged, changed } = mergeMediaIntoPack(pack, media);
  assert.equal(changed, true);
  assert.equal(merged.characters.kuro.sprite, "https://x/kuro.png");
  assert.equal(merged.characters.kuro.name, "Kuro", "unrelated fields preserved");
  assert.deepEqual(merged.characters.kuro.expressionSprites, { yell: "https://x/kuro_yell.png" });
  assert.equal(merged.characters.mei.sprite, undefined, "untouched character stays untouched");
  assert.equal(merged.scenes[0].background, "https://x/forest.png");
  assert.equal(merged.scenes[1].background, undefined);
}

// No matching ids at all -> changed: false, nothing mutated.
{
  const pack = { characters: { mei: { name: "Mei" } }, scenes: [{ id: "scene-0001" }] };
  const { changed } = mergeMediaIntoPack(pack, { characters: { ghost: "https://x/ghost.png" }, backgrounds: {} });
  assert.equal(changed, false);
  assert.equal(pack.characters.mei.sprite, undefined);
}

// Same URL already set -> not reported as changed (avoids a pointless write).
{
  const pack = { characters: { kuro: { sprite: "https://x/kuro.png" } }, scenes: [] };
  const { changed } = mergeMediaIntoPack(pack, { characters: { kuro: "https://x/kuro.png" } });
  assert.equal(changed, false);
}

// existingMediaFromChapterPacks — aggregates sprite/background/expressionSprites
// across multiple chapter packs, later chapters' entries adding to (not
// replacing) earlier ones' character/expression maps.
{
  const store = {};
  const env = { VAE_PACKS: makeR2(store) };
  store["books/b1/chapters/0.json"] = JSON.stringify({
    characters: { kuro: { sprite: "https://x/kuro.png", expressionSprites: { yell: "https://x/y.png" } } },
    scenes: [{ id: "scene-0001", background: "https://x/bg1.png" }],
  });
  store["books/b1/chapters/1.json"] = JSON.stringify({
    characters: { kuro: { expressionSprites: { happy: "https://x/h.png" } }, mei: { sprite: "https://x/mei.png" } },
    scenes: [{ id: "scene-0002", background: "https://x/bg2.png" }],
  });

  const media = await existingMediaFromChapterPacks(env, "b1", [0, 1]);
  assert.equal(media.characters.kuro, "https://x/kuro.png");
  assert.equal(media.characters.mei, "https://x/mei.png");
  assert.deepEqual(media.expressionSprites.kuro, { yell: "https://x/y.png", happy: "https://x/h.png" });
  assert.equal(media.backgrounds["scene-0001"], "https://x/bg1.png");
  assert.equal(media.backgrounds["scene-0002"], "https://x/bg2.png");
}

// existingMediaFromChapterPacks — a missing/never-written chapter pack is
// skipped, not an error.
{
  const env = { VAE_PACKS: makeR2({}) };
  const media = await existingMediaFromChapterPacks(env, "ghost-book", [0, 1, 2]);
  assert.deepEqual(media.characters, {});
  assert.deepEqual(media.backgrounds, {});
}

// handleChapterImagingMessage guard clauses — all return before ever
// calling runEdgeImaging, so no network mocking needed.
{
  const env = { VAE_PACKS: makeR2({}) };
  // Missing book_id / chapterPos -> no-op, doesn't throw.
  await handleChapterImagingMessage({ body: {} }, env);
  await handleChapterImagingMessage({ body: { book_id: "b1" } }, env);
  // No new characters or scenes -> nothing to do, no-op.
  await handleChapterImagingMessage(
    { body: { book_id: "b1", chapterPos: 0, new_character_ids: [], scene_ids: [] } }, env,
  );
  // Chapter pack missing (never written, or already GC'd) -> no-op, no throw.
  await handleChapterImagingMessage(
    { body: { book_id: "b1", chapterPos: 0, new_character_ids: ["kuro"], scene_ids: [] } }, env,
  );
}

console.log("chapter-imaging.test.mjs — all passed");
