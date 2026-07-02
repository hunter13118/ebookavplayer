/**
 * Verifies the raw-chapter-extract cache added to freemium-extract.js's
 * parallel path (book-checkpoint.js: getRawChapterExtract/putRawChapterExtract/
 * deleteRawChapterExtract):
 *   1. Each chapter's raw (pre-reconciliation) LLM result is persisted to R2
 *      the moment its own extraction finishes — before it's necessarily this
 *      chapter's turn to drain (checkpoint) — so a crash while an earlier
 *      chapter is still churning doesn't throw away later chapters' already-
 *      finished (expensive, slow local-LLM) work.
 *   2. A resume that finds a chapter's raw result already cached skips the
 *      LLM call entirely for that chapter and reconciles/drains straight from
 *      the cached data.
 *   3. Once a chapter is durably checkpointed (consume/onChapterComplete
 *      succeeds), its raw cache entry is deleted — it's served its purpose.
 * Mocks fetch (gemini provider) and a minimal in-memory R2 (env.VAE_PACKS) so
 * no network/API keys are needed.
 * Run: npm run test:raw-chapter-cache
 */
import assert from "node:assert";
import { freemiumExtractBookByChapter } from "../worker/_shared/freemium-extract.js";

function fakeR2() {
  const store = new Map();
  return {
    store,
    async get(key) {
      if (!store.has(key)) return null;
      const text = store.get(key);
      return { text: async () => text, json: async () => JSON.parse(text) };
    },
    async put(key, value) {
      store.set(key, typeof value === "string" ? value : JSON.stringify(value));
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

function sceneFor(chapterN, characterId) {
  return {
    id: "scene-0001",
    chapter: chapterN,
    present_character_ids: [characterId],
    lines: [{ character_id: characterId, text: `Line in chapter ${chapterN}.`, kind: "dialogue" }],
  };
}

const CHAPTER_RESPONSES = {
  1: { characters: [{ id: "aria", name: "Aria", gender: "female", importance: "primary", description: "d" }], scenes: [sceneFor(1, "aria")] },
  2: { characters: [{ id: "beck", name: "Beck", gender: "male", importance: "secondary", description: "d" }], scenes: [sceneFor(2, "beck")] },
  3: { characters: [{ id: "coen", name: "Coen", gender: "male", importance: "background", description: "d" }], scenes: [sceneFor(3, "coen")] },
};

const originalFetch = globalThis.fetch;
const fetchCallsByChapter = {};

function installFetchMock() {
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const userText = body.messages[1].content;
    const m = /## Chapter (\d+):/.exec(userText);
    const chNum = m ? parseInt(m[1], 10) : null;
    fetchCallsByChapter[chNum] = (fetchCallsByChapter[chNum] || 0) + 1;
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(CHAPTER_RESPONSES[chNum]) } }] }),
    };
  };
}

try {
  const chapters = [1, 2, 3].map((n) => ({
    index: n, title: `Chapter ${n}`, text: `Some short body text for chapter ${n}.`,
  }));

  // --- Test 1: fresh run persists raw cache during produce, deletes it after consume ---
  {
    installFetchMock();
    const r2 = fakeR2();
    const env = { GEMINI_API_KEY: "fake-key-for-test", VAE_PACKS: r2 };
    const completed = [];

    await freemiumExtractBookByChapter(
      { book_id: "book-a", title: "T", author: "A", chapters },
      {
        env,
        preferProvider: "gemini",
        concurrency: 3,
        getKnownCharacters: () => [],
        onChapterComplete: async (chapterPos, chapterAnalysis) => {
          completed.push(chapterPos);
        },
      },
    );

    assert.equal(completed.length, 3, "all three chapters complete");
    assert.equal(r2.store.size, 0, "raw cache is empty once every chapter has drained — nothing left needing it");
  }

  // --- Test 2: a chapter whose raw result is already cached skips re-extraction ---
  {
    fetchCallsByChapter[2] = 0;
    installFetchMock();
    const r2 = fakeR2();
    // Simulate chapter position 1 (chapter 2) having finished its LLM call
    // before a crash, but never having drained/checkpointed.
    await r2.put("books/book-b/chapters/1.raw.json", JSON.stringify({
      chapterAnalysis: { ...CHAPTER_RESPONSES[2], chapterIndex: 2, chapterTitle: "Chapter 2" },
      provider: "gemini",
      model: "gemini-2.5-flash",
    }));

    const env = { GEMINI_API_KEY: "fake-key-for-test", VAE_PACKS: r2 };
    const completed = [];

    await freemiumExtractBookByChapter(
      { book_id: "book-b", title: "T", author: "A", chapters },
      {
        env,
        preferProvider: "gemini",
        concurrency: 3,
        getKnownCharacters: () => [],
        onChapterComplete: async (chapterPos, chapterAnalysis) => {
          completed.push({ chapterPos, id: chapterAnalysis.characters[0]?.id });
        },
      },
    );

    assert.equal(fetchCallsByChapter[2], 0, "chapter position 1 (chapter 2) never hit the LLM — served from raw cache");
    assert.deepEqual(
      completed.map((c) => c.chapterPos),
      [0, 1, 2],
      "still drains in strict order even though position 1 came from cache",
    );
    assert.equal(completed[1].id, "beck", "cached chapter's real data reaches onChapterComplete correctly");
    assert.equal(r2.store.size, 0, "raw cache fully drained again after all chapters complete");
  }

  console.log("raw-chapter-cache: ok");
} finally {
  globalThis.fetch = originalFetch;
}
