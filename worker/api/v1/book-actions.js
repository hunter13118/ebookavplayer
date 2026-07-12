import { putJob, getJob, putBookIndex, json } from "../../_shared/jobs-kv.js";
import { syncCatalogCover } from "../../_shared/catalog-cover.js";
import { emitJobEvent, jobToEvent } from "../../_shared/job-events.js";
import { multiplexJobEventStream } from "../../_shared/job-sse-stream.js";
import { ensureImagingLockFresh, markJobStale } from "../../_shared/imaging-lock.js";
import { loadStoredEpubBytes } from "../../_shared/book-extract-pipeline.js";
import { getCheckpoint } from "../../_shared/book-checkpoint.js";
import { DEFAULT_EXPRESSIVE_BUCKETS } from "../../_shared/edge-imaging.js";

function edgeJobsEnabled(env) {
  return Boolean(env.VAE_PACKS && env.VAE_JOBS && env.VAE_JOBS_QUEUE);
}

async function bookExists(env, bookId) {
  const ax = await env.VAE_PACKS.get(`books/${bookId}.analysis.json`);
  const pb = await env.VAE_PACKS.get(`books/${bookId}.json`);
  return Boolean(ax || pb);
}

async function enqueueJob(env, msg) {
  if (env.VAE_JOBS_QUEUE) {
    await env.VAE_JOBS_QUEUE.send(msg);
    return;
  }
  const { onQueueBatch } = await import("../../queue/dispatch.js");
  await onQueueBatch(
    { messages: [{ body: msg, ack: () => {}, retry: () => {} }] },
    env,
  );
}

/** POST /books/:id/re-extract */
export async function onReExtractPost({
  env, bookId, force, preferProvider,
}) {
  if (!edgeJobsEnabled(env)) return null;
  if (!(await bookExists(env, bookId))) {
    return json({ error: "no such book" }, 404);
  }
  if (!(await loadStoredEpubBytes(env, bookId))) {
    return json({ error: "EPUB not found — re-upload the book first" }, 404);
  }

  const jobId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const job = {
    job_id: jobId,
    book_id: bookId,
    kind: "re-extract",
    status: "queued",
    progress: 0,
    detail: "queued",
    stage: "queued",
  };
  await putJob(env, "ingest", jobId, job);
  await emitJobEvent(env, jobId, jobToEvent(job, "queued"));

  await enqueueJob(env, {
    kind: "re-extract",
    job_id: jobId,
    book_id: bookId,
    force_provider: Boolean(force),
    prefer_provider: preferProvider || null,
  });

  return json({ job_id: jobId, book_id: bookId, status: "queued" });
}

/**
 * POST /books/:id/expression-repass — manually re-run the Expression
 * Sensitivity Plan Phase 1d/1e dialogue-tagging pass over the whole book,
 * independent of whether the automatic per-chapter trigger fired during
 * extraction (VAE_EXPRESSION_REPASS=true always-on, or auditExpressionFlatness
 * auto-triggering only on chapters it flags as suspiciously flat). See
 * docs/TODO_ILLUSTRATIONS_PROFILES_POLISH.md item 5.
 */
export async function onExpressionRepassPost({ request, env, bookId }) {
  if (!edgeJobsEnabled(env)) return null;
  if (!(await bookExists(env, bookId))) {
    return json({ error: "no such book" }, 404);
  }

  let body = {};
  try { body = await request.json(); } catch { /* no body — fine, defaults below */ }

  const jobId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const job = {
    job_id: jobId,
    book_id: bookId,
    kind: "expression-repass",
    status: "queued",
    progress: 0,
    detail: "queued",
    stage: "queued",
  };
  await putJob(env, "ingest", jobId, job);
  await emitJobEvent(env, jobId, jobToEvent(job, "queued"));
  await putBookIndex(env, bookId, { active_job_id: jobId });

  await enqueueJob(env, {
    kind: "expression-repass",
    job_id: jobId,
    book_id: bookId,
    opts: { prefer_provider: body.prefer_provider || null },
  });

  return json({ job_id: jobId, book_id: bookId, status: "queued" });
}

/**
 * POST /books/:id/characters/:characterId/expressions/regen — regenerate ONE
 * alt-expression bucket for a primary character (e.g. redo a bad "angry"
 * result) without touching the base portrait or the other buckets. There's
 * no bulk "redo all expressions" endpoint by design — same 4-bucket
 * cost-gate as the automatic path (see edge-imaging.js's
 * generateExpressionSpritesForCharacter / DEFAULT_EXPRESSIVE_BUCKETS).
 */
