import { touchIngestJob } from "../_shared/job-touch.js";
import { createPhaseLogger, PHASE } from "../_shared/phase-debug.js";
import { generateExpressionSpritesForCharacter } from "../_shared/edge-imaging.js";
import { r2MediaKey } from "../_shared/freemium-image.js";
import { normalizeExpressionBucket } from "../_shared/expression-bucket.js";
import { isJobCancelled } from "../_shared/imaging-lock.js";

/**
 * Generate (or regenerate) alt-expression portrait sprites for ONE primary
 * character. Two callers:
 * - onMediaCommitPost's backfill (no `buckets` in the message): a staged
 *   (compare-mode) regen skips runEdgeImaging's inline expression-sprite
 *   generation (it requires the base sprite to be `promoted`, i.e. not
 *   staged), so this is the only later point that knows the sprite is now
 *   live and can generate the missing variants — defaults to all of
 *   DEFAULT_EXPRESSIVE_BUCKETS.
 * - onExpressionSpriteRegenPost (`buckets: [oneBucket]`): an explicit
 *   "redo just this one expression" request — there's no bulk "redo all"
 *   equivalent by design, same cost-gate as the rest of this feature.
 * Independent of the main imaging lock either way — this is a best-effort
 * enhancement, not required for the book to be playable.
 */
export async function handleExpressionSpritesMessage(message, env) {
  const { job_id, book_id, character_id, art_style, buckets } = message.body;
  const dbg = createPhaseLogger(env, "expression-sprites", job_id);

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

    await dbg.flush((patch) => touchIngestJob(env, job_id, patch, { eventType: "done", dbg }), {
      status: "done",
      stage: "done",
      progress: 1,
      detail: cancelled
        ? `Expression art cancelled · ${ok} ok before stopping`
        : `Expression art ready · ${ok} ok${fail ? `, ${fail} failed` : ""}`,
      book_id,
    });
    message.ack();
  } catch (e) {
    console.error("expression sprites", job_id, e);
    await touchIngestJob(env, job_id, {
      status: "error",
      stage: "error",
      progress: 0,
      detail: String(e.message || e).slice(0, 300),
      error: String(e.message || e).slice(0, 300),
    }, { eventType: "error", dbg });
    message.ack();
  }
}
