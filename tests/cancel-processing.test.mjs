/**
 * POST /books/:id/cancel-processing — stop treating a stuck/in-flight job as
 * active. Can't interrupt a running queue consumer invocation (no cancel
 * primitive), so this only covers what it actually does: mark the job
 * record terminal, and reset the book index to "partial" (resumable, if any
 * chapters finished) or "error" (nothing to resume from).
 * Run: node tests/cancel-processing.test.mjs
 */
import assert from "node:assert";
import { onCancelProcessingPost } from "../worker/api/v1/book-actions.js";

function makeEnv(initialKv) {
  const kv = { ...initialKv };
  return {
    kv,
    env: {
      VAE_JOBS: {
        get: async (k) => kv[k] ?? null,
        put: async (k, v) => { kv[k] = v; },
      },
    },
  };
}

async function bodyOf(res) {
  return res.json();
}

// No such book at all -> 404, no crash.
{
  const { env } = makeEnv({});
  const res = await onCancelProcessingPost({ env, bookId: "ghost" });
  assert.equal(res.status, 404);
  const body = await bodyOf(res);
  assert.match(body.error, /no such book/);
}

// Stuck mid-extraction with chapters already done -> resumable ("partial"),
// job marked terminal, both job-id fields cleared, stale error wiped.
{
  const { env, kv } = makeEnv({
    "book:vol6": JSON.stringify({
      book_id: "vol6",
      title: "Vol 6",
      status: "processing",
      active_job_id: "job1",
      job_id: "job1",
      chapters_ready: 3,
      total_chapters: 16,
      error: "some stale provider error",
    }),
    "ingest:job1": JSON.stringify({ job_id: "job1", status: "processing" }),
  });
  const res = await onCancelProcessingPost({ env, bookId: "vol6" });
  assert.equal(res.status, 200);
  const body = await bodyOf(res);
  assert.equal(body.status, "partial");

  const job = JSON.parse(kv["ingest:job1"]);
  assert.equal(job.status, "error");
  assert.match(job.detail, /Cancelled by user/);

  const book = JSON.parse(kv["book:vol6"]);
  assert.equal(book.status, "partial");
  assert.equal(book.active_job_id, null);
  assert.equal(book.job_id, null);
  assert.equal(book.error, "");
  assert.match(book.detail, /3\/16 chapters ready/);
  // Untouched fields survive the merge in putBookIndex.
  assert.equal(book.title, "Vol 6");
}

// Stuck before any chapter finished -> nothing to resume, lands on "error".
{
  const { env, kv } = makeEnv({
    "book:fresh": JSON.stringify({
      book_id: "fresh",
      status: "processing",
      active_job_id: "job2",
      job_id: "job2",
      chapters_ready: 0,
      total_chapters: 20,
    }),
    "ingest:job2": JSON.stringify({ job_id: "job2", status: "processing" }),
  });
  const res = await onCancelProcessingPost({ env, bookId: "fresh" });
  const body = await bodyOf(res);
  assert.equal(body.status, "error");

  const book = JSON.parse(kv["book:fresh"]);
  assert.equal(book.status, "error");
  assert.match(book.error, /before any chapters finished/);
}

// No active_job_id/job_id at all (edge case) -> still resets book index,
// doesn't throw trying to mark a nonexistent job stale.
{
  const { env, kv } = makeEnv({
    "book:orphaned": JSON.stringify({
      book_id: "orphaned",
      status: "processing",
      chapters_ready: 1,
      total_chapters: 5,
    }),
  });
  const res = await onCancelProcessingPost({ env, bookId: "orphaned" });
  assert.equal(res.status, 200);
  const book = JSON.parse(kv["book:orphaned"]);
  assert.equal(book.status, "partial");
}

console.log("cancel-processing.test.mjs — all passed");