export async function onExpressionSpriteRegenPost({ request, env, bookId, characterId }) {
  if (!edgeJobsEnabled(env)) return null;
  if (!(await bookExists(env, bookId))) {
    return json({ error: "no such book" }, 404);
  }

  let body = {};
  try { body = await request.json(); } catch { /* no body — fine, validated below */ }
  const bucket = body.bucket;
  if (!bucket || !DEFAULT_EXPRESSIVE_BUCKETS.includes(bucket)) {
    return json({ error: `bucket required — one of ${DEFAULT_EXPRESSIVE_BUCKETS.join(", ")}` }, 400);
  }

  const pbObj = await env.VAE_PACKS.get(`books/${bookId}.json`);
  const playback = pbObj ? await pbObj.json() : null;
  const character = playback?.characters?.[characterId];
  if (!character) return json({ error: "no such character" }, 404);
  if (character.importance !== "primary") {
    return json({ error: "expression art is only generated for primary characters" }, 400);
  }
  if (!character.sprite) {
    return json({ error: "character has no base portrait yet — generate/confirm one first" }, 400);
  }

  const metaRaw = await env.VAE_JOBS.get(`book:${bookId}`);
  const meta = metaRaw ? JSON.parse(metaRaw) : {};
  const style = meta.art_style || playback?.active_style || "anime";

  const jobId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const job = {
    job_id: jobId,
    book_id: bookId,
    kind: "expression-sprites",
    status: "queued",
    progress: 0,
    detail: `queued · ${characterId}:${bucket}`,
    stage: "queued",
  };
  await putJob(env, "ingest", jobId, job);
  await emitJobEvent(env, jobId, jobToEvent(job, "queued"));
  await enqueueJob(env, {
    kind: "expression-sprites",
    job_id: jobId,
    book_id: bookId,
    character_id: characterId,
    art_style: style,
    buckets: [bucket],
  });

  return json({
    job_id: jobId, book_id: bookId, character_id: characterId, bucket, status: "queued",
  });
}

/**
 * POST /books/:id/illustrations/match-characters — manually run the "who's
 * pictured in this plate" LLM pass over the whole book, matching EPUB
 * illustration plates to known characters via their nearby text, and
 * applying any confident match the same way a manual Character settings
 * assignment would (sprite/cover update included). See
 * docs/TODO_ILLUSTRATIONS_PROFILES_POLISH.md item 2.
 */
export async function onIllustrationCharacterMatchPost({ request, env, bookId }) {
  if (!edgeJobsEnabled(env)) return null;
  if (!(await bookExists(env, bookId))) {
    return json({ error: "no such book" }, 404);
  }

  let body = {};
  try { body = await request.json(); } catch { /* no body — fine, defaults below */ }

  const jobId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const job = {
    job_id: jobId,
    book_id: bookId,
    kind: "illustration-character-match",
    status: "queued",
    progress: 0,
    detail: "queued",
    stage: "queued",
  };
  await putJob(env, "ingest", jobId, job);
  await emitJobEvent(env, jobId, jobToEvent(job, "queued"));
  await putBookIndex(env, bookId, { active_job_id: jobId });

  await enqueueJob(env, {
    kind: "illustration-character-match",
    job_id: jobId,
    book_id: bookId,
    opts: { prefer_provider: body.prefer_provider || null },
  });

  return json({ job_id: jobId, book_id: bookId, status: "queued" });
}

