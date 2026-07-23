import { putJob, getJob, putBookIndex, json } from "../../_shared/jobs-kv.js";
import { emitJobEvent, jobToEvent } from "../../_shared/job-events.js";
import { extractEpubText } from "../../_shared/epub-text.js";
import { deleteR2Prefix } from "./books.js";
import { resolvedExtractProviders } from "../../_shared/pipeline-registry.js";

const SMALL_BOOK_CHAPTER_THRESHOLD = 15;

/**
 * Pick a sensible default extraction provider from an estimated chapter
 * count — but only from providers `resolvedExtractProviders` actually
 * resolves as enabled (EXTRACT_SKIP_GEMINI, OLLAMA_BASE_URL, etc. already
 * live there). Previously hardcoded "gemini" outright for any book at or
 * under SMALL_BOOK_CHAPTER_THRESHOLD, ignoring EXTRACT_SKIP_GEMINI/a missing
 * GEMINI_API_KEY entirely — and because this becomes a PINNED preferProvider
 * for the whole checkpointed extraction (a pin bypasses the normal fallback
 * chain, see freemium-extract.js), a small book with gemini disabled would
 * silently fail every single chapter forever with no way to self-correct.
 * Confirmed live: a real 12-chapter book stalled at chapter 1/12,
 * "processing" in the UI with zero progress, for hours.
 */
export async function defaultProviderForSize(chapterCount, env) {
  const chain = await resolvedExtractProviders(env);
  if (!chain.length) return null;
  const preferred = chapterCount <= SMALL_BOOK_CHAPTER_THRESHOLD ? "gemini" : "ollama-30b";
  return chain.includes(preferred) ? preferred : chain[0];
}

function edgeIngestEnabled(env) {
  return Boolean(env.VAE_PACKS && env.VAE_JOBS && env.VAE_JOBS_QUEUE);
}

/** POST /ingest — store EPUB in R2, enqueue extract, return immediately.
 *
 * `existing_book_id` (optional) re-targets extraction onto an ALREADY
 * existing book_id instead of deriving a new one from the filename — this is
 * how a book that started m4b-first (audio + STT transcript only, no epub —
 * docs/M4B_FIRST_FLOW.md) can later get a real EPUB "attached": the exact
 * same checkpointed extraction pipeline runs (real chapters instead of
 * STT-guessed ones, plus any embedded illustrations via epub-images.js/
 * illustrations.js's existing "direct-use" mode), it just overwrites the
 * SAME book_id's compiled playback rather than creating a new book. The
 * client-side m4b audio blob (m4bStore.js, keyed by book_id) is untouched —
 * Player.jsx's mount-time re-timing effect already re-runs alignment
 * whenever a book's line structure no longer matches the exact-timing
 * fast path (see m4bFirstTimeline.js), so re-sync happens automatically the
 * next time the book is opened, no extra glue needed here. */
