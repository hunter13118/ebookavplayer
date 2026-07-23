import { putJob, putBookIndex, json } from "../../_shared/jobs-kv.js";
import { emitJobEvent, jobToEvent } from "../../_shared/job-events.js";

function edgeJobsEnabled(env) {
  return Boolean(env.VAE_PACKS && env.VAE_JOBS && env.VAE_JOBS_QUEUE);
}

/**
 * POST /books/:id/ingest-text — the M4B-first "formal extraction" trigger
 * (docs/M4B_FIRST_FLOW.md). Unlike POST /ingest (uploads an EPUB; the server
 * derives book_id), the book_id here is CLIENT-SUPPLIED and already exists as
 * a local-only pack — the M4B-first transcript + shared audio, installed
 * entirely client-side (web/src/offline/m4bFirstBooks.js) the moment
 * transcription starts, no server round-trip needed for that part. This
 * route runs the SAME extraction the epub re-extract path uses
 * (runBookExtractPipeline + compilePlayback, see
 * worker/queue/ingest-text-consumer.js) over the caller's own `body_text`
 * (the STT transcript) instead of parsed EPUB bytes. Once it completes, the
 * local pack's book_id "upgrades" in place — fetchBook() already prefers a
 * matching REMOTE book the moment one exists over the local pack fallback
 * (see web/src/offline/bookSource.js).
 *
 * No imaging here — mirrors a dry-run/BYO epub ingest (text + structure
 * only). Art can be generated afterward via the normal ArtStyleSwitcher UI,
 * same as any other dry-run book.
 */
export async function onIngestTextPost({ request, env, bookId }) {
  if (!edgeJobsEnabled(env)) return null;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "expected JSON body" }, 400);
  }

  const bodyText = String(body?.body_text || "").trim();
  if (!bodyText) return json({ error: "missing body_text" }, 400);
  const title = String(body?.title || bookId).slice(0, 200);
  const artStyle = String(body?.art_style || "anime");

  // Stored in R2, not the queue message — a full book's transcript can
  // easily exceed Cloudflare Queues' 128KB per-message limit. The consumer
  // reads it back, same pattern as EPUB bytes for the normal ingest path.
  await env.VAE_PACKS.put(`books/${bookId}/m4b-transcript.txt`, bodyText, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });

  const jobId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const job = {
    job_id: jobId,
    book_id: bookId,
    kind: "ingest-text",
    status: "queued",
    progress: 0,
    detail: "queued",
    stage: "queued",
  };
  await putJob(env, "ingest", jobId, job);
  await emitJobEvent(env, jobId, jobToEvent(job, "queued"));

  await putBookIndex(env, bookId, {
    book_id: bookId,
    title,
    author: "",
    status: "processing",
    stage: "queued",
    progress: 0,
    // putBookIndex merges, not replaces — clear any stale error/detail a
    // prior attempt on this book_id left behind.
    error: "",
    detail: "Queued for formal extraction",
    job_id: jobId,
    active_job_id: jobId,
    art_style: artStyle,
  });

  await env.VAE_JOBS_QUEUE.send({
    kind: "ingest-text",
    job_id: jobId,
    book_id: bookId,
    title,
    art_style: artStyle,
  });

  return json({ job_id: jobId, book_id: bookId, status: "queued" });
}
