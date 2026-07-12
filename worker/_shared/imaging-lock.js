import { getJob, putJob, putBookIndex } from "./jobs-kv.js";

/** Max time an imaging job may hold the book lock while idle. */
const STALE_MS = 20 * 60 * 1000;
/** Queue pickup grace — ingest jobs may sit queued briefly without timestamps. */
const QUEUED_GRACE_MS = 2 * 60 * 1000;
/**
 * Full freemium chain ≈ 5 providers × 18s — allow headroom before declaring
 * stuck. This threshold is too tight for the local_sd provider though: a
 * single animagine-xl character generation (28 steps, IP-Adapter reference
 * conditioning) measured at 90-140s+ per image on Apple Silicon MPS, with no
 * intermediate progress tick during that single "Trying local_sd for
 * character X" attempt — a slow character (or the first one after the
 * pipeline's been idle and needs to reload) could exceed the old 3-minute
 * threshold on its own, well before actually being stuck. Confirmed live:
 * this fired mid-generation, force-unlocking the book while local_sd was
 * still legitimately working, orphaning the write before the `.next.png`
 * staging file landed — surfaced as a dead link in the compare modal, since
 * the UI already had a comparison entry pointing at a file that never got
 * (or hadn't yet) written. Bumped again (2026-07-10, 6min -> 16min) once
 * server.py's _generate_with_retry started auto-retrying up to
 * MAX_MULTI_FACE_RETRIES+1 times server-side (each a full ~90-140s pass plus
 * an Ollama vision classify call) — same failure mode, same fix: this must
 * stay comfortably above tryLocalSd's own fetch timeout
 * (freemium-image.js, currently 900s), or this lock check fires and
 * force-unlocks the book while local_sd is still legitimately working,
 * before the client-side fetch even times out. Harmless for the fast
 * cloud-chain case this constant was originally tuned for, since those
 * finish in seconds either way.
 */
const PROVIDER_STALE_MS = 16 * 60 * 1000;

function waitingOnProvider(detail) {
  return / via |Trying /i.test(String(detail || ""));
}

function clearedLock(meta, patch = {}) {
  return {
    ...meta,
    imaging_locked: false,
    active_job_id: null,
    status: patch.status || "ready",
    stage: patch.stage || "done",
    progress: patch.progress ?? 1,
    detail: patch.detail || "",
  };
}

function jobTimestamp(job) {
  if (!job) return 0;
  if (typeof job.updated_at === "number") return job.updated_at;
  if (typeof job.created_at === "number") return job.created_at;
  if (typeof job.ts === "number") return job.ts;
  return 0;
}

function jobLooksStuck(job, { now = Date.now() } = {}) {
  if (!job) return true;
  if (job.status === "done" || job.status === "error") return true;

  const detail = String(job.detail || "");
  const ts = jobTimestamp(job);
  const active = job.status === "processing" || job.status === "imaging";

  if (waitingOnProvider(detail)) {
    if (!ts) return false;
    if (now - ts > PROVIDER_STALE_MS) return true;
  }

  // Root cause of a real, confirmed-live bug: this branch's own hardcoded
  // 4-minute threshold was silently overriding PROVIDER_STALE_MS above.
  // step_total is the ITEM count for the regen (characters/scenes/cover),
  // not a diffusion step count — for the extremely common case of
  // regenerating exactly ONE character, step_index >= step_total (atCap)
  // is true from the moment that single item starts, for its entire
  // duration, not just once it's actually finalizing. So a one-character
  // local_sd job with detail "Trying local_sd for character · X" (which
  // legitimately takes several minutes across retries — see
  // MAX_MULTI_FACE_RETRIES) got force-unlocked here at 4 minutes even
  // though PROVIDER_STALE_MS (16 min) says it isn't stuck yet. Skip this
  // branch whenever the provider-wait branch above already owns the
  // staleness call for this detail string — atCap/highProgress should only
  // catch a stall AFTER the provider call returns (e.g. stuck finalizing/
  // writing), which waitingOnProvider's detail pattern doesn't match.
  const atCap = job.step_index != null && job.step_total != null
    && job.step_index >= job.step_total;
  const highProgress = (job.progress ?? 0) >= 0.99;
  if (active && (atCap || highProgress) && !waitingOnProvider(detail)) {
    if (!ts) return false;
    if (now - ts > 4 * 60 * 1000) return true;
  }

  if (job.status === "queued") {
    if (!ts) {
      if (!job.created_at) return false;
      return now - job.created_at > QUEUED_GRACE_MS;
    }
    if (now - ts > 10 * 60 * 1000) return true;
  }

  if (ts && now - ts > STALE_MS) return true;

  if (!ts && active) return false;

  return false;
}

