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

console.log("compile-playback-inserts.test.mjs: ok");
