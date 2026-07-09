import { putJob, getJob, putBookIndex, json } from "../../_shared/jobs-kv.js";
import { syncCatalogCover } from "../../_shared/catalog-cover.js";
import { emitJobEvent, jobToEvent } from "../../_shared/job-events.js";
import { multiplexJobEventStream } from "../../_shared/job-sse-stream.js";
import { ensureImagingLockFresh, markJobStale } from "../../_shared/imaging-lock.js";
import { loadStoredEpubBytes } from "../../_shared/book-extract-pipeline.js";
import { getCheckpoint } from "../../_shared/book-checkpoint.js";

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

/** POST /books/:id/imaging/unlock — ?force=true clears even when job looks active (after stale mark). */
export async function onImagingUnlockPost({ env, bookId, request }) {
  if (!env.VAE_JOBS) return null;
  if (!(await bookExists(env, bookId))) {
    return json({ error: "no such book" }, 404);
  }
  try {
    const force = new URL(request?.url || "", "https://x").searchParams.get("force") === "true";
    if (force) {
      const raw = await env.VAE_JOBS.get(`book:${bookId}`);
      const meta = raw ? JSON.parse(raw) : {};
      const jobId = meta.active_job_id || meta.job_id;
      if (jobId) {
        const job = await getJob(env, "ingest", jobId);
        await markJobStale(env, jobId, job, "Manually unlocked");
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

/**
 * POST /books/:id/cancel-processing — stop treating a stuck/in-flight job as
 * active. Queues have no cancel primitive, so a running consumer invocation
 * (e.g. mid-chapter extraction) keeps running to completion or failure on
 * its own — this can't interrupt it. What it does do: mark the job record
 * terminal so nothing keeps polling/waiting on it, and reset the book index
 * out of "processing" so the UI stops showing a live progress banner tied to
 * a job that's never coming back (e.g. after a dev server restart, or a
 * crash loop). Lands on "partial" (resumable) if any chapters already
 * extracted, otherwise "error" (nothing to resume from — re-upload or
 * continue-extract needed).
 */
export async function onCancelProcessingPost({ env, bookId }) {
  if (!env.VAE_JOBS) return null;
  const raw = await env.VAE_JOBS.get(`book:${bookId}`);
  if (!raw) return json({ error: "no such book" }, 404);
  const meta = JSON.parse(raw);

  const jobId = meta.active_job_id || meta.job_id;
  if (jobId) {
    const job = await getJob(env, "ingest", jobId);
    await markJobStale(env, jobId, job, "Cancelled by user");
  }

  const chaptersReady = meta.chapters_ready || 0;
  const totalChapters = meta.total_chapters;
  const patch = chaptersReady > 0
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
  if (!ok) return json({ error: "no previous version to restore" }, 404);

  const { assetFilename } = await import("../../_shared/media-versions.js");
  const fn = assetFilename(kind, key);
  const url = cacheBustUrl(mediaUrl(bookId, style, fn));
  await patchPlaybackMediaUrl(env, bookId, kind, key, url);
  if (kind === "cover") await syncCatalogCover(env, bookId, url);
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
  if (!url) return json({ error: "asset not found" }, 404);
  await patchPlaybackMediaUrl(env, bookId, kind, key, url);
  if (kind === "cover") await syncCatalogCover(env, bookId, url);
  return json({ ok: true, url });
}