function staleLockPatch(meta, job, reason) {
  return {
    ...meta,
    imaging_locked: false,
    active_job_id: null,
    status: "processing",
    stage: meta.stage === "imaging" || job?.stage === "imaging" ? "imaging" : (meta.stage || "imaging"),
    progress: meta.progress ?? job?.progress ?? 0,
    detail: reason,
    error: reason,
  };
}

/**
 * @param {{ cancelled?: boolean }} opts `cancelled: true` (set by
 * onCancelProcessingPost) is a distinct, explicit marker from generic
 * staleness — consumers poll it (see edge-imaging.js's `checkCancelled`) to
 * stop picking up new work mid-run, since Cloudflare Queues has no way to
 * actually kill an in-flight consumer invocation from outside.
 */
export async function markJobStale(env, jobId, job, reason, { cancelled = false } = {}) {
  if (!jobId || !env?.VAE_JOBS) return;
  const next = {
    ...(job || {}),
    status: "error",
    stage: "error",
    detail: reason,
    error: reason,
    cancelled,
    updated_at: Date.now(),
  };
  await putJob(env, "ingest", jobId, next);
}

/** Cheap poll target for a long-running consumer to check mid-run — see
 * markJobStale's `cancelled` option. */
export async function isJobCancelled(env, jobId) {
  if (!jobId || !env?.VAE_JOBS) return false;
  const job = await getJob(env, "ingest", jobId);
  return Boolean(job?.cancelled);
}

/**
 * Drop imaging lock when the active job finished, vanished, or timed out.
 * @returns {{ meta: object, active: boolean, cleared: boolean, job: object|null }}
 */
export async function reconcileImagingLock(env, bookId, meta = {}) {
  const locked = Boolean(meta.imaging_locked || meta.active_job_id);
  const jobId = meta.active_job_id || (locked ? meta.job_id : null);
  if (!locked) return { meta, active: false, cleared: false, job: null };

  if (!jobId) {
    const next = clearedLock(meta);
    return { meta: next, active: false, cleared: true, job: null };
  }

  const job = await getJob(env, "ingest", jobId);

  if (!job) {
    const next = clearedLock(meta);
    return { meta: next, active: false, cleared: true, job: null };
  }

  // Terminal jobs — release lock; do not run stale provider timeout path on already-failed jobs.
  if (job.status === "done" || job.status === "error") {
    const next = clearedLock(meta, {
      status: job.status === "error" ? "ready" : "ready",
      stage: job.status === "error" ? "imaging" : "done",
      progress: job.status === "error" ? (job.progress ?? meta.progress ?? 0) : 1,
      detail: job.detail || job.error || "",
    });
    return { meta: next, active: false, cleared: true, job };
  }

  if (jobLooksStuck(job)) {
    const reason = waitingOnProvider(job?.detail)
      ? "Image provider timed out — unlock and retry regen"
      : "Imaging job stalled — unlock and retry";
    await markJobStale(env, jobId, job, reason);
    const next = staleLockPatch(meta, job, reason);
    return { meta: next, active: false, cleared: true, job };
  }

  let next = { ...meta };
  let synced = false;
  if (typeof job.progress === "number" && (next.progress ?? 0) > job.progress + 0.02) {
    next.progress = job.progress;
    next.stage = job.stage || next.stage;
    next.status = job.status || next.status;
    next.detail = job.detail || next.detail;
    synced = true;
  }

  return { meta: next, active: true, cleared: synced, job };
}

/** Reconcile and persist when stale or progress was desynced. */
export async function ensureImagingLockFresh(env, bookId) {
  const raw = await env.VAE_JOBS?.get(`book:${bookId}`);
  const meta = raw ? JSON.parse(raw) : {};
  const { meta: next, active, cleared } = await reconcileImagingLock(env, bookId, meta);
  if (cleared) await putBookIndex(env, bookId, next);
  return { active, meta: next, cleared };
}

export { jobLooksStuck, waitingOnProvider };