/** POST /books/:id/continue-extract — resume a stalled/partial book from its checkpoint. */
export async function onContinueExtractPost({ request, env, bookId }) {
  if (!edgeJobsEnabled(env)) return null;

  const checkpoint = await getCheckpoint(env, bookId);
  if (!checkpoint) {
    return json({ error: "no checkpoint for this book — nothing to resume" }, 404);
  }
  if (checkpoint.next_chapter_idx >= checkpoint.total_chapters) {
    return json({ error: "book already fully extracted" }, 400);
  }
  if (!(await loadStoredEpubBytes(env, bookId))) {
    return json({ error: "EPUB not found — re-upload the book first" }, 404);
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    // no body / not JSON — fine, use defaults below.
  }
  let preferProvider = body.prefer_provider || null;
  if (preferProvider === "auto") preferProvider = null;

  const bookRaw = env.VAE_JOBS ? await env.VAE_JOBS.get(`book:${bookId}`) : null;
  const bookMeta = bookRaw ? JSON.parse(bookRaw) : {};

  const jobId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const job = {
    job_id: jobId,
    book_id: bookId,
    kind: "continue-extract",
    status: "queued",
    progress: checkpoint.chapters_done.length / Math.max(checkpoint.total_chapters, 1),
    detail: `Resuming at chapter ${checkpoint.next_chapter_idx + 1}/${checkpoint.total_chapters}`,
    stage: "queued",
  };
  await putJob(env, "ingest", jobId, job);
  await emitJobEvent(env, jobId, jobToEvent(job, "queued"));
  await putBookIndex(env, bookId, {
    job_id: jobId,
    active_job_id: jobId,
    status: "processing",
    stage: "queued",
  });

  await enqueueJob(env, {
    kind: "continue-extract",
    job_id: jobId,
    book_id: bookId,
    art_style: bookMeta.art_style || "anime",
    narrator_gender: bookMeta.narrator_gender || "male",
    generate_art: bookMeta.generate_art !== false,
    dry_run: false,
    byo_mode: Boolean(bookMeta.byo_mode),
    illustration_mode: bookMeta.illustration_mode || null,
    prefer_provider: preferProvider,
  });

  return json({
    job_id: jobId,
    book_id: bookId,
    status: "queued",
    resuming_from_chapter: checkpoint.next_chapter_idx,
    total_chapters: checkpoint.total_chapters,
    prefer_provider: preferProvider,
  });
}

/** POST /books/:id/moments/generate */
export async function onGenerateMomentPost({ request, env, bookId }) {
  if (!edgeJobsEnabled(env)) return null;
  if (!(await bookExists(env, bookId))) {
    return json({ error: "no such book" }, 404);
  }

  let body = {};
  try {
    body = await request.json();
  } catch { /* empty body ok */ }

  const lineIdx = body.line_idx;
  if (!Number.isInteger(lineIdx) || lineIdx < 0) {
    return json({ error: "line_idx required (non-negative integer)" }, 400);
  }

  const jobId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const now = Date.now();
  const job = {
    job_id: jobId,
    book_id: bookId,
    kind: "moment-generate",
    status: "queued",
    progress: 0,
    detail: "queued",
    stage: "queued",
    line_idx: lineIdx,
    created_at: now,
    updated_at: now,
  };
  await putJob(env, "ingest", jobId, job);
  await emitJobEvent(env, jobId, jobToEvent(job, "queued"));

  await enqueueJob(env, {
    kind: "moment-generate",
    job_id: jobId,
    book_id: bookId,
    line_idx: lineIdx,
    tweak_script: body.tweak_script !== false,
    diversify: Boolean(body.diversify),
  });

  return json({
    job_id: jobId,
    book_id: bookId,
    status: "queued",
    line_idx: lineIdx,
  });
}

/** POST /books/:id/generate-media */
export async function onGenerateMediaPost({ request, env, bookId }) {
  if (!edgeJobsEnabled(env)) return null;
  if (!(await bookExists(env, bookId))) {
    return json({ error: "no such book" }, 404);
  }

  let opts = {};
  try {
    opts = await request.json();
  } catch { /* empty body ok */ }

  if (opts.scope === "inserts") {
    return json({ error: "insert illustration regen is not yet supported on edge — use full ingest" }, 501);
  }

  const { active, meta } = await ensureImagingLockFresh(env, bookId);
  if (active) {
    return json({
      error: "imaging already in progress",
      active_job_id: meta.active_job_id || null,
    }, 409);
  }

  const jobId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const now = Date.now();
  const job = {
    job_id: jobId,
    book_id: bookId,
    kind: "imaging-regen",
    status: "queued",
    progress: 0,
    detail: "queued",
    stage: "imaging",
    created_at: now,
    updated_at: now,
  };
  await putJob(env, "ingest", jobId, job);

  await putBookIndex(env, bookId, {
    imaging_locked: true,
    active_job_id: jobId,
    stage: "imaging",
    progress: 0,
    status: "processing",
  });

  await emitJobEvent(env, jobId, jobToEvent(job, "queued"));

  await enqueueJob(env, {
    kind: "imaging-regen",
    job_id: jobId,
    book_id: bookId,
    opts,
  });

  return json({ job_id: jobId, book_id: bookId, status: "queued" });
}

/** POST /books/:id/imaging/unlock — ?force=true clears even when job looks
 * active (after stale mark). ?job_id=<id>, when present, scopes the unlock
 * to that specific job: a mismatch against the book's currently active job
 * is a no-op (imaging_locked/active_job_id are left untouched) rather than
 * clearing/stale-marking whatever happens to be active. Root cause of a
 * real, confirmed-live bug: a client with stale job-tracking state (e.g. a
 * browser tab that outlived several regen attempts) called this with
 * force=true after ITS OWN long-dead job finally reported an error — with
 * no job_id to scope against, this force-unlocked and stale-marked a
 * completely different, still-legitimately-running job that happened to be
 * active on the book at that moment. */
