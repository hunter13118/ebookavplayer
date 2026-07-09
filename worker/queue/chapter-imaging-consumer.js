/**
 * Parallel per-chapter imaging (see chapter-extract-pipeline.js's file
 * header and the enqueue in onChapterComplete). Runs on a separate queue
 * (VAE_IMAGING_QUEUE / "vae-imaging") from ingest/continue-extract, so
 * Cloudflare Queues can process it concurrently with a still-running
 * extraction job instead of queuing behind it — that's the whole point.
 *
 * Generates art for just this chapter's new characters/scenes and writes
 * the result back into that chapter's own pack (books/{id}/chapters/{pos}.json)
 * — never the shared merged books/{id}.json playback, which the still-running
 * extraction loop keeps overwriting wholesale from its own in-memory state on
 * every chapter completion. Writing to this chapter's own pack file has no
 * concurrent writer once the chapter's initial putChapterPack call (in
 * chapter-extract-pipeline.js) has happened, so there's no read-modify-write
 * race to worry about. The whole-book finalization phase picks all of this
 * back up via existingMediaFromChapterPacks once every chapter's text is
 * done, reusing whatever's already here instead of regenerating it.
 */
import { getChapterPack, putChapterPack } from "../_shared/book-checkpoint.js";
import { runEdgeImaging, existingMediaFromChapterPacks } from "../_shared/edge-imaging.js";
import { createPhaseLogger, PHASE } from "../_shared/phase-debug.js";

/**
 * Pure merge step, split out so it's testable without invoking
 * runEdgeImaging (real network calls to image providers). Mutates and
 * returns `pack`; `changed` tells the caller whether a write is worth it.
 */
export function mergeMediaIntoPack(pack, media) {
  let changed = false;
  for (const [id, url] of Object.entries(media?.characters || {})) {
    if (pack.characters?.[id] && pack.characters[id].sprite !== url) {
      pack.characters[id] = { ...pack.characters[id], sprite: url };
      changed = true;
    }
  }
  for (const [id, sprites] of Object.entries(media?.expressionSprites || {})) {
    if (pack.characters?.[id]) {
      pack.characters[id] = { ...pack.characters[id], expressionSprites: sprites };
      changed = true;
    }
  }
  for (const scene of pack.scenes || []) {
    const bgUrl = media?.backgrounds?.[scene.id];
    if (bgUrl && scene.background !== bgUrl) {
      scene.background = bgUrl;
      changed = true;
    }
  }
  return { pack, changed };
}

export async function handleChapterImagingMessage(message, env) {
  const {
    book_id, chapterPos, art_style, narrator_gender,
    generate_expressive_sprites, new_character_ids = [], scene_ids = [],
    job_id,
  } = message.body || {};
  if (!book_id || chapterPos == null) return;
  if (!new_character_ids.length && !scene_ids.length) return;

  const dbg = createPhaseLogger(env, "chapter-imaging", job_id || `${book_id}:${chapterPos}`);

  const pack = await getChapterPack(env, book_id, chapterPos);
  if (!pack) {
    dbg.log(PHASE.P3_IMAGES, "chapter pack missing — skipping (whole-book phase is the fallback)", { chapterPos });
    return;
  }

  // Reuse whatever earlier chapters already generated (a recurring
  // character shouldn't get a fresh design every time they reappear).
  const priorChapterPositions = Array.from({ length: chapterPos }, (_, i) => i);
  const existingMedia = await existingMediaFromChapterPacks(env, book_id, priorChapterPositions);

  const analysis = {
    book_id,
    characters: Object.entries(pack.characters || {}).map(([id, c]) => ({ id, ...c })),
    scenes: pack.scenes || [],
  };

  let img;
  try {
    img = await runEdgeImaging({
      env,
      book_id,
      analysis,
      art_style,
      narrator_gender,
      dbg,
      existingMedia,
      filter: { scope: "custom", character_ids: new_character_ids, scene_ids, include_cover: false },
      generateExpressiveSprites: Boolean(generate_expressive_sprites),
    });
  } catch (e) {
    // Best-effort — the whole-book finalization phase generates anything
    // still missing once extraction finishes, exactly as it always has.
    dbg.log(PHASE.P3_IMAGES, "chapter imaging failed (non-fatal, final phase covers it)", {
      chapterPos, error: e.message || String(e),
    });
    return;
  }

  const { changed } = mergeMediaIntoPack(pack, img.media || {});
  if (changed) await putChapterPack(env, book_id, chapterPos, pack);
  dbg.log(PHASE.P3_IMAGES, "chapter imaging done", {
    chapterPos, ok: img.stats?.ok ?? 0, fail: img.stats?.fail ?? 0, stock: img.stats?.stock ?? 0,
  });
}
