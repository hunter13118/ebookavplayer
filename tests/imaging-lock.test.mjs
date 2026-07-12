/**
 * Imaging lock reconciliation — must not false-mark ingest books done.
 * Run: npm run test:imaging-lock
 */
import assert from "node:assert";
import { jobLooksStuck, reconcileImagingLock } from "../worker/_shared/imaging-lock.js";

const NOW = 1_700_000_000_000;

// jobLooksStuck — queued ingest jobs get grace before declared stuck
{
  assert.equal(
    jobLooksStuck({ status: "queued", created_at: NOW - 30_000 }, { now: NOW }),
    false,
    "fresh queued job with created_at should not be stuck",
  );
  assert.equal(
    jobLooksStuck({ status: "queued" }, { now: NOW }),
    false,
    "queued job without ts should not be instantly stuck",
  );
  assert.equal(
    jobLooksStuck({ status: "imaging", progress: 0.6, updated_at: NOW - 60_000 }, { now: NOW }),
    false,
    "active imaging with recent heartbeat should not be stuck",
  );
  assert.equal(
    jobLooksStuck(
      { status: "imaging", detail: "Trying pollinations-anon for cover", updated_at: NOW - 17 * 60_000 },
      { now: NOW },
    ),
    true,
    "provider wait beyond PROVIDER_STALE_MS should be stuck",
  );
  // Regression: local_sd (animagine-xl, IP-Adapter reference conditioning)
  // measured 90-140s+ for a single character generation with no
  // intermediate progress tick — the old 3-minute PROVIDER_STALE_MS could
  // false-flag a legitimately-still-working local generation as stuck,
  // force-unlocking the book mid-write and orphaning the staged `.next.png`
  // (surfaced live as a dead link in the compare modal). Bumped to 6
  // minutes, then to 16 once server.py's _generate_with_retry started
  // auto-retrying up to 3 full attempts server-side (each a full local_sd
  // pass plus an Ollama vision classify call) — a multi-attempt retry
  // sequence on a single character must not be considered stuck.
  assert.equal(
    jobLooksStuck(
      { status: "imaging", detail: "Trying local_sd for character · emperor", updated_at: NOW - 12 * 60_000 },
      { now: NOW },
    ),
    false,
    "a local_sd generation still within its slower normal range must not be flagged stuck",
  );
  // Regression: a SECOND, separate staleness branch (atCap/highProgress)
  // had its own hardcoded 4-minute threshold that silently overrode
  // PROVIDER_STALE_MS above. step_total is the regen's ITEM count
  // (characters/scenes/cover), not a diffusion step count — for the
  // extremely common case of regenerating exactly ONE character,
  // step_index (1) >= step_total (1) is true for that item's ENTIRE
  // duration, not just once finalizing. Confirmed live: a one-character
  // local_sd job force-unlocked at ~7m44s (past the old 4-minute atCap
  // threshold, well under the 16-minute PROVIDER_STALE_MS) while the
  // server was still legitimately retrying — the job wasn't stuck, it was
  // burned by a second timeout nobody had touched.
  assert.equal(
    jobLooksStuck(
      {
        status: "imaging", detail: "Trying local_sd for character · anne",
        progress: 0.99, step_index: 1, step_total: 1, updated_at: NOW - 8 * 60_000,
      },
      { now: NOW },
    ),
    false,
    "a single-item local_sd regen at 'step_index >= step_total' must not be stuck via the atCap/highProgress path either",
  );
}

// reconcileImagingLock — ingest job_id alone must not clear catalog to done
{
  const jobs = {
    "ingest:ing1": JSON.stringify({
      job_id: "ing1",
      status: "queued",
      stage: "queued",
      created_at: NOW - 10_000,
    }),
  };
  const env = {
    VAE_JOBS: {
      get: async (k) => jobs[k] || null,
      put: async (k, v) => { jobs[k] = v; },
    },
  };
  const meta = {
    book_id: "my-book",
    job_id: "ing1",
    stage: "queued",
    status: "processing",
    progress: 0,
  };
  const { meta: out, cleared, active } = await reconcileImagingLock(env, "my-book", meta);
  assert.equal(cleared, false);
  assert.equal(active, false);
  assert.equal(out.stage, "queued");
  assert.equal(out.status, "processing");
  assert.notEqual(out.progress, 1);
}

// reconcileImagingLock — locked regen marked stale keeps imaging stage (not false done)
{
  const jobs = {
    "ingest:reg1": JSON.stringify({
      job_id: "reg1",
      status: "imaging",
      stage: "imaging",
      detail: "Trying cloudflare for background · scene-1",
      updated_at: NOW - 7 * 60_000,
      progress: 0.4,
    }),
  };
  const env = {
    VAE_JOBS: {
      get: async (k) => jobs[k] || null,
      put: async (k, v) => { jobs[k] = v; },
    },
  };
  const meta = {
    book_id: "my-book",
    imaging_locked: true,
    active_job_id: "reg1",
    stage: "imaging",
    status: "processing",
    progress: 0.4,
  };
  const { meta: out, cleared } = await reconcileImagingLock(env, "my-book", meta);
  assert.equal(cleared, true);
  assert.equal(out.imaging_locked, false);
  assert.equal(out.stage, "imaging");
  assert.equal(out.status, "processing");
  assert.notEqual(out.progress, 1);
  assert.match(out.detail, /timed out|stalled/i);
}

// reconcileImagingLock — error job clears lock (catalog was stuck at 70% imaging)
{
  const jobs = {
    "ingest:dead1": JSON.stringify({
      job_id: "dead1",
      status: "error",
      stage: "error",
      detail: "Imaging job stalled — unlock and retry",
      progress: 0.7,
      updated_at: NOW - 86400_000,
    }),
  };
  const env = {
    VAE_JOBS: {
      get: async (k) => jobs[k] || null,
      put: async (k, v) => { jobs[k] = v; },
    },
  };
  const meta = {
    book_id: "my-book",
    imaging_locked: true,
    active_job_id: "dead1",
    stage: "imaging",
    status: "imaging",
    progress: 0.7,
  };
  const { meta: out, cleared, active } = await reconcileImagingLock(env, "my-book", meta);
  assert.equal(cleared, true);
  assert.equal(active, false);
  assert.equal(out.imaging_locked, false);
  assert.equal(out.active_job_id, null);
  assert.equal(out.status, "ready");
  assert.equal(out.progress, 0.7);
}

console.log("imaging-lock.test.mjs — all passed");
