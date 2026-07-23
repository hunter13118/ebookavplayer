/**
 * compile-playback merges media.inserts into line illustration_url.
 * Run: node tests/compile-playback-inserts.test.mjs
 */
import assert from "node:assert";
import { compilePlayback, enrichPlaybackFromAnalysis, harvestInsertMap, applyInsertsToLines } from "../worker/_shared/compile-playback.js";

const analysis = {
  book_id: "demo",
  title: "Demo",
  characters: [{ id: "hero", name: "Hero", importance: "primary" }],
  scenes: [{
    id: "s1",
    title: "Gate",
    present_character_ids: ["hero"],
    lines: [
      { character_id: "hero", text: "I will fight!", kind: "dialogue", visual_moment: true },
      { character_id: "narrator", text: "Silence fell.", kind: "narration" },
    ],
  }],
};

{
  const pb = compilePlayback(analysis, {
    media: {
      inserts: {
        0: "/media/demo/anime/insert_0.png?v=1",
      },
    },
  });
  assert.equal(pb.inserts["0"], "/media/demo/anime/insert_0.png?v=1");
  assert.equal(pb.scenes[0].lines[0].illustration_url, "/media/demo/anime/insert_0.png?v=1");
  assert.equal(pb.scenes[0].lines[0].visual_moment, true);
  assert.ok(pb.scenes[0].lines[0].illustration_caption);
  assert.equal(pb.scenes[0].lines[1].illustration_url, undefined);
}

{
  const old = {
    art_style: "anime",
    inserts: { 1: "/media/demo/anime/insert_1.png?v=2" },
    scenes: [{
      id: "s1",
      lines: [{ idx: 1, illustration_url: "/media/demo/anime/insert_1.png?v=2", visual_moment: true }],
    }],
  };
  const pb = enrichPlaybackFromAnalysis(old, analysis);
  assert.equal(pb.inserts["1"], "/media/demo/anime/insert_1.png?v=2");
  const line1 = pb.scenes[0].lines.find((l) => l.idx === 1);
  assert.equal(line1?.illustration_url, "/media/demo/anime/insert_1.png?v=2");
}

{
  const pb = {
    scenes: [{ id: "s1", lines: [{ idx: 27, text: "Beat" }] }],
    inserts: { 27: "/media/demo/anime/insert_27.png?v=1" },
  };
  applyInsertsToLines(pb);
  assert.equal(pb.scenes[0].lines[0].illustration_url, "/media/demo/anime/insert_27.png?v=1");
}

// Regression: a raw EPUB plate URL that got stuck in an old stored book's
// character/scene sprite (from before applyDirectIllustrations stopped
// writing them there — see illustrations.js) must self-heal on the next
// recompile rather than being preserved forever by the "any existing
// /media/ sprite wins" reuse rule, which can't otherwise distinguish a real
// generated portrait from a raw plate.
{
  const analysisWithPlates = {
    ...analysis,
    illustration_urls: { 0: "/media/demo/illustrations/img_000.jpg" },
  };
  const oldWithBadSprite = {
    art_style: "anime",
    characters: { hero: { sprite: "/media/demo/illustrations/img_000.jpg" } },
    scenes: [{
      id: "s1",
      present: [{ character_id: "hero", sprite: "/media/demo/illustrations/img_000.jpg" }],
    }],
  };
  const healed = enrichPlaybackFromAnalysis(oldWithBadSprite, analysisWithPlates);
  assert.notEqual(healed.characters.hero.sprite, "/media/demo/illustrations/img_000.jpg",
    "raw plate sprite is not preserved across a recompile");
  assert.ok(healed.characters.hero.sprite.startsWith("sprite:gradient:"),
    "falls back to the placeholder gradient instead");
  assert.notEqual(healed.scenes[0].present[0].sprite, "/media/demo/illustrations/img_000.jpg");

  // A genuine generated portrait (not in illustration_urls) is still preserved.
  const oldWithRealSprite = {
    art_style: "anime",
    characters: { hero: { sprite: "/media/demo/anime/char_hero.png?v=1" } },
    scenes: [{ id: "s1", present: [{ character_id: "hero", sprite: "/media/demo/anime/char_hero.png?v=1" }] }],
  };
  const preserved = enrichPlaybackFromAnalysis(oldWithRealSprite, analysisWithPlates);
  assert.equal(preserved.characters.hero.sprite, "/media/demo/anime/char_hero.png?v=1");
}

// text_source: carried through from analysis so the client can tell a real
// EPUB book apart from an m4b-first book still running on its ASR transcript
// (docs/M4B_FIRST_FLOW.md) — see book-extract-pipeline.js/
// ingest-text-consumer.js for where each value gets set.
{
  const pb = compilePlayback({ ...analysis, text_source: "m4b_transcript" });
  assert.equal(pb.text_source, "m4b_transcript");
}
{
  // Missing entirely (every book compiled before this field existed) falls
  // back to "epub" — true for all of them, since m4b-first is the only
  // other source and didn't exist yet either.
  const pb = compilePlayback(analysis);
  assert.equal(pb.text_source, "epub");
}
{
  // enrichPlaybackFromAnalysis (the GET /books/:id recompile path) rebuilds
  // FROM analysis, so a stale stored playback's own text_source can't stick
  // around after the underlying analysis says otherwise.
  const old = { art_style: "anime", text_source: "epub", scenes: [{ id: "s1", lines: [] }] };
  const pb = enrichPlaybackFromAnalysis(old, { ...analysis, text_source: "m4b_transcript" });
  assert.equal(pb.text_source, "m4b_transcript");
}

// front_matter/back_matter (cover/gallery art before the book starts,
// trailing junk art after it ends): compilePlayback() itself has no idea
// about them — they're baked in once by applyDirectIllustrations, not
// re-derived from analysis on every recompile (same as `cover`) — so
// enrichPlaybackFromAnalysis must carry them forward from the OLD playback
// or a plain GET-triggered recompile would silently drop them.
{
  const old = {
    art_style: "anime",
    front_matter: [{ url: "/media/demo/illustrations/img_010.jpg" }],
    back_matter: [{ url: "/media/demo/illustrations/img_020.jpg" }],
    scenes: [{ id: "s1", lines: [] }],
  };
  const pb = enrichPlaybackFromAnalysis(old, analysis);
  assert.deepEqual(pb.front_matter, [{ url: "/media/demo/illustrations/img_010.jpg" }]);
  assert.deepEqual(pb.back_matter, [{ url: "/media/demo/illustrations/img_020.jpg" }]);
}

console.log("compile-playback-inserts.test.mjs: ok");
