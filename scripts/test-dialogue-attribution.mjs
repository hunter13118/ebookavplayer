import { repairSceneLines } from "../worker/_shared/dialogue-repair.js";
import { attributeSceneLines } from "../worker/_shared/dialogue-attribute.js";
import { sceneNeedsAmbiguousLLM } from "../worker/_shared/dialogue-attribute-llm.js";

const chars = [
  { id: "mei_asano", name: "Mei Asano", gender: "female" },
  { id: "kuro", name: "Kuro", gender: "male" },
];

function scene(lines, present = ["mei_asano", "kuro"]) {
  return { id: "s1", present_character_ids: present, lines: lines.map((l) => ({ ...l })) };
}

// Tag back-link: pronoun tag attributes preceding dialogue
{
  const s = scene([
    { character_id: "narrator", kind: "dialogue", text: "Took you long enough," },
    { character_id: "narrator", kind: "narration", text: "he said quietly." },
  ]);
  const repaired = repairSceneLines(s.lines);
  attributeSceneLines({ ...s, lines: repaired }, chars);
  if (repaired[0].character_id !== "kuro") {
    throw new Error(`expected kuro, got ${repaired[0].character_id}`);
  }
}

// Chained quotes: alternate speakers
{
  const s = scene([
    { character_id: "mei_asano", kind: "dialogue", text: "Why?" },
    { character_id: "mei_asano", kind: "dialogue", text: "Because." },
  ]);
  attributeSceneLines(s, chars);
  if (s.lines[1].character_id === s.lines[0].character_id) {
    throw new Error("chained quotes should alternate speakers");
  }
  if (sceneNeedsAmbiguousLLM(s)) {
    throw new Error("2-line alternation should not need LLM after deterministic pass");
  }
}

// Ambiguous: 3+ consecutive dialogue
{
  const s = scene([
    { character_id: "mei_asano", kind: "dialogue", text: "One." },
    { character_id: "kuro", kind: "dialogue", text: "Two." },
    { character_id: "mei_asano", kind: "dialogue", text: "Three." },
  ]);
  if (!sceneNeedsAmbiguousLLM(s)) {
    throw new Error("3-line dialogue chain should be ambiguous");
  }
}

// Ambiguous: all dialogue on one speaker (before deterministic fix)
{
  const s = scene([
    { character_id: "mei_asano", kind: "dialogue", text: "Hi." },
    { character_id: "mei_asano", kind: "dialogue", text: "Still me." },
  ]);
  if (!sceneNeedsAmbiguousLLM(s)) {
    throw new Error("mono-speaker dialogue with 2 present should be ambiguous");
  }
}

// Named tag
{
  const s = scene([
    { character_id: "narrator", kind: "dialogue", text: "Hello," },
    { character_id: "narrator", kind: "narration", text: "said Mei Asano." },
  ]);
  const repaired = repairSceneLines(s.lines);
  attributeSceneLines({ ...s, lines: repaired }, chars);
  if (repaired[0].character_id !== "mei_asano") {
    throw new Error(`named tag expected mei_asano, got ${repaired[0].character_id}`);
  }
}

console.log("dialogue attribution tests ok");
