import { extractEpubText } from "../_shared/epub-text.js";
import { extractEpubImages } from "../_shared/epub-images.js";
import { persistEpubImages } from "../_shared/reference-images.js";
import { freemiumExtractBook } from "../_shared/freemium-extract.js";
import { runEdgeImaging } from "../_shared/edge-imaging.js";
import { putBookIndex } from "../_shared/jobs-kv.js";
import { syncCatalogCover } from "../_shared/catalog-cover.js";
import { touchIngestJob } from "../_shared/job-touch.js";
import { createPhaseLogger, PHASE } from "../_shared/phase-debug.js";
import { createIngestProgress, countImagingSteps } from "../_shared/ingest-progress.js";

async function touchBookProgress(env, bookId, patch) {
  await putBookIndex(env, bookId, patch);
}

function imagingStepLabel(kind, id) {
  if (kind === "stock") return `Stock sprite · ${id}`;
  if (kind === "character") return `Character sprite · ${id}`;
  if (kind === "background") return `Background · ${id}`;
  return `${kind} · ${id}`;
}

export async function handleIngestMessage(message, env) {
  const {
    job_id, book_id, art_style, narrator_gender, dry_run, generate_art, byo_mode, illustration_mode,
  } = message.body;
  const dbg = createPhaseLogger(env, "ingest", job_id);
  const wantArt = generate_art !== false && !dry_run && !byo_mode;
  const tracker = createIngestProgress({ wantArt });
  let lastReportFlush = 0;
  let lastReportPhase = "";

  async function report(phase, t, meta = {}) {
    const patch = tracker.at(phase, t, meta);
    const detail = String(meta.detail || "");
    const force = t === 0 || t === 1
      || phase !== lastReportPhase
      || /fail|error|complete|skipped|done/i.test(detail)
      || /Trying |Waiting on /i.test(detail);
    const now = Date.now();
    if (!force && now - lastReportFlush < 800) return patch;
    lastReportFlush = now;
    lastReportPhase = phase;
    await touchIngestJob(env, job_id, patch, { dbg });
    await touchBookProgress(env, book_id, {
      progress: patch.progress,
      stage: patch.stage,
      status: patch.status,
      phase: patch.phase,
      phase_label: patch.phase_label,
      detail: patch.detail,
      step: patch.step,
      step_index: patch.step_index,
      step_total: patch.step_total,
      progress_meta: patch.progress_meta,
    });
    return patch;
  }

  try {
    dbg.log(PHASE.P1_PARSE, "start");
    await report("parsing", 0, { detail: "Loading EPUB from storage" });

    const obj = await env.VAE_PACKS.get(`uploads/${job_id}.epub`);
    if (!obj) throw new Error("upload missing from R2");

    const bytes = await obj.arrayBuffer();
    const maxChars = parseInt(env.VAE_EPUB_MAX_CHARS || "800000", 10) || 800000;
    const parsed = extractEpubText(bytes, { maxChars });
    const illusCap = parseInt(env.VAE_EPUB_MAX_IMAGES || "0", 10);
    const epubExtract = extractEpubImages(bytes, {
      maxImages: illusCap > 0 ? illusCap : null,
    });
    const epubImages = epubExtract.images;
    let illustrationUrls = {};
    if (epubImages.length && env.VAE_PACKS) {
      illustrationUrls = await persistEpubImages(env, book_id, epubImages);
    }
    const title = parsed.title || book_id;
    const author = parsed.author || "";
    dbg.log(PHASE.P1_PARSE, "epub parsed", {
      title,
      chars: parsed.body_text?.length || 0,
      spine_parts: parsed.spine_parts,
      illustration_count: epubImages.length,
    });
    await report("parsing", 1, {
      detail: `Parsed ${parsed.chars || parsed.body_text?.length || 0} chars · ${parsed.spine_parts || 0} spine parts`,
    });

    await putBookIndex(env, book_id, {
      book_id,
      title,
      author,
      status: "processing",
      stage: "parsing",
      progress: tracker.at("parsing", 1).progress,
      job_id,
      art_style,
      phase: "parsing",
      phase_label: "Reading EPUB",
    });

    await report("extracting", 0, { detail: "Starting script extraction" });
    const { resolvedExtractProviders } = await import("../_shared/pipeline-registry.js");
    const extractChain = await resolvedExtractProviders(env);
    dbg.log(PHASE.P2_EXTRACT, "start", { chain: extractChain });

    const { analysis: rawAnalysis, provider, model } = await freemiumExtractBook(
      { book_id, title, author, body_text: parsed.body_text },
      {
        env,
        onProgress: ({ chunk, total, provider: p }) => {
          report("extracting", chunk / Math.max(total, 1), {
            detail: `Extract chunk ${chunk}/${total}${p ? ` (${p})` : ""}`,
            step: "extract",
            stepIndex: chunk,
            stepTotal: total,
            sub: { provider: p },
          }).catch(() => {});
        },
      },
    );
    dbg.log(PHASE.P2_EXTRACT, "done", { provider, model });
    await report("extracting", 1, { detail: `Extract complete (${provider})`, step: "extract" });

    dbg.log(PHASE.P2_REPAIR, "start");
    await report("repair", 0, { detail: "Repairing speech tags & alternation" });
    const { repairAnalysis } = await import("../_shared/dialogue-repair.js");
    const { attributeAnalysis } = await import("../_shared/dialogue-attribute.js");
    let analysis = attributeAnalysis(repairAnalysis(rawAnalysis));
    dbg.log(PHASE.P2_REPAIR, "done");
    await report("repair", 1, { detail: "Deterministic attribution complete" });

    dbg.log(PHASE.P2_ATTRIBUTE, "start", { provider, enabled: String(env.VAE_ATTR_LLM ?? "false") });
    const { attributeAnalysisLLM, isAttrLlmEnabled } = await import("../_shared/dialogue-attribute-llm.js");
    if (isAttrLlmEnabled(env)) {
      analysis = await attributeAnalysisLLM(analysis, {
        env,
        preferProvider: provider,
        onProgress: ({ sceneIndex, sceneTotal, batchIndex, batchTotal, sceneId, skipped }) => {
          const capNote = skipped ? ` (${skipped} capped)` : "";
          report("attributing", sceneIndex / Math.max(sceneTotal, 1), {
            detail: `Batch ${batchIndex}/${batchTotal} · ${sceneIndex}/${sceneTotal} scenes${capNote}`,
            step: "attribute",
            stepIndex: sceneIndex,
            stepTotal: sceneTotal,
            sub: { sceneId, batchIndex, batchTotal },
          }).catch(() => {});
        },
      });
      await report("attributing", 1, { detail: "LLM attribution complete" });
    } else {
      await report("attributing", 1, { detail: "LLM attribution skipped (VAE_ATTR_LLM=false)" });
    }
    dbg.log(PHASE.P2_ATTRIBUTE, "done");

    const { finalizeAnalysisChapters } = await import("../_shared/chapter-assign.js");
    analysis = finalizeAnalysisChapters(analysis, { epubChapters: parsed.chapters });
    analysis.title = title;
    analysis.author = author;
    if (Object.keys(illustrationUrls).length) {
      analysis.illustration_urls = illustrationUrls;
      analysis.illustration_count = Object.keys(illustrationUrls).length;
      if (epubExtract.cover_index != null) {
        analysis.cover_illustration_ref = epubExtract.cover_index;
      }
    }

    await report("compiling", 0, { detail: "Building playback JSON" });
    await env.VAE_PACKS.put(
      `books/${book_id}.analysis.json`,
      JSON.stringify(analysis, null, 2),
      { httpMetadata: { contentType: "application/json" } },
    );

    const { compilePlayback } = await import("../_shared/compile-playback.js");
    const { normalizeIllustrationMode, applyDirectIllustrations } = await import(
      "../_shared/illustrations.js"
    );
    const plateCount = Object.keys(illustrationUrls).length;
    const illusMode = normalizeIllustrationMode(
      illustration_mode || env.ILLUSTRATION_MODE,
      art_style,
      plateCount,
    );

    let playback = compilePlayback(analysis, { art_style, narrator_gender });
    playback.illustration_mode = illusMode;
    if (byo_mode && !dry_run) {
      playback.byo_mode = true;
      playback.illustration_urls = illustrationUrls;
      if (epubExtract.cover_index != null) {
        playback.cover_illustration_ref = epubExtract.cover_index;
      }
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
    playback.progress = wantArt ? tracker.at("imaging", 0).progress : 1;

    await env.VAE_PACKS.put(
      `books/${book_id}.json`,
      JSON.stringify(playback, null, 2),
      { httpMetadata: { contentType: "application/json" } },
    );

    const earlyLines = (playback.scenes || []).reduce((n, s) => n + (s.lines?.length || 0), 0);
    const compilePatch = tracker.at("compiling", 1, { detail: "Playback ready" });
    await putBookIndex(env, book_id, {
      book_id,
      title: playback.title || title,
      author: playback.author || author,
      status: wantArt ? "processing" : "ready",
      stage: wantArt ? "imaging" : "done",
      progress: compilePatch.progress,
      scenes: playback.scenes?.length || 0,
      lines: earlyLines,
      art_style,
      extract_provider: provider,
      job_id,
      phase: compilePatch.phase,
      phase_label: compilePatch.phase_label,
    });
    await touchIngestJob(env, job_id, compilePatch, { dbg });
    dbg.log(PHASE.P2_COMPILE, "done", { scenes: playback.scenes?.length, lines: earlyLines });

    let imagingStats = null;

    if (wantArt) {
      const imgPlan = await countImagingSteps(analysis, env);
      let globalStep = 0;
      await putBookIndex(env, book_id, {
        imaging_locked: true,
        active_job_id: job_id,
        stage: "imaging",
        status: "processing",
      });
      dbg.log(PHASE.P3_IMAGES, "start", {
        art_style,
        plan: imgPlan,
        chain: await (await import("../_shared/pipeline-registry.js")).resolvedFreemiumImageChain(env, "character"),
      });
      await report("imaging", 0, {
        detail: `Generating art (0/${imgPlan.total})`,
        step: "imaging",
        stepIndex: 0,
        stepTotal: imgPlan.total,
      });

      const img = await runEdgeImaging({
        env,
        book_id,
        analysis,
        art_style,
        narrator_gender,
        dbg,
        onCoverReady: (coverUrl) => {
          putBookIndex(env, book_id, { cover: coverUrl }).catch(() => {});
        },
        onProgress: ({ kind, index, total, id, reused }) => {
          globalStep += 1;
          const label = imagingStepLabel(kind, id);
          report("imaging", globalStep / Math.max(imgPlan.total, 1), {
            detail: reused ? `${label} (reused)` : `${label} · ${globalStep}/${imgPlan.total}`,
            step: kind,
            stepIndex: globalStep,
            stepTotal: imgPlan.total,
            sub: { kind, localIndex: index, localTotal: total, id, reused: Boolean(reused) },
          }).catch(() => {});
        },
        onProviderAttempt: (provider, { kind, id }) => {
          report("imaging", globalStep / Math.max(imgPlan.total, 1), {
            detail: `Trying ${provider} for ${kind} · ${id}`,
            step: kind,
            stepIndex: globalStep,
            stepTotal: imgPlan.total,
          }).catch(() => {});
        },
        onProviderWait: (provider, { kind, id, waitMs }) => {
          const secs = Math.max(1, Math.round((waitMs || 0) / 1000));
          report("imaging", globalStep / Math.max(imgPlan.total, 1), {
            detail: `Waiting on ${provider} for ${kind} · ${id} (${secs}s)`,
            step: kind,
            stepIndex: globalStep,
            stepTotal: imgPlan.total,
          }).catch(() => {});
        },
        onImageFailure: ({ kind, id, error }) => {
          report("imaging", globalStep / Math.max(imgPlan.total, 1), {
            detail: `Failed ${kind} · ${id}: ${String(error || "unknown").slice(0, 220)}`,
            step: kind,
            stepIndex: globalStep,
            stepTotal: imgPlan.total,
          }).catch(() => {});
        },
      });
      if ((img.stats?.ok ?? 0) === 0 && (img.stats?.stock ?? 0) === 0 && imgPlan.total > 0) {
        throw new Error(
          "All images failed — set GEMINI_API_KEY (wrangler secret) or configure freemium image providers",
        );
      }
      playback = img.playback;
      playback.status = "ready";
      playback.stage = "done";
      playback.progress = 1;
      imagingStats = img.stats;
      dbg.log(PHASE.P3_IMAGES, "done", imagingStats);
      await report("imaging", 1, {
        detail: `Art complete · ${imagingStats?.ok ?? 0} ok, ${imagingStats?.fail ?? 0} failed`,
        step: "imaging",
        stepIndex: imgPlan.total,
        stepTotal: imgPlan.total,
      });
    } else {
      dbg.log(PHASE.P3_IMAGES, "skipped", { dry_run, generate_art });
    }

    await env.VAE_PACKS.put(
      `books/${book_id}.json`,
      JSON.stringify(playback, null, 2),
      { httpMetadata: { contentType: "application/json" } },
    );

    const lines = (playback.scenes || []).reduce((n, s) => n + (s.lines?.length || 0), 0);
    const donePatch = tracker.at("done", 1, {
      detail: dry_run
        ? `Dry run complete (${provider})`
        : byo_mode
          ? `Ready · BYO mode — copy prompts in Replace art (${provider})`
          : wantArt
            ? `Ready · extract=${provider} · images ok=${imagingStats?.ok ?? 0}`
            : `Ready · extract=${provider} (no art)`,
    });
    await putBookIndex(env, book_id, {
      book_id,
      title: playback.title,
      author: playback.author,
      status: "ready",
      stage: "done",
      progress: 1,
      scenes: playback.scenes.length,
      lines,
      art_style,
      extract_provider: provider,
      phase: "done",
      phase_label: donePatch.phase_label,
      detail: donePatch.detail,
      imaging_locked: false,
      active_job_id: null,
      cover: playback.cover || null,
      byo_mode: Boolean(byo_mode && !dry_run),
    });

    await dbg.flush((patch) => touchIngestJob(env, job_id, patch, { eventType: "done", dbg }), {
      ...donePatch,
      book_id,
      extract_provider: provider,
      imaging: imagingStats,
    });
    message.ack();
  } catch (e) {
    console.error("ingest consumer", job_id, e);
    dbg.log("ERROR", String(e.message || e).slice(0, 200));
    await dbg.flush((patch) => touchIngestJob(env, job_id, patch, { eventType: "error", dbg }), {
      status: "error",
      progress: 0,
      stage: "error",
      phase: "error",
      phase_label: "Failed",
      detail: String(e.message || e).slice(0, 300),
    });
    await putBookIndex(env, book_id, {
      book_id,
      title: book_id,
      status: "error",
      stage: "error",
      progress: 0,
      job_id,
      imaging_locked: false,
      active_job_id: null,
      error: String(e.message || e).slice(0, 200),
    }).catch(() => {});
    message.retry();
  }
}
