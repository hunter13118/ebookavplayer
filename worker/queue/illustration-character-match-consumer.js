import { putBookIndex } from "../_shared/jobs-kv.js";
import { touchIngestJob } from "../_shared/job-touch.js";
import { loadStoredEpubBytes } from "../_shared/book-extract-pipeline.js";
import { extractEpubText } from "../_shared/epub-text.js";
import { extractEpubImages } from "../_shared/epub-images.js";
import { matchIllustrationsToChapters } from "../_shared/chapter-extract-pipeline.js";
import { matchPlatesToCharacters } from "../_shared/illustration-character-match.js";
import { applyIllustrationRefsPatch, syncIllustrationRefsToPlayback } from "../_shared/illustration-refs.js";
import { applyDirectIllustrations } from "../_shared/illustrations.js";
import { createPhaseLogger, PHASE } from "../_shared/phase-debug.js";

/** Manual, on-demand "figure out who's in each EPUB plate" pass — the
 * targeted LLM read docs/TODO_ILLUSTRATIONS_PROFILES_POLISH.md item 2 asked
 * for. Re-parses the stored EPUB to recover plate text-context + spine
 * order (cheap, no LLM), matches plates to chapters exactly like the
 * inline extraction pass does, then asks a small LLM call per chapter which
 * known character (if any) each nearby plate depicts. Confirmed matches are
 * applied via the same illustration-refs + applyDirectIllustrations path a
 * manual assignment in Character settings uses — so a successful match
 * shows up immediately as that character's sprite. */
export async function handleIllustrationCharacterMatchMessage(message, env) {
  const { job_id, book_id, opts = {} } = message.body;
  const dbg = createPhaseLogger(env, "illustration-character-match", job_id);

  try {
    await touchIngestJob(env, job_id, {
      status: "processing", stage: "matching", progress: 0.05, detail: "Loading book",
    }, { eventType: "started", dbg });

    const axObj = await env.VAE_PACKS.get(`books/${book_id}.analysis.json`);
    if (!axObj) throw new Error("no analysis — extract first");
    const analysis = await axObj.json();

    const bytes = await loadStoredEpubBytes(env, book_id);
    if (!bytes) throw new Error("EPUB not found — re-upload the book first");

    const parsed = extractEpubText(bytes);
    const epubExtract = extractEpubImages(bytes, {});
    const illustrationsByChapterPos = matchIllustrationsToChapters(
      parsed.orderedPaths, parsed.chapters, epubExtract.imageMeta,
    );

    const platesConsidered = [...illustrationsByChapterPos.values()].reduce((n, arr) => n + arr.length, 0);
    if (!platesConsidered) {
      await touchIngestJob(env, job_id, {
        status: "done", stage: "done", progress: 1, detail: "No plates to match against known chapters",
      }, { eventType: "done", dbg });
      message.ack();
      return;
    }

    await touchIngestJob(env, job_id, {
      status: "processing", stage: "matching", progress: 0.15,
      detail: `Matching ${platesConsidered} plate(s) to characters`,
    }, { eventType: "progress", dbg });

    const matches = await matchPlatesToCharacters(illustrationsByChapterPos, analysis.characters, parsed.chapters, {
      env, preferProvider: opts.prefer_provider || null,
    });
    dbg.log(PHASE.P2_EXTRACT, "matches", { count: matches.size });

    if (!matches.size) {
      await touchIngestJob(env, job_id, {
        status: "done", stage: "done", progress: 1,
        detail: `Checked ${platesConsidered} plate(s) — none confidently matched a character`,
      }, { eventType: "done", dbg });
      message.ack();
      return;
    }

    const characterPatch = {};
    for (const [plateIdx, charId] of matches) characterPatch[charId] = plateIdx;

    const patched = applyIllustrationRefsPatch(analysis, { characters: characterPatch });
    await env.VAE_PACKS.put(
      `books/${book_id}.analysis.json`,
      JSON.stringify(patched, null, 2),
      { httpMetadata: { contentType: "application/json" } },
    );

    const pbObj = await env.VAE_PACKS.get(`books/${book_id}.json`);
    if (pbObj) {
      let playback = await pbObj.json();
      playback = syncIllustrationRefsToPlayback(playback, patched);
      ({ playback } = applyDirectIllustrations(playback, patched, patched.illustration_urls || {}));
      await env.VAE_PACKS.put(
        `books/${book_id}.json`,
        JSON.stringify(playback, null, 2),
        { httpMetadata: { contentType: "application/json" } },
      );
    }

    await putBookIndex(env, book_id, { active_job_id: null });
    await dbg.flush((patch) => touchIngestJob(env, job_id, patch, { eventType: "done", dbg }), {
      status: "done",
      stage: "done",
      progress: 1,
      detail: `Matched ${matches.size} of ${platesConsidered} plate(s) to a character`,
      book_id,
      matched_characters: [...matches.values()],
    });
    message.ack();
  } catch (e) {
    console.error("illustration character match", job_id, e);
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