export async function onImagingUnlockPost({ env, bookId, request }) {
  if (!env.VAE_JOBS) return null;
  if (!(await bookExists(env, bookId))) {
    return json({ error: "no such book" }, 404);
  }
  try {
    const url = new URL(request?.url || "", "https://x");
    const force = url.searchParams.get("force") === "true";
    const scopedJobId = url.searchParams.get("job_id") || null;

    const raw = await env.VAE_JOBS.get(`book:${bookId}`);
    const meta = raw ? JSON.parse(raw) : {};
    const activeJobId = meta.active_job_id || meta.job_id || null;

    if (scopedJobId && activeJobId && scopedJobId !== activeJobId) {
      return json({
        ok: true, book_id: bookId, imaging_locked: Boolean(meta.imaging_locked),
        skipped: "job_id did not match the currently active job",
      });
    }

    if (force) {
      if (activeJobId) {
        const job = await getJob(env, "ingest", activeJobId);
        await markJobStale(env, activeJobId, job, "Manually unlocked");
      }
    } else {
      await ensureImagingLockFresh(env, bookId);
    }
    await putBookIndex(env, bookId, {
      imaging_locked: false,
      stage: "done",
      status: "ready",
      active_job_id: null,
      progress: 1,
    });
    return json({ ok: true, book_id: bookId, imaging_locked: false });
  } catch (err) {
    return json({ error: String(err?.message || err), book_id: bookId }, 503);
  }
}

// Kinds that only ever run AFTER a book is fully extracted — cancelling one
// of these should land the book back on "ready", never "extracting"/
// "partial" (the book's text is untouched; only art/expression generation
// was interrupted). Anything else (ingest/continue-extract/re-extract) is
// an extraction-phase job, where the chapters-ready-based branch below
// still applies.
const POST_EXTRACTION_JOB_KINDS = new Set([
  "imaging-regen", "expression-sprites", "expression-repass",
  "illustration-character-match", "moment-generate",
]);

/**
 * POST /books/:id/cancel-processing — stop treating a stuck/in-flight job as
 * active. Queues have no cancel primitive, so a running consumer invocation
 * (e.g. mid-chapter extraction, or a bulk art regen already generating an
 * image) can't be killed from outside — it keeps running to completion or
 * failure on its own. What this DOES do, to get as close to "stop the
 * queue" as a queue-based architecture allows:
 * 1. Marks the job record `cancelled: true` (markJobStale's new option) —
 *    a running consumer polls this between items (edge-imaging.js's
 *    `checkCancelled`, wired from imaging-regen-consumer.js /
 *    expression-sprites-consumer.js) and stops picking up NEW work rather
 *    than grinding through everything left in its plan. The current item
 *    still finishes (can't abort a live generation call either).
 * 2. dispatch.js checks this same flag before routing ANY queued message
 *    to its consumer — a message that was still purely queued (never
 *    started) when cancelled now no-ops instead of running at all.
 * 3. Resets the book index out of "processing" so the UI stops showing a
 *    live progress banner tied to a job that's never coming back. Which
 *    reset depends on the cancelled job's `kind` (see
 *    POST_EXTRACTION_JOB_KINDS above) — this used to always assume an
 *    extraction-phase job and stamp `stage: "extracting"` even when
 *    cancelling a fully-extracted book's stuck art regen, which wrongly
 *    told the UI the book needed re-extraction. Confirmed live: cancelling
 *    a 16/16-chapter book's imaging-regen left it reporting
 *    `stage: "extracting"` instead of going back to `ready`.
 */
