/**
 * Shared extract → repair → attribute pipeline (ingest + re-extract).
 */
import { freemiumExtractBook } from "./freemium-extract.js";
import { finalizeAnalysisChapters } from "./chapter-assign.js";
import { repairChapterVerbatimCoverage } from "./verbatim-coverage.js";

export async function runBookExtractPipeline(
  { book_id, title, author, body_text, text_source = "epub" },
  { env, preferProvider, onProgress, epubChapters },
) {
  const { analysis: rawAnalysis, provider, model } = await freemiumExtractBook(
    { book_id, title, author, body_text },
    { env, preferProvider, onProgress },
  );

  const { repairAnalysis } = await import("./dialogue-repair.js");
  const { attributeAnalysis } = await import("./dialogue-attribute.js");
  let analysis = attributeAnalysis(repairAnalysis(rawAnalysis));

  const { attributeAnalysisLLM, isAttrLlmEnabled } = await import("./dialogue-attribute-llm.js");
  if (isAttrLlmEnabled(env)) {
    analysis = await attributeAnalysisLLM(analysis, {
      env,
      preferProvider: provider,
      onProgress: onProgress?.attribute
        ? (p) => onProgress.attribute(p)
        : undefined,
    });
  }

  // Verbatim-coverage repair — only meaningful when there's a real EPUB's own
  // verbatim text to diff against (freemiumExtractBook's LLM extraction can
  // drop words, e.g. an attribution tag, despite being told not to). Uses
  // epubChapters' own `.text` fields, NOT the raw `body_text` string — that's
  // formatted with synthetic "## Chapter N: Title" headers (epub-text.js's
  // formatBodyText) which aren't real prose and would otherwise get
  // "repaired" back in as bogus narrator lines. Skipped for the m4b-first
  // transcript path (text_source: "m4b_transcript") — there's no separate
  // ground truth to diff against there; body_text IS the ASR transcript
  // already, and there are no epubChapters for it either.
  if (text_source === "epub" && epubChapters?.length) {
    const sourceText = epubChapters.map((c) => c.text || "").join("\n\n");
    const { scenes: repairedScenes } = repairChapterVerbatimCoverage(analysis.scenes || [], sourceText);
    analysis = { ...analysis, scenes: repairedScenes };
  }

  analysis.title = title;
  analysis.author = author;
  analysis.text_source = text_source;
  analysis = finalizeAnalysisChapters(analysis, { epubChapters });
  return { analysis, provider, model };
}

/** Load EPUB bytes from R2 (book id path, then original ingest job path). */
export async function loadStoredEpubBytes(env, bookId) {
  let obj = await env.VAE_PACKS?.get(`uploads/${bookId}.epub`);
  if (obj) return obj.arrayBuffer();

  if (env.VAE_JOBS) {
    const raw = await env.VAE_JOBS.get(`book:${bookId}`);
    if (raw) {
      const meta = JSON.parse(raw);
      if (meta.job_id) {
        obj = await env.VAE_PACKS?.get(`uploads/${meta.job_id}.epub`);
        if (obj) return obj.arrayBuffer();
      }
    }
  }
  return null;
}

export async function persistEpubCopy(env, bookId, bytes) {
  if (!env.VAE_PACKS || !bytes) return;
  await env.VAE_PACKS.put(`uploads/${bookId}.epub`, bytes, {
    httpMetadata: { contentType: "application/epub+zip" },
  });
}
