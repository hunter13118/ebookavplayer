/**
 * Mechanical (non-LLM) script builder — sentence-split verbatim text with
 * illustrations slotted at their best-matching position via textContext
 * word-overlap. Every line must compile/play as-is (all-narrator default).
 * Run: node tests/mechanical-script.test.mjs
 */
import assert from "node:assert";
import {
  bestInsertionLine, buildMechanicalChapterLines, buildMechanicalScenes, buildMechanicalCharacters,
} from "../worker/_shared/mechanical-script.js";

// bestInsertionLine: picks the sentence most textually similar to the
// image's surrounding context, ignores weak/coincidental overlap.
{
  const sentences = [
    "The morning sun rose over the badlands.",
    "Kosuke stretched, ready for another day of survival.",
    "Sylphie waved from across the camp, her sword catching the light.",
  ];
  assert.equal(bestInsertionLine(sentences, "Sylphie waved from across the camp with her sword"), 2);
  assert.equal(bestInsertionLine(sentences, "completely unrelated text about something else"), -1);
  assert.equal(bestInsertionLine(sentences, ""), -1);
}

// buildMechanicalChapterLines: verbatim sentence split, all-narrator, image
// attached at its best-matching sentence (not just tacked at the end).
{
  const chapterText = "The camp was quiet at dawn. Sylphie sharpened her blade by the fire. "
    + "Kosuke watched from a distance, saying nothing.";
  const images = [{ index: 5, textContext: "Sylphie sharpened her blade by the fire, focused and calm" }];
  const urls = { 5: "/media/book/illustrations/img_005.jpg" };
  const lines = buildMechanicalChapterLines(chapterText, images, urls);

  assert.equal(lines.length, 3);
  for (const l of lines) {
    assert.equal(l.character_id, "narrator");
    assert.equal(l.kind, "narration");
  }
  assert.equal(lines.map((l) => l.text).join(" "), chapterText.replace(/\s+/g, " ").trim());
  assert.equal(lines[1].illustration_url, "/media/book/illustrations/img_005.jpg",
    "image lands on the sentence it actually describes, not always the last one");
  assert.equal(lines[0].illustration_url, undefined);
  assert.equal(lines[2].illustration_url, undefined);
}

// No textContext match at all -> falls back to the chapter's last line
// (still shown, just not precisely placed) rather than being dropped.
{
  const chapterText = "First sentence here. Second sentence here.";
  const images = [{ index: 0, textContext: "nothing at all like the source" }];
  const urls = { 0: "/media/book/illustrations/img_000.jpg" };
  const lines = buildMechanicalChapterLines(chapterText, images, urls);
  assert.equal(lines[1].illustration_url, "/media/book/illustrations/img_000.jpg");
}

// Two images landing on the same best line -> first wins, still shown once,
// not dropped or overwritten silently in a way that loses both.
{
  const chapterText = "Only one sentence exists here.";
  const images = [
    { index: 0, textContext: "Only one sentence exists here" },
    { index: 1, textContext: "Only one sentence exists here" },
  ];
  const urls = { 0: "/media/a.jpg", 1: "/media/b.jpg" };
  const lines = buildMechanicalChapterLines(chapterText, images, urls);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].illustration_url, "/media/a.jpg");
}

// An image whose index has no resolved URL yet is skipped cleanly (no crash).
{
  const lines = buildMechanicalChapterLines("A sentence.", [{ index: 9, textContext: "x" }], {});
  assert.equal(lines.length, 1);
  assert.equal(lines[0].illustration_url, undefined);
}

// buildMechanicalScenes: one scene per chapter, idx runs continuously across
// the whole book, chapter numbers carried through.
{
  const chapters = [
    { index: 1, title: "Prologue", text: "It began quietly. Nothing more happened that day." },
    { index: 2, title: "Chapter 2", text: "Later, everything changed." },
  ];
  const byChapterPos = new Map([[0, [{ index: 0, textContext: "It began quietly" }]]]);
  const urls = { 0: "/media/cover.jpg" };
  const { scenes, lineCount } = buildMechanicalScenes(chapters, byChapterPos, urls);

  assert.equal(scenes.length, 2);
  assert.equal(scenes[0].title, "Prologue");
  assert.equal(scenes[0].chapter, 1);
  assert.equal(scenes[1].chapter, 2);
  // idx is continuous across the whole book, not reset per chapter.
  const allIdx = scenes.flatMap((s) => s.lines.map((l) => l.idx));
  assert.deepEqual(allIdx, [0, 1, 2]);
  assert.equal(lineCount, 3);
  assert.equal(scenes[0].lines[0].illustration_url, "/media/cover.jpg");
  assert.ok(scenes[0].lines[0].illustration_caption, "caption derived from the line's own text");
  assert.equal(scenes[0].lines[0].visual_moment, true);

  // Every line is already in FINAL playback shape — same fields
  // compilePlayback() would set for an all-narrator line — so this can be
  // written straight to books/{id}.json with no further compile step.
  for (const line of scenes.flatMap((s) => s.lines)) {
    assert.equal(line.character_id, "narrator");
    assert.equal(line.speaker_name, "Narrator");
    assert.equal(line.kind, "narration");
    assert.equal(line.pitch, "+0Hz");
    assert.equal(line.rate, "+0%");
    assert.equal(line.expression, "normal");
    assert.equal(line.environment, "indoor");
    assert.equal(line.intensity, 0.5);
    assert.ok(line.voice, "narrator voice resolved via voice-assign.js's narratorVoice");
  }
}

// buildMechanicalCharacters: same shape compile-playback.js's compilePlayback
// builds for narrator, so an enrichment pass adding real characters later is
// a drop-in, not a schema mismatch.
{
  const chars = buildMechanicalCharacters("female");
  assert.equal(chars.narrator.name, "Narrator");
  assert.equal(chars.narrator.gender, "female");
  assert.equal(chars.narrator.importance, "primary");
  assert.equal(chars.narrator.sprite, "sprite:narrator");
  assert.ok(chars.narrator.voice);

  // Default gender ("male") when omitted.
  assert.equal(buildMechanicalCharacters().narrator.gender, "male");
}

console.log("mechanical-script.test.mjs: ok");