export async function onCancelProcessingPost({ env, bookId }) {
  if (!env.VAE_JOBS) return null;
  const raw = await env.VAE_JOBS.get(`book:${bookId}`);
  if (!raw) return json({ error: "no such book" }, 404);
  const meta = JSON.parse(raw);

  const jobId = meta.active_job_id || meta.job_id;
  let job = null;
  if (jobId) {
    job = await getJob(env, "ingest", jobId);
    await markJobStale(env, jobId, job, "Cancelled by user", { cancelled: true });
  }

  const chaptersReady = meta.chapters_ready || 0;
  const totalChapters = meta.total_chapters;
  // Prefer the job's own kind when it's still around, but don't depend on
  // it — imaging-lock.js's passive staleness reconciliation (it runs on
  // every GET /books poll) can clear active_job_id/mark the job record
  // stale on its own, in the background, before the user's cancel click
  // even lands. When that race happens `job` here is null/already-stale
  // and the kind check alone would silently fall through to the
  // extraction-phase branch below. A book with every chapter already
  // extracted couldn't have been running an extraction-phase job in the
  // first place, so that's an equally reliable (and race-proof) signal.
  const fullyExtracted = totalChapters != null && chaptersReady >= totalChapters;
  const isPostExtraction = (job?.kind && POST_EXTRACTION_JOB_KINDS.has(job.kind)) || fullyExtracted;

  const patch = isPostExtraction
    ? {
        status: "ready",
        stage: "done",
        progress: 1,
        active_job_id: null,
        job_id: null,
        imaging_locked: false,
        detail: "Cancelled — art generation stopped",
        error: "",
      }
    : chaptersReady > 0
      ? {
          status: "partial",
          stage: "extracting",
          active_job_id: null,
          job_id: null,
          imaging_locked: false,
          detail: `Cancelled — ${chaptersReady}/${totalChapters ?? "?"} chapters ready`,
          error: "",
        }
      : {
          status: "error",
          stage: "error",
          active_job_id: null,
          job_id: null,
          imaging_locked: false,
          detail: "Cancelled before any chapters finished — re-upload to retry",
          error: "Cancelled before any chapters finished",
        };

  await putBookIndex(env, bookId, patch);
  return json({ ok: true, book_id: bookId, status: patch.status });
}

/** GET /ingest/:id/events — SSE stream via JobEventHub DO. */
export async function onJobEventsGet({ env, jobId, request }) {
  const job = await getJob(env, "ingest", jobId);
  if (!job) return null;

  if (!env.JOB_EVENTS) {
    return json(jobToEvent(job, "snapshot"));
  }

  const id = env.JOB_EVENTS.idFromName(jobId);
  const stub = env.JOB_EVENTS.get(id);
  const doRes = await stub.fetch(new Request(request.url, {
    method: "GET",
    headers: request.headers,
    signal: request.signal,
  }));

  const combined = multiplexJobEventStream({
    env,
    jobId,
    initialJob: job,
    doBody: doRes.body,
    requestSignal: request.signal,
  });

  const headers = new Headers(doRes.headers);
  headers.set("Content-Type", "text/event-stream");
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.set("Connection", "keep-alive");
  return new Response(combined, { status: doRes.status, headers });
}

/** GET /ingest/:id — also serves re-extract and imaging-regen jobs. */
export async function onJobStatusGet({ env, jobId }) {
  const job = await getJob(env, "ingest", jobId);
  if (!job) return null;
  return json({
    job_id: jobId,
    book_id: job.book_id,
    status: job.status,
    stage: job.stage || job.status,
    progress: job.progress ?? 0,
    step_index: job.step_index ?? null,
    step_total: job.step_total ?? null,
    workers: job.workers || [],
    detail: job.detail || "",
    comparisons: job.comparisons || [],
    log: job.log || [],
    debug_log: job.debug_log || [],
    banners: [],
  });
}

/** POST /books/:id/media/revert */
export async function onMediaRevertPost({ request, env, bookId }) {
  if (!env.VAE_PACKS) return null;
  let body = {};
  try { body = await request.json(); } catch { /* empty */ }
  const { kind, key, style: reqStyle } = body;
  if (!kind || key == null) return json({ error: "kind and key required" }, 400);

  const metaRaw = await env.VAE_JOBS.get(`book:${bookId}`);
  const meta = metaRaw ? JSON.parse(metaRaw) : {};
  const pbObj = await env.VAE_PACKS.get(`books/${bookId}.json`);
  const playback = pbObj ? await pbObj.json() : null;
  const style = reqStyle || meta.art_style || playback?.active_style || "anime";

  const { revertMediaAsset, patchPlaybackMediaUrl, cacheBustUrl } = await import(
    "../../_shared/media-versions.js"
  );
  const { mediaUrl } = await import("../../_shared/freemium-image.js");
  const ok = await revertMediaAsset(env, bookId, style, kind, key);
  if (!ok) {
    // Nothing to revert to (e.g. the character never had committed art
    // before this generation) — still a resolved decision from the user's
    // perspective, so stop re-offering this comparison on future job resyncs.
    if (body.job_id) await clearResolvedComparison(env, body.job_id, kind, key);
    return json({ error: "no previous version to restore" }, 404);
  }

  const { assetFilename } = await import("../../_shared/media-versions.js");
  const fn = assetFilename(kind, key);
  const url = cacheBustUrl(mediaUrl(bookId, style, fn));
  await patchPlaybackMediaUrl(env, bookId, kind, key, url);
  if (kind === "cover") await syncCatalogCover(env, bookId, url);
  if (body.job_id) await clearResolvedComparison(env, body.job_id, kind, key);
  return json({ ok: true, url });
}