export async function onIngestPost({ request, env, ctx }) {
  if (!edgeIngestEnabled(env)) {
    return null; // caller falls back to origin proxy
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "expected multipart form" }, 400);
  }

  const file = form.get("file");
  if (!file || typeof file.arrayBuffer !== "function") {
    return json({ error: "missing file" }, 400);
  }

  const jobId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const now = Date.now();
  const name = file.name || "book.epub";
  const existingBookId = String(form.get("existing_book_id") || "").trim();
  const bookId = existingBookId
    || name.replace(/\.epub$/i, "").replace(/[^\w-]+/g, "-").slice(0, 64)
    || `book-${jobId}`;
  const titleOverride = existingBookId ? String(form.get("title") || "").trim() : "";
  const artStyle = form.get("art_style") || "anime";
  const narratorGender = form.get("narrator_gender") || "male";
  const dryRun = form.get("dry_run") === "true";
  const generateArt = form.get("generate_art") !== "false";
  // Expression Sensitivity Plan Phase 3d: opt-in, off by default — multiplies
  // image-gen cost by however many expression buckets are covered per
  // primary character. See docs/EXPRESSION_SENSITIVITY_PLAN.md.
  const generateExpressiveSprites = form.get("generate_expressive_sprites") === "true";
  const byoMode = form.get("byo_mode") === "true";
  const illustrationMode = String(form.get("illustration_mode") || env.ILLUSTRATION_MODE || "auto");
  let preferProvider = form.get("prefer_provider") || null;
  if (preferProvider === "auto") preferProvider = null;
  // Per-job opt-out for the BookNLP/annotate enrichment tiers — these can
  // only ever NARROW what's configured server-side (VAE_BOOKNLP_URL/
  // VAE_ANNOTATE_LLM); the toggle has no effect if the server isn't
  // configured for it at all. Default true (opt-out framing) so an older
  // client that never sends these fields keeps today's behavior unchanged.
  const useBooknlp = form.get("use_booknlp") !== "false";
  const useAnnotate = form.get("use_annotate") !== "false";

  const bytes = await file.arrayBuffer();
  await env.VAE_PACKS.put(`uploads/${jobId}.epub`, bytes, {
    httpMetadata: { contentType: "application/epub+zip" },
  });
  await env.VAE_PACKS.put(`uploads/${bookId}.epub`, bytes, {
    httpMetadata: { contentType: "application/epub+zip" },
  });

  // Drop stale playback + checkpoint from a prior ingest of the same book id
  // so failures/re-uploads don't keep serving old JSON or wrongly "resume" a
  // checkpoint that belongs to a different EPUB.
  await env.VAE_PACKS.delete(`books/${bookId}.json`).catch(() => {});
  await env.VAE_PACKS.delete(`books/${bookId}.analysis.json`).catch(() => {});
  await env.VAE_PACKS.delete(`books/${bookId}/checkpoint.json`).catch(() => {});
  // Also drop any raw-extraction cache / compiled chapter packs from a prior
  // attempt — otherwise a fresh ingest could silently reuse stale per-chapter
  // results (see book-checkpoint.js's raw-chapter-extract cache) instead of
  // actually re-extracting from this upload.
  await deleteR2Prefix(env, `books/${bookId}/chapters/`).catch(() => {});

  if (!preferProvider) {
    try {
      const maxChars = parseInt(env.VAE_EPUB_MAX_CHARS || "800000", 10) || 800000;
      const parsed = extractEpubText(bytes, { maxChars });
      preferProvider = await defaultProviderForSize(parsed.chapters?.length || 0, env);
    } catch {
      // Leave unset (null) rather than hardcoding a guess — a caught
      // exception here means something else broke (e.g. extractEpubText
      // itself), and pinning to a provider that might be disabled would
      // reintroduce the exact silent-stall bug this function exists to fix.
      // freemium-extract.js's own unpinned fallback chain takes it from here.
      preferProvider = null;
    }
  }

  const job = {
    job_id: jobId,
    book_id: bookId,
    status: "queued",
    progress: 0,
    detail: "queued on Cloudflare",
    stage: "queued",
    art_style: artStyle,
    created_at: now,
    updated_at: now,
  };
  await putJob(env, "ingest", jobId, job);
  await emitJobEvent(env, jobId, jobToEvent(job, "queued"));

  await putBookIndex(env, bookId, {
    book_id: bookId,
    // putBookIndex merges, not replaces — when attaching to an existing
    // book_id, omit title/author entirely (unless explicitly overridden) so
    // the book's current catalog title survives instead of being clobbered
    // by this epub's filename.
    ...(existingBookId && !titleOverride ? {} : { title: titleOverride || name.replace(/\.epub$/i, "") }),
    ...(existingBookId ? {} : { author: "" }),
    status: "processing",
    stage: "queued",
    progress: 0,
    job_id: jobId,
    active_job_id: jobId,
    art_style: artStyle,
  });

  const msg = {
    kind: "ingest",
    job_id: jobId,
    book_id: bookId,
    art_style: artStyle,
    narrator_gender: narratorGender,
    dry_run: dryRun,
    generate_art: generateArt,
    generate_expressive_sprites: generateExpressiveSprites,
    byo_mode: byoMode,
    illustration_mode: illustrationMode,
    prefer_provider: preferProvider,
    use_booknlp: useBooknlp,
    use_annotate: useAnnotate,
  };

  if (env.VAE_JOBS_QUEUE) {
    await env.VAE_JOBS_QUEUE.send(msg);
  } else if (ctx?.waitUntil) {
    ctx.waitUntil((async () => {
      const { handleIngestMessage } = await import("../../queue/ingest-consumer.js");
      await handleIngestMessage({ body: msg, ack: () => {}, retry: () => {} }, env);
    })());
  }

  return json({ job_id: jobId, book_id: bookId, status: "queued", prefer_provider: preferProvider });
}

/** GET /ingest/:job_id */
export async function onIngestStatusGet({ env, jobId }) {
  if (!edgeIngestEnabled(env)) return null;
  const job = await getJob(env, "ingest", jobId);
  if (!job) return json({ error: "no such job" }, 404);
  return json({
    job_id: jobId,
    book_id: job.book_id,
    status: job.status,
    stage: job.stage || job.status,
    progress: job.progress ?? 0,
    detail: job.detail || "",
    phase: job.phase || null,
    phase_label: job.phase_label || null,
    step: job.step || null,
    step_index: job.step_index ?? null,
    step_total: job.step_total ?? null,
    progress_meta: job.progress_meta || null,
    log: job.log || [],
    debug_log: job.debug_log || [],
    banners: [],
  });
}
