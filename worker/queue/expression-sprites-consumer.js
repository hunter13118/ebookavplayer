import { putBookIndex, getJob } from "../_shared/jobs-kv.js";
import { touchIngestJob } from "../_shared/job-touch.js";
import { createPhaseLogger, PHASE } from "../_shared/phase-debug.js";
import { generateExpressionSpritesForCharacter } from "../_shared/edge-imaging.js";
import { r2MediaKey } from "../_shared/freemium-image.js";
import { normalizeExpressionBucket } from "../_shared/expression-bucket.js";
import { isJobCancelled } from "../_shared/imaging-lock.js";

const RETRY_DELAY_SECONDS = 30;

/**
 * Claim the imaging_locked/active_job_id lock for this job, or report that
 * something else still holds it. Both API-layer callers (onExpressionSpriteRegenPost,
 * onMediaCommitPost's backfill) enqueue unconditionally and don't touch the
 * lock themselves — confirming several staged characters back-to-back must
 * queue each one's backfill, not drop the 2nd/3rd because the 1st is still
 * running. This is the actual serialization point: if another job's lock
 * is still genuinely active, the caller retries later instead of racing a
 * concurrent read-modify-write of books/{id}.json.
 */
async function tryAcquireLock(env, book_id, job_id, detail) {
  const raw = await env.VAE_JOBS?.get(`book:${book_id}`);
  const meta = raw ? JSON.parse(raw) : {};
  const otherId = meta.active_job_id;
  if (otherId && otherId !== job_id) {
    const otherJob = await getJob(env, "ingest", otherId);
    const otherStillActive = otherJob && otherJob.status !== "done" && otherJob.status !== "error";
    if (otherStillActive) return false;
    // The other job is done/errored but the book's lock never got cleared
    // (e.g. a crash) — self-heal by just taking it instead of retrying
    // forever against a lock nothing will ever release.
  }
  await putBookIndex(env, book_id, {
    imaging_locked: true,
    active_job_id: job_id,
    status: "processing",
    stage: "expression-sprites",
    progress: 0,
    detail,
  });
  return true;
}

/**
 * Generate (or regenerate) alt-expression portrait sprites for ONE primary
 * character. Two callers:
 * - onMediaCommitPost's backfill (no `buckets` in the message): a staged
 *   (compare-mode) regen skips runEdgeImaging's inline expression-sprite
 *   generation (it requires the base sprite to be `promoted`, i.e. not
 *   staged), so this is the only later point that knows the sprite is now
 *   live and can generate the missing variants — defaults to all of
 *   DEFAULT_EXPRESSIVE_BUCKETS.
 * - onExpressionSpriteRegenPost (`buckets: [oneBucket]` or all of them): an
 *   explicit "redo this expression (or all of them)" request.
 * Takes the same imaging_locked/active_job_id lock every other
 * art-generation job takes, right here (not at enqueue time — see
 * tryAcquireLock), and releases it on the way out, success or error, same
 * as imaging-regen-consumer.js. That lock is also what makes the job show
 * up in the Library's "Processing" queue (IngestActivity.jsx /
 * Library.jsx's catalogActiveJobs) — this used to run with no queue
 * visibility at all.
 */
export async function handleExpressionSpritesMessage(message, env) {
  const { job_id, book_id, character_id, art_style, buckets } = message.body;
  const dbg = createPhaseLogger(env, "expression-sprites", job_id);

  const gotLock = await tryAcquireLock(env, book_id, job_id, `Regenerating ${character_id}'s expression art…`);
  if (!gotLock) {
    message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
    return;
  }

  try {
    await touchIngestJob(env, job_id, {
      status: "processing",
      stage: "expression-sprites",
      progress: 0.05,
      detail: `Loading ${character_id}`,
    }, { eventType: "started", dbg });

    const pbObj = await env.VAE_PACKS.get(`books/${book_id}.json`);
    if (!pbObj) throw new Error("no compiled book — extract first");
    const playback = await pbObj.json();
    const character = playback.characters?.[character_id];
    if (!character) throw new Error(`unknown character ${character_id}`);

    const baseObj = await env.VAE_PACKS.get(r2MediaKey(book_id, art_style, `char_${character_id}.png`));
    if (!baseObj) throw new Error(`no live sprite for ${character_id} — commit the base portrait first`);
    const baseImageBytes = new Uint8Array(await baseObj.arrayBuffer());

    dbg.log(PHASE.P3_IMAGES, "expression sprite generation start", { character_id, art_style, buckets });

    const { sprites, ok, fail, cancelled } = await generateExpressionSpritesForCharacter({
      env,
      book_id,
      art_style,
      character: { ...character, id: character_id },
      baseImageBytes,
      dbg,
      ...(Array.isArray(buckets) && buckets.length ? { expressiveBuckets: buckets } : {}),
      onProgress: ({ id }) => {
        touchIngestJob(env, job_id, { detail: `Generating ${id}` }, { dbg }).catch(() => {});
      },
      checkCancelled: () => isJobCancelled(env, job_id),
    });

    if (Object.keys(sprites).length) {
      character.expressionSprites = { ...(character.expressionSprites || {}), ...sprites };
      for (const scene of playback.scenes || []) {
        for (const line of scene.lines || []) {
          if (line.character_id !== character_id) continue;
          const bucket = normalizeExpressionBucket(line.expression);
          if (sprites[bucket]) line.sprite_url = sprites[bucket];
        }
      }
      await env.VAE_PACKS.put(
        `books/${book_id}.json`,
        JSON.stringify(playback, null, 2),
        { httpMetadata: { contentType: "application/json" } },
      );
    }

    const doneDetail = cancelled
      ? `Expression art cancelled · ${ok} ok before stopping`
      : `Expression art ready · ${ok} ok${fail ? `, ${fail} failed` : ""}`;
    await putBookIndex(env, book_id, {
      imaging_locked: false,
      active_job_id: null,
      status: "ready",
      stage: "done",
      progress: 1,
      detail: doneDetail,
    });
    await dbg.flush((patch) => touchIngestJob(env, job_id, patch, { eventType: "done", dbg }), {
      status: "done",
      stage: "done",
      progress: 1,
      detail: doneDetail,
      book_id,
    });
    message.ack();
  } catch (e) {
    console.error("expression sprites", job_id, e);
    const errDetail = String(e.message || e).slice(0, 300);
    await touchIngestJob(env, job_id, {
      status: "error",
      stage: "error",
      progress: 0,
      detail: errDetail,
      error: errDetail,
    }, { eventType: "error", dbg });
    await putBookIndex(env, book_id, {
      imaging_locked: false,
      active_job_id: null,
      status: "ready",
      stage: "done",
      progress: 1,
      detail: errDetail,
      error: errDetail,
    }).catch(() => {});
    message.ack();
  }
}
