/**
 * KV operation budget guards — catch runaway read/write loops in hot paths.
 * Run: npm run test:kv-budget
 */
import assert from "node:assert";
import { putBookIndex } from "../worker/_shared/jobs-kv.js";
import { IDLE_KV_FALLBACK_MS } from "../worker/_shared/job-sse-stream.js";
import {
  REPORT_MIN_MS,
  shouldForceKvReport,
  createKvReporter,
} from "../worker/_shared/job-kv-throttle.js";

function mockKv(initial = {}) {
  const store = { ...initial };
  let gets = 0;
  let puts = 0;
  const env = {
    VAE_JOBS: {
      get: async (k) => { gets += 1; return store[k] ?? null; },
      put: async (k, v) => { puts += 1; store[k] = v; },
    },
    __stats: () => ({ gets, puts }),
    __store: store,
  };
  return env;
}

async function run() {
  {
    const env = mockKv({
      "book:b1": JSON.stringify({ book_id: "b1", title: "One", progress: 0.5 }),
      "catalog:ids": JSON.stringify(["b1"]),
    });
    await putBookIndex(env, "b1", { progress: 0.6 });
    const { gets, puts } = env.__stats();
    assert.equal(gets, 1, "existing book update = one read");
    assert.equal(puts, 1, "existing book update = one write");
  }

  {
    const env = mockKv({ "catalog:ids": JSON.stringify([]) });
    await putBookIndex(env, "new-book", { title: "New", progress: 0 });
    const { gets, puts } = env.__stats();
    assert.equal(gets, 2, "new book: read book + read catalog");
    assert.equal(puts, 2, "new book: write book + write catalog");
  }

  {
    const env = mockKv({
      "book:b1": JSON.stringify({ book_id: "b1", title: "One" }),
      "catalog:ids": JSON.stringify(["b1"]),
    });
    const prev = { book_id: "b1", title: "One", progress: 0.5 };
    await putBookIndex(env, "b1", { progress: 0.7 }, { prev });
    const { gets, puts } = env.__stats();
    assert.equal(gets, 0, "prev hint skips book read");
    assert.equal(puts, 1, "prev hint still writes");
  }

  assert.ok(IDLE_KV_FALLBACK_MS >= 30_000, "KV fallback only after long DO silence");

  assert.equal(REPORT_MIN_MS, 800);

  assert.equal(shouldForceKvReport({ progress: 0.5, stage: "imaging" }, "imaging"), false);
  assert.equal(
    shouldForceKvReport({ progress: 0.5, detail: "Trying pollinations for cover" }, "imaging"),
    true,
  );
  assert.equal(shouldForceKvReport({ progress: 0.5, stage: "extracting" }, "imaging"), true);

  {
    let writes = 0;
    const reporter = createKvReporter({ minMs: 800 });
    const patch = { progress: 0.4, stage: "imaging", detail: "step 1" };
    assert.equal(await reporter.maybeReport(patch, async () => { writes += 1; }), true);
    assert.equal(await reporter.maybeReport(patch, async () => { writes += 1; }), false);
    assert.equal(writes, 1, "second report within 800ms is skipped");
    await reporter.maybeReport(
      { progress: 0.5, stage: "imaging", detail: "Trying gemini for cover" },
      async () => { writes += 1; },
    );
    assert.equal(writes, 2, "provider attempt forces write");
  }

  // Simulate regen progress burst: 20 steps should yield ~3 writes (start + ~2 throttled)
  {
    let jobWrites = 0;
    let bookWrites = 0;
    const reporter = createKvReporter({ minMs: 800 });
    for (let i = 1; i <= 20; i += 1) {
      const patch = {
        progress: i / 20,
        stage: "imaging",
        detail: `character · id (${i}/20)`,
      };
      await reporter.maybeReport(patch, async () => {
        jobWrites += 1;
        bookWrites += 1;
      });
    }
    assert.ok(jobWrites <= 4, `20 regen steps should throttle to few writes, got ${jobWrites}`);
    assert.equal(jobWrites, bookWrites);
  }
}

await run();
console.log("kv-budget.test.mjs — all passed");
