import { putBookIndex } from "../_shared/jobs-kv.js";
import { touchIngestJob } from "../_shared/job-touch.js";
import { loadStoredEpubBytes } from "../_shared/book-extract-pipeline.js";
import { extractEpubText } from "../_shared/epub-text.js";
import { extractEpubImages } from "../_shared/epub-images.js";
import { matchIllustrationsToChapters } from "../_shared/chapter-extract-pipeline.js";
import {
  matchPlatesToCharacters, identifyCharacterInCrop, surroundingContext,
} from "../_shared/illustration-character-match.js";
import { applyIllustrationRefsPatch, syncIllustrationRefsToPlayback } from "../_shared/illustration-refs.js";
import { applyDirectIllustrations } from "../_shared/illustrations.js";
import { addCharacterReferenceImageInAnalysis } from "../_shared/character-merge.js";
import { r2MediaKey, mediaUrl } from "../_shared/freemium-image.js";
import { createPhaseLogger, PHASE } from "../_shared/phase-debug.js";

function arrayBufferToBase64(buf) {
  const u8 = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const MAX_FACES_PER_PLATE = 8; // safety cap — matches MAX_REFERENCE_IMAGES elsewhere

/**
 * Detect and crop EVERY face on a plate (not just one) — the fix for
 * "we're missing a bunch of crops": the old cropAndStoreReference above
 * only ever asked for max_faces:1, and only ran for plates that whole-plate
 * vision matching confidently attributed to a single character. A plate
 * showing several visible characters (the common case for a real group
 * illustration) correctly gets no whole-plate match — matchPlatesToCharacters
 * declines rather than guess — so under the old scheme it produced ZERO
 * crops even though every face on it was perfectly detectable. Returns
 * Array<{cropBytes, bbox}> — bbox lets the caller skip faces already
 * identified another way (OCR name-caption pairing) by overlap, see
 * bboxIoU below. Best-effort: unreachable server or zero detections just
 * return an empty array.
 */
export async function cropAllFacesForPlate(env, plateBytes, dbg) {
  const base = String(env.LOCAL_IMAGE_URL || "").trim().replace(/\/$/, "");
  if (!base) return [];

  let crops;
  let bboxes;
  try {
    const b64 = arrayBufferToBase64(plateBytes);
    const res = await fetch(`${base}/crop_faces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image_b64: b64, max_faces: MAX_FACES_PER_PLATE }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return [];
    ({ crops, bboxes } = await res.json());
  } catch (e) {
    dbg?.log(PHASE.P2_EXTRACT, "crop_faces (all) failed (non-fatal)", { error: String(e.message || e).slice(0, 120) });
    return [];
  }
  if (!crops?.length) return [];

  return crops.map((c, i) => ({
    cropBytes: Uint8Array.from(atob(c), (ch) => ch.charCodeAt(0)),
    bbox: bboxes?.[i] || null,
  }));
}

/** Intersection-over-union of two [x,y,w,h] boxes — used to skip a face
 * cropAllFacesForPlate detected that's actually the same face an OCR
 * name-caption pairing already identified (see /ocr_faces), so it doesn't
 * get cropped and vision-identified a second time as a near-duplicate. */
export function bboxIoU(a, b) {
  if (!a || !b) return 0;
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const x1 = Math.max(ax, bx);
  const y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw);
  const y2 = Math.min(ay + ah, by + bh);
  const iw = Math.max(0, x2 - x1);
  const ih = Math.max(0, y2 - y1);
  const inter = iw * ih;
  const union = aw * ah + bw * bh - inter;
  return union > 0 ? inter / union : 0;
}

function normalizeNameTokens(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

/** Best-effort "which known character does this OCR'd caption name?" — token
 * overlap against character.name (case/punctuation-insensitive), same
 * "don't guess" posture as the LLM matching pass: no shared token, no match.
 * Tokens match on substring containment, not just exact equality — Tesseract
 * on small in-image caption text frequently drops a leading/trailing
 * character or two (e.g. "Elara" -> "lara"), and a strict-equality match
 * would silently miss those otherwise-confident reads. A 2-char minimum
 * containment guards against single-letter false positives. */
export function fuzzyMatchCharacterName(label, characters) {
  const labelTokens = normalizeNameTokens(label);
  if (!labelTokens.length) return null;
  let best = null;
  let bestScore = 0;
  for (const c of characters) {
    const nameTokens = normalizeNameTokens(c.name);
    let overlap = 0;
    for (const lt of labelTokens) {
      if (nameTokens.some((nt) => (lt.length >= 2 && nt.length >= 2) && (nt.includes(lt) || lt.includes(nt)))) {
        overlap += 1;
      }
    }
    if (overlap > bestScore) {
      best = c;
      bestScore = overlap;
    }
  }
  return best?.id || null;
}

/**
 * Some plates caption each pictured character's name directly on the image
 * (a labeled group shot — see docs/TODO_ILLUSTRATIONS_PROFILES_POLISH.md's
 * "plate 8" case). POSTs the raw plate bytes to the local image server's
 * /ocr_faces (Tesseract OCR + nearest-face pairing, see
 * detect_and_crop_faces.py's crop_named_faces_from_bytes), then fuzzy-matches
 * each returned label against the known character roster. Returns
 * Array<{charId, cropBytes}> — one entry per confidently-paired, confidently-
 * named face. Best-effort: no LOCAL_IMAGE_URL, an endpoint error, or zero
 * OCR pairs all resolve to an empty array rather than throwing.
 */
export async function ocrNamedCropsForPlate(env, plateBytes, characters, dbg) {
  const base = String(env.LOCAL_IMAGE_URL || "").trim().replace(/\/$/, "");
  if (!base) return [];

  let matches;
  try {
    const b64 = arrayBufferToBase64(plateBytes);
    const res = await fetch(`${base}/ocr_faces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image_b64: b64 }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return [];
    ({ matches } = await res.json());
  } catch (e) {
    dbg?.log(PHASE.P2_EXTRACT, "ocr_faces failed (non-fatal)", { error: String(e.message || e).slice(0, 120) });
    return [];
  }
  if (!matches?.length) return [];

  const out = [];
  for (const m of matches) {
    const charId = fuzzyMatchCharacterName(m.label, characters);
    if (!charId) continue;
    const cropBytes = Uint8Array.from(atob(m.crop_b64), (c) => c.charCodeAt(0));
    out.push({ charId, cropBytes, label: m.label, bbox: m.bbox || null });
  }
  return out;
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
    const { byChapterPos: illustrationsByChapterPos } = matchIllustrationsToChapters(
      parsed.orderedPaths, parsed.chapters, epubExtract.imageMeta,
    );

    const platesConsidered = [...illustrationsByChapterPos.values()].reduce((n, arr) => n + arr.length, 0);
    if (!platesConsidered) {
      await touchIngestJob(env, job_id, {
        status: "done", stage: "done", progress: 1, detail: "No plates to match against known chapters",
      }, { eventType: "done", dbg });
      await putBookIndex(env, book_id, {
        status: "ready", stage: "done", progress: 1, active_job_id: null,
        detail: "No plates to match against known chapters",
      }).catch(() => {});
      message.ack();
      return;
    }

    await touchIngestJob(env, job_id, {
      status: "processing", stage: "matching", progress: 0.15,
      detail: `Matching ${platesConsidered} plate(s) to characters`,
    }, { eventType: "progress", dbg });

    const getPlateBytes = (plateIdx) => epubExtract.images?.[plateIdx] || null;
    const matches = await matchPlatesToCharacters(illustrationsByChapterPos, analysis.characters, parsed.chapters, {
      env, preferProvider: opts.prefer_provider || null, getPlateBytes,
    });
    dbg.log(PHASE.P2_EXTRACT, "matches", { count: matches.size });

    // Named-caption pass: some plates label each pictured character's name
    // directly on the image (see docs/TODO_ILLUSTRATIONS_PROFILES_POLISH.md's
    // "plate 8" case) — run this across every considered plate regardless of
    // whether the whole-plate LLM match above found anything, since a
    // captioned group shot can name several characters at once. Best-effort
    // and additive: skips cleanly when OCR/local-image-server is unavailable.
    const namedCropsByPlate = new Map(); // plateIdx -> [{charId, cropBytes, label}]
    const nonNarratorCharacters = (analysis.characters || []).filter((c) => c.id !== "narrator");
    for (const [, plates] of illustrationsByChapterPos) {
      for (const p of plates || []) {
        const plateBytes = epubExtract.images?.[p.index];
        if (!plateBytes) continue;
        const named = await ocrNamedCropsForPlate(env, plateBytes, nonNarratorCharacters, dbg);
        if (named.length) namedCropsByPlate.set(p.index, named);
      }
    }
    const namedMatchCount = [...namedCropsByPlate.values()].reduce((n, arr) => n + arr.length, 0);
    if (namedMatchCount) {
      dbg.log(PHASE.P2_EXTRACT, "named-caption matches", { plates: namedCropsByPlate.size, characters: namedMatchCount });
    }

    // Per-face pass: run on EVERY plate, not just ones the whole-plate match
    // above resolved. matchPlatesToCharacters correctly declines a plate
    // showing several visible characters (no single one "clearly, unambiguously"
    // dominates) — that's the right call for the whole-plate illustration_ref/
    // moment purpose, but it meant a real group illustration produced zero
    // reference crops even though every face on it was perfectly detectable.
    // Crop every face first (mechanical, cheap, local), then identify each
    // isolated crop individually via vision — much more reliable than asking
    // "who's in this busy scene" about the whole plate. Skips any face
    // already identified by the OCR name-caption pass above (bbox overlap)
    // so a captioned plate doesn't get the same face cropped and identified
    // twice.
    const faceCropsByPlate = new Map(); // plateIdx -> [{charId, cropBytes}]
    for (const [chapterPos, plates] of illustrationsByChapterPos) {
      for (const p of plates || []) {
        const plateBytes = epubExtract.images?.[p.index];
        if (!plateBytes) continue;
        const allFaces = await cropAllFacesForPlate(env, plateBytes, dbg);
        if (!allFaces.length) continue;
        const claimedBoxes = (namedCropsByPlate.get(p.index) || []).map((n) => n.bbox).filter(Boolean);
        const context = surroundingContext(p, parsed.chapters, chapterPos);
        const found = [];
        for (const face of allFaces) {
          if (face.bbox && claimedBoxes.some((cb) => bboxIoU(cb, face.bbox) > 0.3)) continue;
          const charId = await identifyCharacterInCrop(face.cropBytes, nonNarratorCharacters, context, { env });
          if (charId) found.push({ charId, cropBytes: face.cropBytes });
        }
        if (found.length) faceCropsByPlate.set(p.index, found);
      }
    }
    const faceMatchCount = [...faceCropsByPlate.values()].reduce((n, arr) => n + arr.length, 0);
    if (faceMatchCount) {
      dbg.log(PHASE.P2_EXTRACT, "per-face matches", { plates: faceCropsByPlate.size, characters: faceMatchCount });
    }

    if (!matches.size && !namedCropsByPlate.size && !faceCropsByPlate.size) {
      const detail = `Checked ${platesConsidered} plate(s) — none confidently matched a character`;
      await touchIngestJob(env, job_id, {
        status: "done", stage: "done", progress: 1, detail,
      }, { eventType: "done", dbg });
      await putBookIndex(env, book_id, {
        status: "ready", stage: "done", progress: 1, active_job_id: null, detail,
      }).catch(() => {});
      message.ack();
      return;
    }

    const characterPatch = {};
    for (const [plateIdx, charId] of matches) characterPatch[charId] = plateIdx;
    for (const [plateIdx, named] of namedCropsByPlate) {
      for (const { charId } of named) {
        if (!(charId in characterPatch)) characterPatch[charId] = plateIdx;
      }
    }
    for (const [plateIdx, found] of faceCropsByPlate) {
      for (const { charId } of found) {
        if (!(charId in characterPatch)) characterPatch[charId] = plateIdx;
      }
    }

    let patched = applyIllustrationRefsPatch(analysis, { characters: characterPatch });
    const allMatchedCharIds = new Set(Object.keys(characterPatch));

    let cropped = 0;
    // Per-face crops are already the right isolated face, individually
    // vision-identified — store each directly rather than re-running
    // whole-plate face detection (which only ever returned one crop).
    for (const [, found] of faceCropsByPlate) {
      for (const { charId, cropBytes } of found) {
        const filename = `${charId}/${Date.now()}-face.png`;
        await env.VAE_PACKS.put(r2MediaKey(book_id, "character-refs", filename), cropBytes, {
          httpMetadata: { contentType: "image/png" },
        });
        const refUrl = mediaUrl(book_id, "character-refs", filename);
        patched = addCharacterReferenceImageInAnalysis(patched, charId, refUrl);
        cropped += 1;
      }
    }
    // Named-caption crops are already the right per-character face (OCR
    // paired each label to its own nearest face) — store each directly
    // instead of re-running whole-plate face detection for a multi-character
    // plate, which would only return one crop for the whole scene.
    for (const [, named] of namedCropsByPlate) {
      for (const { charId, cropBytes } of named) {
        const filename = `${charId}/${Date.now()}-named.png`;
        await env.VAE_PACKS.put(r2MediaKey(book_id, "character-refs", filename), cropBytes, {
          httpMetadata: { contentType: "image/png" },
        });
        const refUrl = mediaUrl(book_id, "character-refs", filename);
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
      for (const charId of allMatchedCharIds) {
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

    const doneDetail = `Matched ${allMatchedCharIds.size} character(s) across ${platesConsidered} plate(s)`;
    // Reset status/stage/progress here, not just active_job_id — the book
    // index (env.VAE_JOBS `book:{id}` record) is a separate snapshot from
    // the ingest job record above, and normally only self-heals via
    // ensureImagingLockFresh's "job is done, clear the lock" reconcile path
    // (see imaging-lock.js), which only runs when active_job_id is still
    // set. Clearing active_job_id here directly (the old behavior) skipped
    // that reconcile entirely, leaving the book stuck showing whatever
    // mid-run "processing/matching/NN%" snapshot got synced there earlier —
    // forever, confirmed live (GET /books kept returning the job's last
    // progress tick long after the job had actually finished).
    await putBookIndex(env, book_id, {
      status: "ready", stage: "done", progress: 1, active_job_id: null, detail: doneDetail,
    });
    await dbg.flush((patch) => touchIngestJob(env, job_id, patch, { eventType: "done", dbg }), {
      status: "done",
      stage: "done",
      progress: 1,
      detail: doneDetail,
      book_id,
      matched_characters: [...allMatchedCharIds],
    });
    message.ack();
  } catch (e) {
    console.error("illustration character match", job_id, e);
    const errDetail = String(e.message || e).slice(0, 300);
    await touchIngestJob(env, job_id, {
      status: "error",
      stage: "error",
      progress: 0,
      detail: errDetail,
      error: errDetail,
    }, { eventType: "error", dbg });
    await putBookIndex(env, book_id, {
      status: "ready", stage: "done", progress: 1, active_job_id: null, detail: errDetail, error: errDetail,
    }).catch(() => {});
    message.ack();
  }
}
