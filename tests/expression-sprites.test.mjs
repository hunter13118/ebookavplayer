/**
 * Expression Sensitivity Plan Phase 3d — per-line alt-expression sprite_url
 * resolution. The generation side (edge-imaging.js's image-gen loop) needs a
 * live provider to test end-to-end; this covers the pure compile-time piece:
 * once `media.expressionSprites` exists, does compilePlaybackWithMedia
 * correctly wire line.sprite_url and characters[id].expressionSprites.
 * Run: node tests/expression-sprites.test.mjs
 */
import assert from "node:assert";
import { compilePlaybackWithMedia } from "../worker/_shared/edge-imaging.js";

function analysisFixture() {
  return {
    book_id: "b1",
    title: "T",
    author: "A",
    characters: [
      { id: "kuro", name: "Kuro", importance: "primary", gender: "male" },
      { id: "mei", name: "Mei", importance: "secondary", gender: "female" },
    ],
    scenes: [{
      id: "scene-0001",
      chapter: 1,
      present_character_ids: ["kuro", "mei"],
      lines: [
        { character_id: "kuro", text: "Get out!", kind: "dialogue", expression: "yell" },
        { character_id: "kuro", text: "...sorry.", kind: "dialogue", expression: "sad" },
        { character_id: "mei", text: "It's fine.", kind: "dialogue", expression: "normal" },
      ],
    }],
  };
}

const media = {
  characters: { kuro: "https://x/char_kuro.png" },
  backgrounds: {},
  cover: null,
  inserts: {},
  expressionSprites: { kuro: { yell: "https://x/char_kuro_expr_yell.png", happy: "https://x/char_kuro_expr_happy.png" } },
};

// sprite_url set only where a matching bucket variant exists for that speaker.
{
  const out = compilePlaybackWithMedia(analysisFixture(), { media });
  const lines = out.scenes[0].lines;
  assert.equal(lines[0].sprite_url, "https://x/char_kuro_expr_yell.png", "yell bucket has a variant -> set");
  assert.equal(lines[1].sprite_url, undefined, "sad bucket has no variant -> untouched");
  assert.equal(lines[2].sprite_url, undefined, "mei has no expressionSprites entry at all -> untouched");
}

// characters[id].expressionSprites carries through onto the compiled character record.
{
  const out = compilePlaybackWithMedia(analysisFixture(), { media });
  assert.deepEqual(out.characters.kuro.expressionSprites, media.expressionSprites.kuro);
  assert.equal(out.characters.mei.expressionSprites, undefined);
}

// Freeform expression values normalize onto the canonical bucket before lookup.
{
  const analysis = analysisFixture();
  analysis.scenes[0].lines[0].expression = "screaming"; // alias -> yell
  const out = compilePlaybackWithMedia(analysis, { media });
  assert.equal(out.scenes[0].lines[0].sprite_url, "https://x/char_kuro_expr_yell.png");
}

// No media.expressionSprites at all -> no-op, doesn't throw.
{
  const out = compilePlaybackWithMedia(analysisFixture(), {
    media: { characters: {}, backgrounds: {}, cover: null, inserts: {} },
  });
  assert.equal(out.scenes[0].lines[0].sprite_url, undefined);
}

console.log("expression-sprites: all assertions passed");
