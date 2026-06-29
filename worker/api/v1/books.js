import { listBookIds, json } from "../../_shared/jobs-kv.js";
import {
  enrichCatalogMetaFromPlayback,
  resolveCoverUrl,
  syncCatalogCover,
} from "../../_shared/catalog-cover.js";
import { enrichPlaybackFromAnalysis, harvestInsertMap, applyInsertsToLines } from "../../_shared/compile-playback.js";
import { normalizePlaybackLines } from "../../_shared/line-chunk.js";
import { normalizeBookProgress } from "../../_shared/ingest-progress.js";
import { ensureImagingLockFresh } from "../../_shared/imaging-lock.js";

export async function onBooksGet({ env }) {
  if (!env.VAE_PACKS || !env.VAE_JOBS) return null;
  const ids = await listBookIds(env);
  const out = await Promise.all(ids.map(async (book_id) => {
    const raw = await env.VAE_JOBS.get(`book:${book_id}`);
    if (!raw) return null;
    let meta = normalizeBookProgress(JSON.parse(raw));
    if (meta.imaging_locked || meta.active_job_id) {
      const fresh = await ensureImagingLockFresh(env, book_id);
      if (fresh.cleared) meta = normalizeBookProgress(fresh.meta);
    }
    if (!meta.cover || !meta.title) {
      meta = await enrichCatalogMetaFromPlayback(env, book_id, meta);
    }
    return meta;
  }));
  return json(out.filter(Boolean).sort((a, b) => (a.title || "").localeCompare(b.title || "")));
}

export async function onBookGet({ env, bookId }) {
  if (!env.VAE_PACKS) return null;

  if (env.VAE_JOBS) {
    const metaRaw = await env.VAE_JOBS.get(`book:${bookId}`);
    if (metaRaw) {
      let meta = JSON.parse(metaRaw);
      if (meta.imaging_locked || meta.active_job_id) {
        const fresh = await ensureImagingLockFresh(env, bookId);
        meta = fresh.meta;
      }
      if (meta.status === "error") {
        return json(
          {
            error: meta.error || "ingest failed",
            book_id: bookId,
            status: "error",
            stage: meta.stage || "error",
            job_id: meta.job_id,
            detail: meta.error,
          },
          422,
        );
      }
    }
  }

  const obj = await env.VAE_PACKS.get(`books/${bookId}.json`);
  if (!obj) return json({ error: "no such book", book_id: bookId, status: "processing" }, 404);

  let playback = await obj.json();
  const preservedInserts = harvestInsertMap(playback);
  const hasMomentArt = Object.keys(preservedInserts).length > 0;
  let recompiled = false;
  let repaired = false;

  let analysis = null;
  const axObj = await env.VAE_PACKS.get(`books/${bookId}.analysis.json`);
  if (axObj) {
    try {
      analysis = await axObj.json();
    } catch { /* keep stored playback */ }
  }
  if (analysis && !hasMomentArt) {
    try {
      playback = enrichPlaybackFromAnalysis(playback, analysis);
      recompiled = true;
    } catch { /* keep stored playback */ }
  } else if (hasMomentArt) {
    playback.inserts = preservedInserts;
    applyInsertsToLines(playback);
    repaired = true;
  }

  if (env.VAE_JOBS) {
    const progRaw = await env.VAE_JOBS.get(`progress:${bookId}`);
    if (progRaw) playback.resume = JSON.parse(progRaw);
    const voicesRaw = await env.VAE_JOBS.get(`voices:${bookId}`);
    if (voicesRaw) playback.voice_overrides = JSON.parse(voicesRaw);
    const metaRaw = await env.VAE_JOBS.get(`book:${bookId}`);
    if (metaRaw) {
      let meta = normalizeBookProgress(JSON.parse(metaRaw));
      if (meta.imaging_locked || meta.active_job_id) {
        const fresh = await ensureImagingLockFresh(env, bookId);
        meta = normalizeBookProgress(fresh.meta);
      }
      const activeImaging = Boolean(meta.imaging_locked || meta.active_job_id);
      if (activeImaging) {
        playback.stage = meta.stage || playback.stage;
        playback.progress = meta.progress ?? playback.progress;
        playback.status = meta.status || playback.status;
        playback.imaging_locked = true;
        playback.active_job_id = meta.active_job_id || null;
      } else {
        // KV catalog is authoritative when no job is running — repair stale R2 playback.
        if (playback.stage === "imaging" || playback.status === "processing" || (playback.progress ?? 1) < 1) {
          repaired = true;
        }
        playback.stage = meta.stage || "done";
        playback.progress = meta.progress ?? 1;
        playback.status = meta.status || "ready";
        playback.imaging_locked = false;
        playback.active_job_id = null;
      }
    } else if (playback.stage === "imaging" && (playback.progress ?? 0) < 1) {
      repaired = true;
      playback.stage = "done";
      playback.progress = 1;
      playback.status = "ready";
    }
  }

  if (!playback.cover) {
    const metaRaw = env.VAE_JOBS ? await env.VAE_JOBS.get(`book:${bookId}`) : null;
    const meta = metaRaw ? JSON.parse(metaRaw) : {};
    const cover = await resolveCoverUrl(env, bookId, playback, meta);
    if (cover) {
      playback.cover = cover;
      repaired = true;
      if (env.VAE_JOBS) await syncCatalogCover(env, bookId, cover);
    }
  }

  const { playback: normalized, changed } = normalizePlaybackLines(playback);
  playback = normalized;
  if (hasMomentArt || changed) {
    applyInsertsToLines(playback);
    repaired = true;
  }
  if (recompiled || changed || repaired) {
    await env.VAE_PACKS.put(
      `books/${bookId}.json`,
      JSON.stringify(playback, null, 2),
      { httpMetadata: { contentType: "application/json" } },
    );
  }

  if (analysis) {
    if (analysis.illustration_urls) playback.illustration_urls = analysis.illustration_urls;
    if (analysis.cover_illustration_ref != null) {
      playback.cover_illustration_ref = analysis.cover_illustration_ref;
    }
    const byId = Object.fromEntries((analysis.characters || []).map((c) => [c.id, c]));
    for (const [cid, c] of Object.entries(playback.characters || {})) {
      if (c.illustration_ref == null && byId[cid]?.illustration_ref != null) {
        c.illustration_ref = byId[cid].illustration_ref;
      }
    }
  }

  if (env.VAE_JOBS) {
    const { loadExternalRefs } = await import("../../_shared/external-refs.js");
    playback.external_refs = await loadExternalRefs(env, bookId);
  }

  return json(playback);
}