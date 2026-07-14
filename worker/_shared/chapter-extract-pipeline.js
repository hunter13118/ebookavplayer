/**
 * Shared per-chapter checkpointed extraction pipeline — used by both a fresh
 * ingest job (worker/queue/ingest-consumer.js) and a "continue extraction"
 * resume job (worker/queue/continue-extract-consumer.js).
 *
 * Reads any existing books/{id}/checkpoint.json, extracts remaining chapters
 * one at a time (extract -> repair -> attribute -> compile -> persist), and
 * on a chapter's provider chain being fully exhausted, stops cleanly and
 * returns { status: "partial", ... } instead of throwing — whatever chapters
 * already checkpointed stay readable via GET /books/:id. Only throws for
 * genuine bugs/infra errors (missing upload, R2 failure, etc.), which the
 * caller should treat as retryable exactly like today's whole-book path.
 *
 * Once every chapter succeeds, runs image generation exactly as the legacy
 * whole-book path did — except now seeded with existingMediaFromChapterPacks
 * (see below), so anything VAE_PARALLEL_IMAGING already generated per-chapter
 * while later chapters were still extracting gets reused here instead of
 * regenerated. See docs/LOCAL_LLM_EXTRACTION.md's "Parallel per-chapter
 * imaging" section and worker/queue/chapter-imaging-consumer.js.
 */
import { extractEpubText } from "./epub-text.js";
import { extractEpubImages } from "./epub-images.js";
import { persistEpubImages } from "./reference-images.js";
import { loadStoredEpubBytes } from "./book-extract-pipeline.js";
import { freemiumExtractBookByChapter } from "./freemium-extract.js";
import { repairAnalysis } from "./dialogue-repair.js";
import { attributeAnalysis } from "./dialogue-attribute.js";
import { runExpressionRepass, auditExpressionFlatness, isExpressionRepassEnabled } from "./expression-repass.js";
import { compileChapterPlayback, synthesizeUndeclaredCharacters } from "./compile-playback.js";
import { applyCharacterAliases } from "./character-merge.js";
import {
  getCheckpoint, putCheckpoint, emptyCheckpoint, putChapterPack,
} from "./book-checkpoint.js";
import { putBookIndex } from "./jobs-kv.js";
import { runEdgeImaging, existingMediaFromChapterPacks } from "./edge-imaging.js";
import { countImagingSteps } from "./ingest-progress.js";
import { normalizeIllustrationMode, applyDirectIllustrations } from "./illustrations.js";
import { PHASE } from "./phase-debug.js";
import { isCharacterEnrichEnabled, enrichCharacters, mergeEnrichmentIntoCharacter } from "./character-enrich.js";

async function readJsonR2(env, key) {
  const obj = await env.VAE_PACKS.get(key);
  if (!obj) return null;
  return JSON.parse(await obj.text());
}

