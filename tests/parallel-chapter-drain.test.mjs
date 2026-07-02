/**
 * Integration test for freemiumExtractBookByChapter's `concurrency` option:
 * chapters extract concurrently but still drain (onChapterComplete) strictly
 * in chapter order, and a placeholder character in an earlier chapter gets
 * reconciled against the real name established by a later chapter that
 * finished concurrently and is sitting in the look-ahead buffer — the exact
 * "unnamed male protagonist" vs "Eizo" bug this exists to fix.
 * Mocks fetch (gemini provider) so no network/API keys are needed.
 * Run: npm run test:parallel-chapter-drain
 */
import assert from "node:assert";
import { freemiumExtractBookByChapter } from "../worker/_shared/freemium-extract.js";

function sceneFor(chapterN, characterId) {
  return {
    id: "scene-0001",
    chapter: chapterN,
    present_character_ids: [characterId],
    lines: [{ character_id: characterId, text: `Line in chapter ${chapterN}.`, kind: "dialogue" }],
  };
}

const CHAPTER_RESPONSES = {
  1: {
    characters: [{
      id: "unnamed-male-protagonist", name: "Unnamed male protagonist",
      gender: "male", importance: "primary", description: "a stoic swordsman with a scarred face",
    }],
    scenes: [sceneFor(1, "unnamed-male-protagonist")],
  },
  2: {
    characters: [{
      id: "eizo", name: "Eizo", gender: "male", importance: "primary",
      description: "a stoic swordsman with a scarred face",
    }],
    scenes: [sceneFor(2, "eizo")],
  },
  3: {
    characters: [{ id: "mira", name: "Mira", gender: "female", importance: "secondary", description: "a cheerful merchant" }],
    scenes: [sceneFor(3, "mira")],
  },
  4: {
    characters: [{ id: "tomas", name: "Tomas", gender: "male", importance: "background", description: "a grumpy dockworker" }],
    scenes: [sceneFor(4, "tomas")],
  },
};
// Chapter 2 (position 1) finishes faster than chapter 1 (position 0), so by
// the time position 0 drains, position 1's real "eizo" is already sitting in
// the look-ahead buffer — this is what the reconciliation pass must use.
const CHAPTER_DELAYS_MS = { 1: 50, 2: 8, 3: 5, 4: 5 };

const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  const userText = body.messages[1].content;
  const m = /## Chapter (\d+):/.exec(userText);
  const chNum = m ? parseInt(m[1], 10) : null;
  await new Promise((resolve) => setTimeout(resolve, CHAPTER_DELAYS_MS[chNum] ?? 5));
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(CHAPTER_RESPONSES[chNum]) } }] }),
  };
};

try {
  const chapters = [1, 2, 3, 4].map((n) => ({
    index: n, title: `Chapter ${n}`, text: `Some short body text for chapter ${n}.`,
  }));
  const env = { GEMINI_API_KEY: "fake-key-for-test", EXTRACT_SKIP_GEMINI: "false" };

  let knownAccum = [];
  const drainOrder = [];
  const completed = [];

  const result = await freemiumExtractBookByChapter(
    { book_id: "b1", title: "T", author: "A", chapters },
    {
      env,
      preferProvider: "gemini",
      concurrency: 2,
      getKnownCharacters: () => knownAccum,
      onChapterComplete: async (chapterPos, chapterAnalysis) => {
        drainOrder.push(chapterPos);
        completed.push(chapterAnalysis);
        knownAccum = [...knownAccum, ...(chapterAnalysis.characters || [])];
      },
    },
  );

  assert.deepEqual(drainOrder, [0, 1, 2, 3], "chapters drain strictly in position order despite concurrent extraction");
  assert.equal(result.totalChapters, 4);

  assert.equal(
    completed[0].characters[0].id, "eizo",
    "chapter 0's placeholder is reconciled to the real name found in the concurrently-finished chapter 1 (look-ahead)",
  );
  assert.equal(completed[0].scenes[0].present_character_ids[0], "eizo");
  assert.equal(completed[0].scenes[0].lines[0].character_id, "eizo");

  assert.equal(completed[1].characters[0].id, "eizo", "chapter 1's own real character is untouched");
  assert.equal(completed[2].characters[0].id, "mira", "unrelated characters are untouched");
  assert.equal(completed[3].characters[0].id, "tomas", "unrelated characters are untouched");

  console.log("parallel-chapter-drain: ok");
} finally {
  globalThis.fetch = originalFetch;
}