/** GET /books/:id/external-refs */
export async function onExternalRefsGet({ env, bookId }) {
  if (!env.VAE_JOBS) return null;
  const pbObj = await env.VAE_PACKS?.get(`books/${bookId}.json`);
  if (!pbObj) return json({ error: "no such book" }, 404);
  const { loadExternalRefs } = await import("../../_shared/external-refs.js");
  return json(await loadExternalRefs(env, bookId));
}

/** PATCH /books/:id/external-refs — user URLs (Fandom, etc.), KV only. */
export async function onExternalRefsPatch({ request, env, bookId }) {
  if (!env.VAE_JOBS) return null;
  let body = {};
  try { body = await request.json(); } catch { /* empty */ }
  const pbObj = await env.VAE_PACKS?.get(`books/${bookId}.json`);
  if (!pbObj) return json({ error: "no such book" }, 404);
  const { saveExternalRefs } = await import("../../_shared/external-refs.js");
  const saved = await saveExternalRefs(env, bookId, body);
  return json({ ok: true, ...saved });
}

/** PATCH /books/:id/illustration-refs — map EPUB plates → characters / cover. */
export async function onIllustrationRefsPatch({ request, env, bookId }) {
  if (!env.VAE_PACKS) return null;

  const axObj = await env.VAE_PACKS.get(`books/${bookId}.analysis.json`);
  if (!axObj) return json({ error: "no analysis for book" }, 404);

  let body = {};
  try { body = await request.json(); } catch { /* empty */ }

  const analysis = await axObj.json();
  const catalog = analysis.illustration_urls || {};
  const {
    applyIllustrationRefsPatch,
    syncIllustrationRefsToPlayback,
    validateIllustrationRef,
  } = await import("../../_shared/illustration-refs.js");

  if (body.cover_illustration_ref !== undefined
    && !validateIllustrationRef(body.cover_illustration_ref, catalog)) {
    return json({ error: "invalid cover_illustration_ref" }, 400);
  }

  if (body.characters && typeof body.characters === "object") {
    for (const ref of Object.values(body.characters)) {
      if (!validateIllustrationRef(ref, catalog)) {
        return json({ error: "invalid character illustration_ref" }, 400);
      }
    }
  }

  const patched = applyIllustrationRefsPatch(analysis, {
    cover_illustration_ref: body.cover_illustration_ref,
    characters: body.characters,
  });

  await env.VAE_PACKS.put(
    `books/${bookId}.analysis.json`,
    JSON.stringify(patched, null, 2),
    { httpMetadata: { contentType: "application/json" } },
  );

  const pbObj = await env.VAE_PACKS.get(`books/${bookId}.json`);
  let playback = pbObj ? await pbObj.json() : null;
  if (playback) {
    playback = syncIllustrationRefsToPlayback(playback, patched);
    // syncIllustrationRefsToPlayback only stashes the ref *number* on each
    // character — it never touches the actual rendered sprite/background/
    // cover, so a manual assignment here used to save successfully but
    // change nothing visible in the player. applyDirectIllustrations
    // (illustrations.js) is the same function the initial extraction runs
    // for "direct-use" mode — reuse it here so a manual assignment takes
    // effect immediately, exactly like an automatic one would.
    const { applyDirectIllustrations } = await import("../../_shared/illustrations.js");
    ({ playback } = applyDirectIllustrations(playback, patched, catalog));
    await env.VAE_PACKS.put(
      `books/${bookId}.json`,
      JSON.stringify(playback, null, 2),
      { httpMetadata: { contentType: "application/json" } },
    );
  }

  return json({
    ok: true,
    cover_illustration_ref: patched.cover_illustration_ref ?? null,
    characters: Object.fromEntries(
      (patched.characters || [])
        .filter((c) => c.illustration_ref != null)
        .map((c) => [c.id, c.illustration_ref]),
    ),
  });
}