async function writeJsonR2(env, key, data) {
  await env.VAE_PACKS.put(key, JSON.stringify(data, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
}

// Opt-in (default off, matching VAE_EXPRESSION_REPASS/generate_expressive_sprites
// convention) — new, more complex code path (separate queue, its own
// consumer). The fallback when it's off, or the enqueue fails, or the queue
// never gets a turn is simply today's behavior: nothing generates until the
// whole book finishes extracting, then the existing final imaging phase
// runs exactly as before. See docs/LOCAL_LLM_EXTRACTION.md.
function isParallelImagingEnabled(env) {
  return env.VAE_PARALLEL_IMAGING === "true" || env.VAE_PARALLEL_IMAGING === "1";
}

/**
 * Which provider a (re)started extraction run should use. An explicit
 * preferProvider on THIS call is a deliberate override (e.g. resuming with a
 * different model than last time) and must win — checkpoint.provider_used is
 * only the fallback for a plain "just resume" call that didn't ask for
 * anything specific, so it stays consistent with whatever earlier chapters
 * already used instead of restarting the freemium fallback cascade from
 * scratch. Previously inverted (checkpoint always won), which silently
 * ignored any prefer_provider passed to a resume.
 */
export function resolveResumeProvider(preferProvider, checkpoint) {
  return preferProvider || checkpoint?.provider_used || null;
}

/**
 * Matches each extracted illustration plate to the chapter it belongs to, so
 * the extraction prompt can tell the model which illustration index is near
 * the text it's currently reading (see freemium-extract.js's
 * getChapterIllustrations / ILLUSTRATION PLATES prompt section).
 *
 * Exact spine_path equality (the original approach) silently matched almost
 * nothing on real light-novel EPUBs: illustration plates conventionally live
 * on their own dedicated spine pages (`insert1.xhtml`, `Color1.xhtml`,
 * `bonus1.xhtml`, ...) sitting *between* chapter files in the spine, not
 * embedded inside a chapter's own file — confirmed against a real J-Novel
 * Club EPUB where 13 of 14 plates went unmatched this way. Instead, walk the
 * full spine order (`orderedPaths`, includes the plate/front-matter pages
 * `chapters` filters out) and attach each plate to the next real chapter
 * that follows it in spine order — the plate conventionally introduces the
 * chapter it precedes. A plate with no following chapter (back-matter: color
 * inserts, bonus content, sign-up pages) is left unmatched rather than
 * guessed at.
 */
export function matchIllustrationsToChapters(orderedPaths, chapters, imageMeta) {
  const illustrationsByChapterPos = new Map();
  if (!orderedPaths?.length || !chapters?.length || !imageMeta?.length) return illustrationsByChapterPos;

  const chapterPosByPath = new Map(chapters.map((c, pos) => [c.spine_path, pos]));
  const pathIndex = new Map(orderedPaths.map((p, i) => [p, i]));

  for (const meta of imageMeta) {
    if (!meta.sourcePath) continue;
    let chapterPos = chapterPosByPath.get(meta.sourcePath);
    if (chapterPos === undefined) {
      const start = pathIndex.get(meta.sourcePath);
      if (start === undefined) continue;
      for (let i = start + 1; i < orderedPaths.length; i += 1) {
        const pos = chapterPosByPath.get(orderedPaths[i]);
        if (pos !== undefined) { chapterPos = pos; break; }
      }
    }
    if (chapterPos === undefined) continue;
    if (!illustrationsByChapterPos.has(chapterPos)) illustrationsByChapterPos.set(chapterPos, []);
    illustrationsByChapterPos.get(chapterPos).push({ index: meta.index, textContext: meta.textContext });
  }
  return illustrationsByChapterPos;
}

export async function runCheckpointedExtraction({
  env, job_id, book_id, art_style, narrator_gender, illustration_mode,
  dry_run, generate_art, generate_expressive_sprites, byo_mode, prefer_provider, report, dbg,
}) {
  const wantArt = generate_art !== false && !dry_run && !byo_mode;

  dbg.log(PHASE.P1_PARSE, "start");
  await report("parsing", 0, { detail: "Loading EPUB from storage" });

  const bytes = await loadStoredEpubBytes(env, book_id);
  if (!bytes) throw new Error("upload missing from R2");

  const maxChars = parseInt(env.VAE_EPUB_MAX_CHARS || "800000", 10) || 800000;
  const parsed = extractEpubText(bytes, { maxChars });
  const illusCap = parseInt(env.VAE_EPUB_MAX_IMAGES || "0", 10);
  const epubExtract = extractEpubImages(bytes, { maxImages: illusCap > 0 ? illusCap : null });
  const epubImages = epubExtract.images;
  let illustrationUrls = {};
  if (epubImages.length && env.VAE_PACKS) {
    illustrationUrls = await persistEpubImages(env, book_id, epubImages);
  }
  const title = parsed.title || book_id;
  const author = parsed.author || "";
  dbg.log(PHASE.P1_PARSE, "epub parsed", {
    title, chars: parsed.chars, chapters: parsed.chapter_count,
  });
  await report("parsing", 1, { detail: `Parsed ${parsed.chars} chars · ${parsed.chapter_count} chapters` });

  const illustrationsByChapterPos = matchIllustrationsToChapters(
    parsed.orderedPaths, parsed.chapters, epubExtract.imageMeta,
  );

  let checkpoint = await getCheckpoint(env, book_id);
  const isResume = Boolean(checkpoint?.chapters_done?.length);
  if (!checkpoint) checkpoint = emptyCheckpoint(parsed.chapters.length);

  // User-confirmed character merges (e.g. "unnamed-male-protagonist" -> "eizo")
  // persist here so every chapter extracted from now on — resumed or a fresh
  // re-extract alike — lands on the canonical id without relying on the
  // heuristic reconcile to happen to re-match it. See worker/api/v1/characters.js.
  const characterAliases = env.VAE_JOBS
    ? JSON.parse((await env.VAE_JOBS.get(`aliases:${book_id}`)) || "{}")
    : {};

  await putBookIndex(env, book_id, {
    book_id, title, author, status: "processing", stage: "parsing",
    progress: isResume ? checkpoint.chapters_done.length / checkpoint.total_chapters : 0.07,
    job_id, art_style, phase: "parsing", phase_label: "Reading EPUB",
  });

  // Running accumulators — seeded from whatever's already on disk when resuming.
  let knownCharacters = {};
  let mergedScenes = [];
  let mergedAnalysisCharacters = [];
  let mergedAnalysisScenes = [];
  if (isResume) {
    const pb = await readJsonR2(env, `books/${book_id}.json`);
    if (pb) {
      knownCharacters = pb.characters || {};
      mergedScenes = pb.scenes || [];
    }
    const an = await readJsonR2(env, `books/${book_id}.analysis.json`);
    if (an) {
      mergedAnalysisCharacters = an.characters || [];
      mergedAnalysisScenes = an.scenes || [];
    }
  }

  await report("extracting", checkpoint.chapters_done.length / Math.max(checkpoint.total_chapters, 1), {
    detail: isResume
      ? `Resuming at chapter ${checkpoint.next_chapter_idx + 1}/${checkpoint.total_chapters}`
      : "Starting script extraction",
  });

  const { isAttrLlmEnabled, attributeAnalysisLLM } = await import("./dialogue-attribute-llm.js");
  const attrLlmOn = isAttrLlmEnabled(env);

  let provider = resolveResumeProvider(prefer_provider, checkpoint);
  let model = "";
  let stopDetail = null;

  const extractConcurrency = parseInt(env.VAE_EXTRACT_CONCURRENCY ?? "3", 10) || 1;

  dbg.log(PHASE.P2_EXTRACT, "start", {
    startChapterPos: checkpoint.next_chapter_idx,
    totalChapters: checkpoint.total_chapters,
    preferProvider: provider,
    concurrency: extractConcurrency,
  });

  // chapterPos -> latest progress snapshot for chapters currently being
  // extracted concurrently — surfaced to the UI as `workers` so a
  // concurrency > 1 run shows every in-flight chapter, not just whichever
  // onProgress call happened to fire last.
  const inFlightWorkers = new Map();

  try {
    await freemiumExtractBookByChapter(
      { book_id, title, author, chapters: parsed.chapters },
      {
        env,
        preferProvider: provider,
        startChapterPos: checkpoint.next_chapter_idx,
        concurrency: extractConcurrency,
        getKnownCharacters: () => mergedAnalysisCharacters,
        getChapterIllustrations: (chapterPos) => illustrationsByChapterPos.get(chapterPos) || null,
        onProgress: ({
          chapterPos, chapterIndex, chapterTitle, chapterOfTotal, totalChapters, chunk, totalChunks, provider: p,
        }) => {
          inFlightWorkers.set(chapterPos, {
            chapterPos, chapterIndex, chapterTitle, chapterOfTotal, totalChapters, chunk, totalChunks, provider: p,
          });
          report("extracting", chapterOfTotal / Math.max(totalChapters, 1), {
            detail: `Chapter ${chapterOfTotal}/${totalChapters} · chunk ${chunk}/${totalChunks}${p ? ` (${p})` : ""}`,
            step: "extract",
            stepIndex: chapterOfTotal,
            stepTotal: totalChapters,
            sub: { provider: p },
            workers: [...inFlightWorkers.values()].sort((a, b) => a.chapterOfTotal - b.chapterOfTotal),
          }).catch(() => {});
        },
        onChapterComplete: async (chapterPos, chapterAnalysis, meta) => {
          inFlightWorkers.delete(chapterPos);
          provider = meta.provider;
          model = meta.model || model;
          dbg.log(PHASE.P2_EXTRACT, "chapter done", { chapterPos, provider });

          for (const s of chapterAnalysis.scenes || []) s.chapter = chapterAnalysis.chapterIndex;

          let repaired = attributeAnalysis(repairAnalysis(chapterAnalysis));
          if (attrLlmOn) {
            repaired = await attributeAnalysisLLM(repaired, { env, preferProvider: provider });
          }
          repaired = applyCharacterAliases(repaired, characterAliases);

          // Expression Sensitivity Plan Phase 1d/1e/1f: a small, best-effort
          // enhancement pass — never let it fail the chapter. Either always
          // on (VAE_EXPRESSION_REPASS=1) or auto-triggered only when Phase 0's
          // flatness audit flags this specific chapter as suspiciously flat.
          try {
            // Prior chapters' compiled (and possibly user-edited via
            // CharacterManager) temperament wins over this chunk's own
            // re-extraction of an already-known character, since the model
            // rarely re-derives it on a repeat mention — this chapter's own
            // analysis only fills in characters not yet known.
            const temperamentByCharacter = {
              ...Object.fromEntries(
                (repaired.characters || []).filter((c) => c.temperament).map((c) => [c.id, c.temperament]),
              ),
              ...Object.fromEntries(
                Object.entries(knownCharacters).filter(([, c]) => c.temperament).map(([id, c]) => [id, c.temperament]),
              ),
            };
            if (isExpressionRepassEnabled(env)) {
              repaired = {
                ...repaired,
                scenes: await runExpressionRepass(repaired.scenes, { env, temperamentByCharacter }),
              };
            } else {
              const audit = auditExpressionFlatness(repaired.scenes);
              if (audit.suspiciouslyFlat) {
                dbg.log(PHASE.P2_EXTRACT, "expression audit flagged chapter as flat — running focused repass", {
                  chapterPos, ...audit,
                });
                repaired = {
                  ...repaired,
                  scenes: await runExpressionRepass(repaired.scenes, { env, temperamentByCharacter }),
                };
              }
            }
          } catch (e) {
            dbg.log(PHASE.P2_EXTRACT, "expression repass failed (non-fatal, keeping original tags)", {
              chapterPos, error: e.message || String(e),
            });
          }

          const {
            scenes, newCharactersOut, nextLineIdx, updatedVoiceState,
          } = compileChapterPlayback(repaired, {
            art_style,
            narrator_gender,
            voiceState: checkpoint.voice_state,
            knownCharacters,
            startingLineIdx: checkpoint.next_line_idx,
          });

          await putChapterPack(env, book_id, chapterPos, { scenes, characters: newCharactersOut });

          // Parallel imaging (Phase 2, no longer deferred — see file header):
          // enqueue this chapter's new characters/scenes onto a separate
          // queue so art generation can run concurrently with later
          // chapters still extracting, instead of waiting for the whole
          // book. Best-effort — the final imaging phase below is the
          // fallback either way (this queue not existing yet, an enqueue
          // failure, or the local dev queue simulator not giving it a turn
          // all degrade to exactly today's behavior, nothing lost).
          if (wantArt && isParallelImagingEnabled(env) && env.VAE_IMAGING_QUEUE) {
            const newCharacterIds = Object.keys(newCharactersOut || {});
            const sceneIds = scenes.map((s) => s.id);
            if (newCharacterIds.length || sceneIds.length) {
              await env.VAE_IMAGING_QUEUE.send({
                kind: "chapter-imaging",
                job_id,
                book_id,
                chapterPos,
                art_style,
                narrator_gender,
                generate_expressive_sprites: Boolean(generate_expressive_sprites),
                new_character_ids: newCharacterIds,
                scene_ids: sceneIds,
              }).catch((e) => {
                dbg.log(PHASE.P2_EXTRACT, "chapter-imaging enqueue failed (non-fatal)", {
                  chapterPos, error: e.message || String(e),
                });
              });
            }
          }

          knownCharacters = { ...knownCharacters, ...newCharactersOut };
          mergedScenes = [...mergedScenes, ...scenes];
          const seenIds = new Set(mergedAnalysisCharacters.map((c) => c.id));
          mergedAnalysisCharacters = [
            ...mergedAnalysisCharacters,
            ...(repaired.characters || []).filter((c) => c.id && !seenIds.has(c.id)),
          ];
          mergedAnalysisScenes = [...mergedAnalysisScenes, ...(repaired.scenes || [])];

          checkpoint = {
            ...checkpoint,
            chapters_done: [...checkpoint.chapters_done, chapterPos],
            next_chapter_idx: chapterPos + 1,
            voice_state: updatedVoiceState,
            next_line_idx: nextLineIdx,
            provider_used: provider,
          };
          await putCheckpoint(env, book_id, checkpoint);

          const chaptersReady = checkpoint.chapters_done.length;
          const progress = chaptersReady / Math.max(checkpoint.total_chapters, 1);

          await writeJsonR2(env, `books/${book_id}.json`, {
            book_id,
            title,
            author,
            art_style,
            characters: knownCharacters,
            status: chaptersReady >= checkpoint.total_chapters ? "processing" : "partial",
            stage: "extracting",
            progress,
            chapters_ready: chaptersReady,
            total_chapters: checkpoint.total_chapters,
            scenes: mergedScenes,
          });
          await writeJsonR2(env, `books/${book_id}.analysis.json`, {
            book_id, title, author, characters: mergedAnalysisCharacters, scenes: mergedAnalysisScenes,
          });

          await putBookIndex(env, book_id, {
            book_id,
            title,
            author,
            status: "partial",
            stage: "extracting",
            progress,
            chapters_ready: chaptersReady,
            total_chapters: checkpoint.total_chapters,
            scenes: mergedScenes.length,
            lines: mergedScenes.reduce((n, s) => n + (s.lines?.length || 0), 0),
            art_style,
            extract_provider: provider,
            job_id,
            phase: "extracting",
            phase_label: "Extracting script",
            detail: `Chapter ${chaptersReady}/${checkpoint.total_chapters} ready`,
          });
        },
      },
    );
  } catch (e) {
    if (!e.providerExhausted) throw e;
    stopDetail = String(e.message || e).slice(0, 300);
  }

  if (stopDetail) {
    const chaptersReady = checkpoint.chapters_done.length;
    await putBookIndex(env, book_id, {
      book_id,
      status: "partial",
      stage: "extracting",
      progress: chaptersReady / Math.max(checkpoint.total_chapters, 1),
      chapters_ready: chaptersReady,
      total_chapters: checkpoint.total_chapters,
      detail: `Stalled at chapter ${checkpoint.next_chapter_idx + 1}/${checkpoint.total_chapters}: ${stopDetail}`,
      job_id,
      active_job_id: null,
      imaging_locked: false,
    });
    dbg.log("PARTIAL", stopDetail, { chaptersReady, total: checkpoint.total_chapters });
    return { status: "partial", checkpoint, provider, detail: stopDetail };
  }

  // Every chapter succeeded — finalize the full analysis + playback, then run
  // imaging exactly as the legacy whole-book path (unchanged for this phase).
  //
  // `chapters` must live on `analysis`, not just on the hand-built `playback`
  // below — any imaging run (runEdgeImaging -> compilePlaybackWithMedia ->
  // compilePlayback) rebuilds playback FROM analysis via
  // `chapters: analysis.chapters || []`, so if it's missing here it silently
  // vanishes from the live playback the very first time art regenerates,
  // even though it was present right after this initial finalize.
  // Same reasoning as compile-playback.js's synthesizeUndeclaredCharacters:
  // the model doesn't always keep characters[] in sync with who it actually
  // uses in scenes/lines. compileChapterPlayback already patches this for
  // the compiled *playback* per-chapter, but analysis.json's own characters
  // array needs the same treatment — otherwise a character who only exists
  // because of that synthesis (never declared by the model) is invisible to
  // every endpoint that patches analysis.characters directly: illustration-
  // refs, rename, merge, temperament. Confirmed as a real bug: assigning an
  // EPUB plate to such a character via the Character settings UI saved
  // "successfully" but silently did nothing, because the patch loop found
  // no matching id to update.
  const analysisCharacters = [
    ...mergedAnalysisCharacters,
    ...synthesizeUndeclaredCharacters(mergedAnalysisCharacters, mergedAnalysisScenes, []),
  ];

  // Phase 3 (docs/02_REVOLUTION_ROADMAP.md, docs/CHARACTER_ENRICHMENT.md):
  // opt-in, best-effort — runs here because this is the first point the
  // whole-book character roster is final/stable (per-chapter reconcile can
  // still rewrite ids up to this point), and it runs before the imaging
  // block below so enriched fields are in place when image prompts build.
  if (isCharacterEnrichEnabled(env)) {
    try {
      const enrichment = await enrichCharacters(env, {
        seriesTitle: title,
        characters: analysisCharacters.filter((c) => c.id && c.id !== "narrator"),
      });
      if (enrichment.size) {
        for (let i = 0; i < analysisCharacters.length; i += 1) {
          const attrs = enrichment.get(analysisCharacters[i].id);
          if (attrs) analysisCharacters[i] = mergeEnrichmentIntoCharacter(analysisCharacters[i], attrs);
        }
        for (const [id, attrs] of enrichment) {
          if (knownCharacters[id]) knownCharacters[id] = mergeEnrichmentIntoCharacter(knownCharacters[id], attrs);
        }
        dbg.log(PHASE.P2_COMPILE, "character enrichment applied", { count: enrichment.size });
      }
    } catch (e) {
      dbg.log(PHASE.P2_COMPILE, "character enrichment failed (non-fatal)", { error: e.message || String(e) });
    }
  }

  const analysis = {
    book_id, title, author, characters: analysisCharacters, scenes: mergedAnalysisScenes,
    chapters: parsed.chapters.map((c) => ({ index: c.index, title: c.title })),
  };
  if (Object.keys(illustrationUrls).length) {
    analysis.illustration_urls = illustrationUrls;
    analysis.illustration_count = Object.keys(illustrationUrls).length;
    if (epubExtract.cover_index != null) analysis.cover_illustration_ref = epubExtract.cover_index;
  }
  await writeJsonR2(env, `books/${book_id}.analysis.json`, analysis);

  await report("compiling", 0, { detail: "Building playback JSON" });
  const plateCount = Object.keys(illustrationUrls).length;
  const illusMode = normalizeIllustrationMode(illustration_mode || env.ILLUSTRATION_MODE, art_style, plateCount);

  let playback = {
    book_id,
    title,
    author,
    art_style,
    characters: knownCharacters,
    chapters: parsed.chapters.map((c) => ({ index: c.index, title: c.title })),
    scenes: mergedScenes,
  };
  playback.illustration_mode = illusMode;
  if (byo_mode && !dry_run) {
    playback.byo_mode = true;
    playback.illustration_urls = illustrationUrls;
    if (epubExtract.cover_index != null) playback.cover_illustration_ref = epubExtract.cover_index;
    for (const c of analysis.characters || []) {
      if (c.illustration_ref != null && playback.characters?.[c.id]) {
        playback.characters[c.id].illustration_ref = c.illustration_ref;
      }
    }
  }
  if (illusMode === "direct-use" && plateCount > 0) {
    const applied = applyDirectIllustrations(playback, analysis, illustrationUrls);
    playback = applied.playback;
    dbg.log(PHASE.P2_COMPILE, "direct-use", applied.counts);
  }

  playback.status = "ready";
  playback.stage = wantArt ? "imaging" : "done";
  playback.progress = wantArt ? 0.55 : 1;
  playback.chapters_ready = checkpoint.total_chapters;
  playback.total_chapters = checkpoint.total_chapters;
  await writeJsonR2(env, `books/${book_id}.json`, playback);

  const earlyLines = mergedScenes.reduce((n, s) => n + (s.lines?.length || 0), 0);
  await putBookIndex(env, book_id, {
    book_id,
    title: playback.title,
    author: playback.author,
    status: wantArt ? "processing" : "ready",
    stage: wantArt ? "imaging" : "done",
    progress: wantArt ? 0.55 : 1,
    chapters_ready: checkpoint.total_chapters,
    total_chapters: checkpoint.total_chapters,
    scenes: playback.scenes?.length || 0,
    lines: earlyLines,
    art_style,
    extract_provider: provider,
    job_id,
    phase: "compiling",
    phase_label: "Building playback",
  });
  dbg.log(PHASE.P2_COMPILE, "done", { scenes: playback.scenes?.length, lines: earlyLines });

  let imagingStats = null;
  if (wantArt) {
    const imgPlan = await countImagingSteps(analysis, env);
    let globalStep = 0;
    await putBookIndex(env, book_id, {
      imaging_locked: true, active_job_id: job_id, stage: "imaging", status: "processing",
    });
    dbg.log(PHASE.P3_IMAGES, "start", { art_style, plan: imgPlan });
    await report("imaging", 0, {
      detail: `Generating art (0/${imgPlan.total})`, step: "imaging", stepIndex: 0, stepTotal: imgPlan.total,
    });

    // If VAE_PARALLEL_IMAGING generated art per-chapter while later chapters
    // were still extracting (see the chapter-imaging enqueue in
    // onChapterComplete below), this is the reuse seed — whatever's already
    // sitting in each chapter's pack gets skipped here instead of
    // regenerated, so this final phase often has little or nothing left to
    // do by the time every chapter's text has finished.
    const allChapterPositions = Array.from({ length: checkpoint.total_chapters }, (_, i) => i);
    const existingMedia = await existingMediaFromChapterPacks(env, book_id, allChapterPositions);

    const img = await runEdgeImaging({
      env,
      book_id,
      analysis,
      art_style,
      narrator_gender,
      existingMedia,
      dbg,
      generateExpressiveSprites: Boolean(generate_expressive_sprites),
      onCoverReady: (coverUrl) => {
        putBookIndex(env, book_id, { cover: coverUrl }).catch(() => {});
      },
      onProgress: ({ kind, index, total, id, reused }) => {
        globalStep += 1;
        report("imaging", globalStep / Math.max(imgPlan.total, 1), {
          detail: `${kind} · ${id}${reused ? " (reused)" : ` · ${globalStep}/${imgPlan.total}`}`,
          step: kind, stepIndex: globalStep, stepTotal: imgPlan.total,
          sub: { kind, localIndex: index, localTotal: total, id, reused: Boolean(reused) },
        }).catch(() => {});
      },
      onProviderAttempt: (p, { kind, id }) => {
        report("imaging", globalStep / Math.max(imgPlan.total, 1), {
          detail: `Trying ${p} for ${kind} · ${id}`, step: kind, stepIndex: globalStep, stepTotal: imgPlan.total,
        }).catch(() => {});
      },
      onProviderWait: (p, { kind, id, waitMs }) => {
        const secs = Math.max(1, Math.round((waitMs || 0) / 1000));
        report("imaging", globalStep / Math.max(imgPlan.total, 1), {
          detail: `Waiting on ${p} for ${kind} · ${id} (${secs}s)`, step: kind, stepIndex: globalStep, stepTotal: imgPlan.total,
        }).catch(() => {});
      },
      onImageFailure: ({ kind, id, error }) => {
        report("imaging", globalStep / Math.max(imgPlan.total, 1), {
          detail: `Failed ${kind} · ${id}: ${String(error || "unknown").slice(0, 220)}`,
          step: kind, stepIndex: globalStep, stepTotal: imgPlan.total,
        }).catch(() => {});
      },
    });
    if ((img.stats?.ok ?? 0) === 0 && (img.stats?.stock ?? 0) === 0 && imgPlan.total > 0) {
      throw new Error("All images failed — set GEMINI_API_KEY (wrangler secret) or configure freemium image providers");
    }
    playback = img.playback;
    playback.status = "ready";
    playback.stage = "done";
    playback.progress = 1;
    playback.chapters_ready = checkpoint.total_chapters;
    playback.total_chapters = checkpoint.total_chapters;
    imagingStats = img.stats;
    dbg.log(PHASE.P3_IMAGES, "done", imagingStats);
    await report("imaging", 1, {
      detail: `Art complete · ${imagingStats?.ok ?? 0} ok, ${imagingStats?.fail ?? 0} failed`,
      step: "imaging", stepIndex: imgPlan.total, stepTotal: imgPlan.total,
    });
  } else {
    dbg.log(PHASE.P3_IMAGES, "skipped", { dry_run, generate_art });
  }

  await writeJsonR2(env, `books/${book_id}.json`, playback);

  const lines = (playback.scenes || []).reduce((n, s) => n + (s.lines?.length || 0), 0);
  await putBookIndex(env, book_id, {
    book_id,
    title: playback.title,
    author: playback.author,
    status: "ready",
    stage: "done",
    progress: 1,
    chapters_ready: checkpoint.total_chapters,
    total_chapters: checkpoint.total_chapters,
    scenes: playback.scenes.length,
    lines,
    art_style,
    extract_provider: provider,
    phase: "done",
    phase_label: "Ready",
    detail: dry_run
      ? `Dry run complete (${provider})`
      : byo_mode
        ? `Ready · BYO mode — copy prompts in Replace art (${provider})`
        : wantArt
          ? `Ready · extract=${provider} · images ok=${imagingStats?.ok ?? 0}`
          : `Ready · extract=${provider} (no art)`,
    imaging_locked: false,
    active_job_id: null,
    cover: playback.cover || null,
    byo_mode: Boolean(byo_mode && !dry_run),
  });

  return {
    status: "ready", checkpoint, provider, model, imagingStats, scenes: playback.scenes.length, lines,
  };
}
