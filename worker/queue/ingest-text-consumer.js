import { runBookExtractPipeline } from "../_shared/book-extract-pipeline.js";
import { putBookIndex } from "../_shared/jobs-kv.js";
import { touchIngestJob } from "../_shared/job-touch.js";
import { createKvReporter } from "../_shared/job-kv-throttle.js";
import { createPhaseLogger, PHASE } from "../_shared/phase-debug.js";

/**
 * The M4B-first "formal extraction" consumer (docs/M4B_FIRST_FLOW.md). Runs
 * the SAME extract pipeline the epub re-extract path uses
 * (re-extract-consumer.js's pattern: runBookExtractPipeline + compilePlayback)
 * over a raw transcript instead of parsed EPUB bytes — no chapters, no epub
 * structure, just plain text; freemiumExtractBook already falls back to
 * character-count chunking when chapter markers aren't found, so this needs
 * no special-casing there.
 *
 * No imaging — mirrors a dry-run epub ingest. The local M4B-first pack this
 * book started as already has real audio (the attached .m4b) and readable
 * text; this pass only adds scenes/characters/dialogue attribution so the
 * book can graduate to cinematic/spotlight view. Art generation stays a
 * separate, on-demand action via the normal ArtStyleSwitcher, same as any
 * other dry-run/BYO book.
 */
export async function handleIngestTextMessage(message, env) {
  const { job_id, book_id, title, art_style } = message.body;
  const dbg = createPhaseLogger(env, "ingest-text", job_id);
  const reporter = createKvReporter();

  async function report(patch, opts = {}) {
    await reporter.maybeReport(patch, async () => {
      await touchIngestJob(env, job_id, patch, { dbg, ...opts });
    }, opts);
  }

  try {
    await touchIngestJob(env, job_id, {
      status: "processing",
      stage: "analyzing",
      progress: 0.05,
      detail: "Loading transcript",
    }, { eventType: "started", dbg });

    const obj = await env.VAE_PACKS.get(`books/${book_id}/m4b-transcript.txt`);
    if (!obj) throw new Error("transcript not found — re-upload the .m4b");
    const bodyText = await obj.text();
    const author = "";

    dbg.log(PHASE.P2_EXTRACT, "start", { chars: bodyText.length });
    await touchIngestJob(env, job_id, { progress: 0.1, detail: "Extracting scenes & characters" }, { dbg });

    const { analysis, provider } = await runBookExtractPipeline(
      { book_id, title, author, body_text: bodyText, text_source: "m4b_transcript" },
      {
        env,
        preferProvider: null,
        // freemiumExtractBook calls this directly as onProgress({chunk,total,
        // provider}) — a plain function, NOT an { extract: fn } object (that
        // shape is only for attributeAnalysisLLM's separate onProgress.attribute
        // hook inside runBookExtractPipeline). Passing the wrong shape here
        // doesn't warn — it throws "onProgress is not a function" the moment
        // the first chunk finishes, killing the whole job.
        onProgress: ({ chunk, total, provider: p }) => {
          report({
            progress: 0.1 + (0.7 * chunk) / Math.max(total, 1),
            detail: `Extract chunk ${chunk}/${total}${p ? ` (${p})` : ""}`,
          }, { eventType: p ? "provider" : "progress", provider: p, dbg, force: Boolean(p) }).catch(() => {});
        },
      },
    );

    await env.VAE_PACKS.put(
      `books/${book_id}.analysis.json`,
      JSON.stringify(analysis, null, 2),
      { httpMetadata: { contentType: "application/json" } },
    );

    const { compilePlayback } = await import("../_shared/compile-playback.js");
    const playback = compilePlayback(analysis, { art_style, narrator_gender: "male" });
    playback.status = "ready";
    playback.stage = "done";
    playback.progress = 1;

    await env.VAE_PACKS.put(
      `books/${book_id}.json`,
      JSON.stringify(playback, null, 2),
      { httpMetadata: { contentType: "application/json" } },
    );

    const lines = (playback.scenes || []).reduce((n, s) => n + (s.lines?.length || 0), 0);
    await putBookIndex(env, book_id, {
      book_id,
      title: playback.title || title,
      author: playback.author || author,
      status: "ready",
      stage: "done",
      progress: 1,
      scenes: playback.scenes?.length || 0,
      lines,
      art_style,
      // putBookIndex merges, it doesn't replace — clear any stale error/detail
      // an earlier failed attempt on this book_id left behind (e.g. an
      // unrelated imaging-lock message from before this book_id was reused).
      error: "",
      detail: `Formal extraction complete (${provider})`,
      extract_provider: provider,
      imaging_locked: false,
      active_job_id: null,
    });

    await dbg.flush((patch) => touchIngestJob(env, job_id, patch, { eventType: "done", dbg }), {
      status: "done",
      stage: "done",
      progress: 1,
      detail: `Formal extraction complete (${provider})`,
      book_id,
      extract_provider: provider,
    });
    message.ack();
  } catch (e) {
    console.error("ingest-text consumer", job_id, e);
    await touchIngestJob(env, job_id, {
      status: "error",
      stage: "error",
      progress: 0,
      detail: String(e.message || e).slice(0, 300),
      error: String(e.message || e).slice(0, 300),
    }, { eventType: "error", dbg });
    await putBookIndex(env, book_id, {
      book_id,
      status: "error",
      stage: "error",
      active_job_id: null,
      imaging_locked: false,
      error: String(e.message || e).slice(0, 200),
    }).catch(() => {});
    message.retry();
  }
}