/**
 * POST /books/:id/illustrations/backfill — re-run EPUB plate extraction for a
 * book that already finished extracting without one (predates this pipeline,
 * or a silent R2-write failure — extraction itself never gates on this
 * succeeding). Re-opens the stored EPUB, re-extracts + re-persists plates to
 * R2 (illustration_urls), and auto-sets cover_illustration_ref from the
 * EPUB's own cover if the book doesn't already have one set. Does not
 * attempt automatic character/scene matching for an already-compiled book —
 * that needs a per-plate LLM "who's pictured" pass (see
 * docs/TODO_ILLUSTRATIONS_PROFILES_POLISH.md item 2), a distinct, heavier
 * feature. Manual plate → character/cover assignment is already available
 * via EpubPlatesSheet.jsx / PATCH /books/:id/illustration-refs once the
 * plates this endpoint populates are in the catalog.
 */
export async function onIllustrationsBackfillPost({ env, bookId }) {
  if (!env.VAE_PACKS) return null;

  const axObj = await env.VAE_PACKS.get(`books/${bookId}.analysis.json`);
  if (!axObj) return json({ error: "no analysis for book" }, 404);
  const analysis = await axObj.json();

  const bytes = await loadStoredEpubBytes(env, bookId);
  if (!bytes) return json({ error: "EPUB not found — re-upload the book first" }, 404);

  const { extractEpubImages } = await import("../../_shared/epub-images.js");
  const { persistEpubImages } = await import("../../_shared/reference-images.js");

  const illusCap = parseInt(env.VAE_EPUB_MAX_IMAGES || "0", 10);
  const epubExtract = extractEpubImages(bytes, { maxImages: illusCap > 0 ? illusCap : null });
  if (!epubExtract.images.length) {
    return json({ ok: true, plates_found: 0, detail: "no images found in this EPUB" });
  }

  const illustrationUrls = await persistEpubImages(env, bookId, epubExtract.images);

  const patched = { ...analysis, illustration_urls: illustrationUrls };
  if (patched.cover_illustration_ref == null && epubExtract.cover_index != null) {
    patched.cover_illustration_ref = epubExtract.cover_index;
  }

  await env.VAE_PACKS.put(
    `books/${bookId}.analysis.json`,
    JSON.stringify(patched, null, 2),
    { httpMetadata: { contentType: "application/json" } },
  );

  const pbObj = await env.VAE_PACKS.get(`books/${bookId}.json`);
  if (pbObj) {
    const { syncIllustrationRefsToPlayback } = await import("../../_shared/illustration-refs.js");
    let playback = await pbObj.json();
    playback.illustration_urls = illustrationUrls;
    playback = syncIllustrationRefsToPlayback(playback, patched);
    await env.VAE_PACKS.put(
      `books/${bookId}.json`,
      JSON.stringify(playback, null, 2),
      { httpMetadata: { contentType: "application/json" } },
    );
  }

  return json({
    ok: true,
    plates_found: epubExtract.images.length,
    cover_illustration_ref: patched.cover_illustration_ref ?? null,
  });
}

/** POST /books/:id/media/upload — user-provided replacement art (multipart). */
export async function onMediaUploadPost({ request, env, bookId }) {
  if (!env.VAE_PACKS) return null;

  const axObj = await env.VAE_PACKS.get(`books/${bookId}.analysis.json`);
  const pbObj = await env.VAE_PACKS.get(`books/${bookId}.json`);
  if (!axObj && !pbObj) return json({ error: "no such book" }, 404);

  const form = await request.formData();
  const kind = String(form.get("kind") || "");
  const key = String(form.get("key") || "");
  const file = form.get("file");
  if (!kind || !key || !file || typeof file === "string") {
    return json({ error: "kind, key, and file required" }, 400);
  }
  if (!["cover", "characters", "backgrounds", "inserts"].includes(kind)) {
    return json({ error: "kind must be cover, characters, backgrounds, or inserts" }, 400);
  }

  const metaRaw = env.VAE_JOBS ? await env.VAE_JOBS.get(`book:${bookId}`) : null;
  const meta = metaRaw ? JSON.parse(metaRaw) : {};
  const playback = pbObj ? await pbObj.json() : null;
  const style = meta.art_style || playback?.active_style || playback?.art_style || "anime";

  let ext = ".png";
  const origName = file.name || "img.png";
  const dot = origName.lastIndexOf(".");
  if (dot >= 0) {
    const candidate = origName.slice(dot).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".webp"].includes(candidate)) ext = candidate;
  }

  let fname;
  if (kind === "cover") fname = `cover${ext}`;
  else if (kind === "characters") fname = `char_${key}${ext}`;
  else if (kind === "inserts") fname = `insert_${key}${ext}`;
  else fname = `bg_${key}${ext}`;

  const bytes = await file.arrayBuffer();
  let contentType = file.type || "image/png";
  if (!contentType.startsWith("image/")) {
    contentType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
      : ext === ".webp" ? "image/webp" : "image/png";
  }

  const { r2MediaKey, mediaUrl } = await import("../../_shared/freemium-image.js");
  const { patchPlaybackMediaUrl, cacheBustUrl } = await import("../../_shared/media-versions.js");

  await env.VAE_PACKS.put(r2MediaKey(bookId, style, fname), bytes, {
    httpMetadata: { contentType },
  });

  const mediaKey = kind === "cover" ? "cover" : key;
  const url = cacheBustUrl(mediaUrl(bookId, style, fname));
  await patchPlaybackMediaUrl(env, bookId, kind, mediaKey, url);
  if (kind === "cover") await syncCatalogCover(env, bookId, url);

  return json({ kind, key, url });
}

