import { putBookIndex } from "../_shared/jobs-kv.js";
import { touchIngestJob } from "../_shared/job-touch.js";
import { runExpressionRepass } from "../_shared/expression-repass.js";
import { createPhaseLogger, PHASE } from "../_shared/phase-debug.js";

// Scenes per runExpressionRepass call — bounds each LLM call's line count
// (a whole book's scenes in one call could be thousands of lines, well past
// any provider's comfortable context). Matches the automatic per-chapter
// pass's granularity (a chapter is typically well under this many scenes),
// just applied in fixed-size batches across the whole book instead of one
// chapter at a time.
const SCENES_PER_BATCH = 8;

function temperamentByCharacterFrom(playback) {
  const out = {};
  for (const [id, c] of Object.entries(playback?.characters || {})) {
    if (c?.temperament) out[id] = c.temperament;
  }
  return out;
}

/** Manual, on-demand "re-run expression tagging over the whole book right
 * now" pass — independent of whether the automatic per-chapter trigger
 * (VAE_EXPRESSION_REPASS / auditExpressionFlatness) fired during extraction.
 * See docs/TODO_ILLUSTRATIONS_PROFILES_POLISH.md item 5. */
export async function handleExpressionRepassMessage(message, env) {
  const { job_id, book_id, opts = {} } = message.body;
  const dbg = createPhaseLogger(env, "expression-repass", job_id);

  try {
    await touchIngestJob(env, job_id, {
      status: "processing", stage: "expression-repass", progress: 0.02, detail: "Loading book",
    }, { eventType: "started", dbg });

    const pbObj = await env.VAE_PACKS.get(`books/${book_id}.json`);
    if (!pbObj) throw new Error("no compiled book — extract first");
    const playback = await pbObj.json();

    const scenes = playback.scenes || [];
    const temperamentByCharacter = temperamentByCharacterFrom(playback);
    const preferProvider = opts.prefer_provider || null;

    const nextScenes = [];
    const totalBatches = Math.max(1, Math.ceil(scenes.length / SCENES_PER_BATCH));
    for (let i = 0; i < scenes.length; i += SCENES_PER_BATCH) {
      const batchIndex = Math.floor(i / SCENES_PER_BATCH) + 1;
      const batch = scenes.slice(i, i + SCENES_PER_BATCH);
      dbg.log(PHASE.P2_EXTRACT, "expression repass batch", { batchIndex, totalBatches });
      // Best-effort per batch — one bad batch shouldn't lose the whole
      // book's re-tag, same "never fail the chapter" spirit as the
      // automatic pass.
      let repassed = batch;
      try {
        repassed = await runExpressionRepass(batch, { env, preferProvider, temperamentByCharacter });
      } catch (e) {
        dbg.log(PHASE.P2_EXTRACT, "expression repass batch failed (non-fatal, keeping original tags)", {
          batchIndex, error: e.message || String(e),
        });
      }
      nextScenes.push(...repassed);

      await touchIngestJob(env, job_id, {
        status: "processing",
        stage: "expression-repass",
        progress: Math.min(0.95, batchIndex / totalBatches),
        detail: `Re-tagging scenes ${batchIndex}/${totalBatches}`,
      }, { eventType: "progress", dbg });
    }

    playback.scenes = nextScenes;
    await env.VAE_PACKS.put(
      `books/${book_id}.json`,
      JSON.stringify(playback, null, 2),
      { httpMetadata: { contentType: "application/json" } },
    );

    await putBookIndex(env, book_id, { active_job_id: null });
    await dbg.flush((patch) => touchIngestJob(env, job_id, patch, { eventType: "done", dbg }), {
      status: "done",
      stage: "done",
      progress: 1,
      detail: `Expression re-tag complete · ${scenes.length} scene(s)`,
      book_id,
    });
    message.ack();
  } catch (e) {
    console.error("expression repass", job_id, e);
    await touchIngestJob(env, job_id, {
      status: "error",
      stage: "error",
      progress: 0,
      detail: String(e.message || e).slice(0, 300),
      error: String(e.message || e).slice(0, 300),
    }, { eventType: "error", dbg });
    await putBookIndex(env, book_id, { active_job_id: null }).catch(() => {});
    message.ack();
  }
}
