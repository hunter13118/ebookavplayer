/**
 * POST /books/:id/imaging/unlock — job_id scoping.
 *
 * Root cause of a real, confirmed-live bug: a client with stale job-tracking
 * state (e.g. a browser tab that outlived several regen attempts) called
 * this with force=true, with no job_id to scope against, after ITS OWN
 * long-dead job finally reported an error — force-unlocking and stale-
 * marking a completely DIFFERENT, still-legitimately-running job that
 * happened to be active on the book at that moment. ?job_id=<id> makes this
 * a no-op when it doesn't match the book's currently active job, instead of
 * blindly stomping whatever is active.
 * Run: node tests/imaging-unlock-scoped.test.mjs
 */
import assert from "node:assert";
import { onImagingUnlockPost } from "../worker/api/v1/book-actions.js";

function makeEnv(initialKv) {
  const kv = { ...initialKv };
  return {
    kv,
    env: {
      VAE_JOBS: {
        get: async (k) => kv[k] ?? null,
        put: async (k, v) => { kv[k] = v; },
      },
      VAE_PACKS: {
        get: async (k) => (kv[k] !== undefined ? { json: async () => JSON.parse(kv[k]) } : null),
      },
    },
  };
}

function requestWithQuery(query) {
  return { url: `https://x/books/vol6/imaging/unlock${query}` };
}

async function bodyOf(res) {
  return res.json();
}

// job_id matches the book's active job -> proceeds normally (stale-marks it, clears lock).
{
  const { env, kv } = makeEnv({
    "books/vol6.json": "{}",
    "book:vol6": JSON.stringify({
      book_id: "vol6", imaging_locked: true, active_job_id: "job1", status: "processing",
    }),
    "ingest:job1": JSON.stringify({ job_id: "job1", status: "imaging", detail: "Trying local_sd for character · diana" }),
  });
  const res = await onImagingUnlockPost({
    env, bookId: "vol6", request: requestWithQuery("?force=true&job_id=job1"),
  });
  assert.equal(res.status, 200);
  const body = await bodyOf(res);
  assert.equal(body.ok, true);
  assert.equal(body.imaging_locked, false);

  const job = JSON.parse(kv["ingest:job1"]);
  assert.equal(job.status, "error");
  assert.match(job.detail, /Manually unlocked/);

  const book = JSON.parse(kv["book:vol6"]);
  assert.equal(book.imaging_locked, false);
  assert.equal(book.active_job_id, null);
}

// job_id does NOT match the book's active job -> no-op, the active job is
// left completely untouched (this is the bug fix).
{
  const { env, kv } = makeEnv({
    "books/vol6.json": "{}",
    "book:vol6": JSON.stringify({
      book_id: "vol6", imaging_locked: true, active_job_id: "job2-new", status: "processing",
    }),
    "ingest:job2-new": JSON.stringify({
      job_id: "job2-new", status: "imaging", detail: "Trying local_sd for character · anne",
    }),
  });
  const res = await onImagingUnlockPost({
    // A stale client thinks "job1-old" (long dead) is what it's tracking.
    env, bookId: "vol6", request: requestWithQuery("?force=true&job_id=job1-old"),
  });
  assert.equal(res.status, 200);
  const body = await bodyOf(res);
  assert.equal(body.ok, true);
  assert.ok(body.skipped, "response should indicate the unlock was skipped");

  // The ACTIVE job must be completely untouched — not stale-marked, still imaging.
  const job = JSON.parse(kv["ingest:job2-new"]);
  assert.equal(job.status, "imaging");
  assert.equal(job.detail, "Trying local_sd for character · anne");

  // The book's lock must be completely untouched too.
  const book = JSON.parse(kv["book:vol6"]);
  assert.equal(book.imaging_locked, true);
  assert.equal(book.active_job_id, "job2-new");
}

// No job_id at all -> unscoped behavior preserved (clears whatever's active).
{
  const { env, kv } = makeEnv({
    "books/vol6.json": "{}",
    "book:vol6": JSON.stringify({
      book_id: "vol6", imaging_locked: true, active_job_id: "job3", status: "processing",
    }),
    "ingest:job3": JSON.stringify({ job_id: "job3", status: "imaging" }),
  });
  const res = await onImagingUnlockPost({
    env, bookId: "vol6", request: requestWithQuery("?force=true"),
  });
  assert.equal(res.status, 200);
  const book = JSON.parse(kv["book:vol6"]);
  assert.equal(book.imaging_locked, false);
  assert.equal(book.active_job_id, null);
  const job = JSON.parse(kv["ingest:job3"]);
  assert.equal(job.status, "error");
}

console.log("imaging-unlock-scoped.test.mjs — all passed");