/** POST /books/:id/media/commit */
export async function onMediaCommitPost({ request, env, bookId }) {
  if (!env.VAE_PACKS) return null;
  let body = {};
  try { body = await request.json(); } catch { /* empty */ }
  const { kind, key, style: reqStyle } = body;
  if (!kind || key == null) return json({ error: "kind and key required" }, 400);

  const metaRaw = await env.VAE_JOBS.get(`book:${bookId}`);
  const meta = metaRaw ? JSON.parse(metaRaw) : {};
  const pbObj = await env.VAE_PACKS.get(`books/${bookId}.json`);
  const playback = pbObj ? await pbObj.json() : null;
  const style = reqStyle || meta.art_style || playback?.active_style || "anime";

  const { commitMediaAsset, patchPlaybackMediaUrl } = await import("../../_shared/media-versions.js");
  const url = await commitMediaAsset(env, bookId, style, kind, key);
  if (!url) {
    // Staged asset is gone (e.g. orphaned after a dev-server restart) — the
    // user still made a decision, so stop re-offering this comparison.
    if (body.job_id) await clearResolvedComparison(env, body.job_id, kind, key);
    return json({ error: "asset not found" }, 404);
  }
  await patchPlaybackMediaUrl(env, bookId, kind, key, url);
  if (kind === "cover") await syncCatalogCover(env, bookId, url);
  if (body.job_id) await clearResolvedComparison(env, body.job_id, kind, key);

  // A primary character's base portrait was staged (compare mode always
  // stages by default — see imaging-regen-consumer.js), so runEdgeImaging's
  // inline expression-sprite generation was skipped at generation time (it
  // requires `stored.promoted`, i.e. NOT staged). Confirming here is the
  // only later point that knows this sprite is now live — backfill the
  // alt-expression variants now instead of leaving primary characters
  // permanently missing expression art whenever a regen went through
  // compare/review (the default UI flow).
  let expressionSpritesJobId = null;
  if (kind === "characters") {
    const character = playback?.characters?.[key];
    const hasExpressions = character?.expressionSprites
      && Object.keys(character.expressionSprites).length > 0;
    if (character?.importance === "primary" && !hasExpressions) {
      expressionSpritesJobId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
      const job = {
        job_id: expressionSpritesJobId,
        book_id: bookId,
        kind: "expression-sprites",
        status: "queued",
        progress: 0,
        detail: "queued",
        stage: "queued",
      };
      await putJob(env, "ingest", expressionSpritesJobId, job);
      await emitJobEvent(env, expressionSpritesJobId, jobToEvent(job, "queued"));
      await enqueueJob(env, {
        kind: "expression-sprites",
        job_id: expressionSpritesJobId,
        book_id: bookId,
        character_id: key,
        art_style: style,
      });
    }
  }

  return json({ ok: true, url, expression_sprites_job_id: expressionSpritesJobId });
}

/** Remove a resolved (kind, key) entry from a job's staged comparisons so the
 * compare modal stops being re-offered on every SSE resubscribe/page mount. */
async function clearResolvedComparison(env, jobId, kind, key) {
  if (!env.VAE_JOBS) return;
  const { touchIngestJob } = await import("../../_shared/job-touch.js");
  const raw = await env.VAE_JOBS.get(`ingest:${jobId}`);
  if (!raw) return;
  const job = JSON.parse(raw);
  const comparisons = (job.comparisons || []).filter(
    (c) => !(c.kind === kind && String(c.key) === String(key)),
  );
  if (comparisons.length === (job.comparisons || []).length) return;
  await touchIngestJob(env, jobId, {
    comparisons,
    staged: comparisons.length > 0,
  });
}
