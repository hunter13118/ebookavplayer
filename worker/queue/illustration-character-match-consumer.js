import { putBookIndex } from "../_shared/jobs-kv.js";
import { touchIngestJob } from "../_shared/job-touch.js";
import { loadStoredEpubBytes } from "../_shared/book-extract-pipeline.js";
import { extractEpubText } from "../_shared/epub-text.js";
import { extractEpubImages } from "../_shared/epub-images.js";
import { matchIllustrationsToChapters } from "../_shared/chapter-extract-pipeline.js";
import { matchPlatesToCharacters } from "../_shared/illustration-character-match.js";
import { applyIllustrationRefsPatch, syncIllustrationRefsToPlayback } from "../_shared/illustration-refs.js";
import { applyDirectIllustrations } from "../_shared/illustrations.js";
import { addCharacterReferenceImageInAnalysis } from "../_shared/character-merge.js";
import { r2MediaKey, mediaUrl } from "../_shared/freemium-image.js";
import { createPhaseLogger, PHASE } from "../_shared/phase-debug.js";

/**
 * Crops each detected character face out of a matched plate via the local
 * image server's /crop_faces (scripts/local-image-server/server.py — see
 * docs/LOCAL_IMAGE_GEN.md) and stores the first crop as that character's
 * reference image. A crop is a much cleaner IP-Adapter/reference signal
 * than the whole plate (which may show several characters, background,
 * text overlay, etc — see the doc's v1→v2→v3 results). Best-effort and
 * entirely optional: LOCAL_IMAGE_URL not being configured, the crop
 * endpoint erroring, or zero faces detected in a given plate all just skip
 * that character rather than failing the match job — the whole-plate
 * illustration_ref (already applied via applyDirectIllustrations) is a
 * perfectly fine fallback reference on its own.
 */
export async function cropAndStoreReference(env, bookId, charId, plateBytes, artStyle, dbg) {
  const base = String(env.LOCAL_IMAGE_URL || "").trim().replace(/\/$/, "");
  if (!base) return null;

  let crops;
  try {
    const b64 = arrayBufferToBase64(plateBytes);
    const res = await fetch(`${base}/crop_faces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image_b64: b64, max_faces: 1 }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    ({ crops } = await res.json());
  } catch (e) {
    dbg?.log(PHASE.P2_EXTRACT, `crop failed for ${charId} (non-fatal)`, { error: String(e.message || e).slice(0, 120) });
    return null;
  }
  if (!crops?.length) return null;

  const cropBytes = Uint8Array.from(atob(crops[0]), (c) => c.charCodeAt(0));
  const filename = `${charId}/${Date.now()}.png`;
  await env.VAE_PACKS.put(r2MediaKey(bookId, "character-refs", filename), cropBytes, {
    httpMetadata: { contentType: "image/png" },
  });
  return mediaUrl(bookId, "character-refs", filename);
}

function arrayBufferToBase64(buf) {
  const u8 = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(binary);
}

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

    let patched = applyIllustrationRefsPatch(analysis, { characters: characterPatch });

    // Best-effort: crop each matched plate down to just that character's
    // face+upper-body and store it as their reference image. Skips cleanly
    // (no error, no job failure) when LOCAL_IMAGE_URL isn't configured —
    // this is a local-only enhancement on top of the whole-plate match,
    // which already applied above via applyDirectIllustrations regardless.
    let cropped = 0;
    for (const [plateIdx, charId] of matches) {
      const plateBytes = epubExtract.images?.[plateIdx];
      if (!plateBytes) continue;
      const refUrl = await cropAndStoreReference(env, book_id, charId, plateBytes, analysis.art_style, dbg);
      if (refUrl) {
        patched = addCharacterReferenceImageInAnalysis(patched, charId, refUrl);
        cropped += 1;
      }
    }
    if (cropped) dbg.log(PHASE.P2_EXTRACT, "cropped references stored", { count: cropped });

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
      for (const [, charId] of matches) {
        const c = patched.characters?.find((x) => x.id === charId);
        if (c?.reference_images?.length && playback.characters?.[charId]) {
          playback.characters[charId].reference_images = c.reference_images;
        }
      }
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
