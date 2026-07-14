import { packDownloadResponse, tryPackFromR2 } from "../../_shared/r2-packs.js";

/** GET pack build file — R2 fast path, then KV job status. */
export async function onPackBuildFileGet({ env, bookId, jobId }) {
  const hit = await tryPackFromR2(env, { jobId });
  if (hit) {
    return packDownloadResponse(hit.obj, `${bookId}.vaepack`);
  }

  if (env.VAE_JOBS) {
    const raw = await env.VAE_JOBS.get(`job:${jobId}`);
    if (raw) {
      const st = JSON.parse(raw);
      if (st.book_id && st.book_id !== bookId) {
        return Response.json({ error: "job book mismatch" }, { status: 404 });
      }
      if (st.r2_key) {
        const obj = await env.VAE_PACKS?.get(st.r2_key);
        if (obj) return packDownloadResponse(obj, `${bookId}.vaepack`);
      }
      if (st.status !== "done") {
        return Response.json(
          {
            error: "pack not ready",
            status: st.status,
            progress: st.progress ?? 0,
            detail: st.detail || "",
            ready: false,
          },
          { status: 409 },
        );
      }
      return Response.json(
        { error: "pack file missing in storage", job_id: jobId, detail: st.detail || "" },
        { status: 404 },
      );
    }
  }

  return Response.json(
    { error: "pack not found — start a build and wait until ready=true", job_id: jobId },
    { status: 404 },
  );
}

/** GET cached pack by content hash (optional CDN-style route). */
export async function onPackCacheGet({ env, cacheKey, bookId }) {
  const hit = await tryPackFromR2(env, { cacheKey });
  if (!hit) return Response.json({ error: "not found" }, { status: 404 });
  return packDownloadResponse(hit.obj, `${bookId || "pack"}.${cacheKey}.vaepack`);
}

/** POST pack build — enqueue on the edge job queue. */
export async function onPackBuildPost({ env, bookId, body }) {
  if (!env.VAE_JOBS_QUEUE && !env.VAE_PACK_QUEUE) {
    return Response.json({ error: "no pack build queue configured" }, { status: 503 });
  }
  const jobId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const msg = {
    kind: "pack-build",
    job_id: jobId,
    book_id: bookId,
    tier: body?.tier || "audiobook",
    style: body?.style || null,
    force: Boolean(body?.force),
  };
  await (env.VAE_JOBS_QUEUE || env.VAE_PACK_QUEUE).send(msg);
  if (env.VAE_JOBS) {
    await env.VAE_JOBS.put(`job:${jobId}`, JSON.stringify({
      ...msg,
      status: "queued",
      progress: 0,
      detail: "queued on Cloudflare",
    }), { expirationTtl: 86400 });
  }
  return Response.json({
    job_id: jobId,
    book_id: bookId,
    tier: msg.tier,
    style: msg.style || "",
    status: "queued",
    progress: 0,
    detail: "queued",
    ready: false,
    cached: false,
    queued: true,
  });
}

/** POST cancel pack build — KV job update. */
export async function onPackBuildCancelPost({ env, bookId, jobId }) {
  if (env.VAE_JOBS) {
    const key = `job:${jobId}`;
    const raw = await env.VAE_JOBS.get(key);
    if (raw) {
      const st = JSON.parse(raw);
      if (st.book_id && st.book_id !== bookId) {
        return Response.json({ error: "job book mismatch" }, { status: 404 });
      }
      if (st.status === "done") {
        return Response.json({ error: "job cannot be cancelled" }, { status: 409 });
      }
      if (st.status === "cancelled") {
        return Response.json({ ...st, ready: false });
      }
      const updated = {
        ...st,
        status: "cancelled",
        detail: "cancelled",
        ready: false,
        cancelled: true,
      };
      await env.VAE_JOBS.put(key, JSON.stringify(updated), { expirationTtl: 86400 });
      return Response.json(updated);
    }
  }
  return Response.json({ error: "no such pack job" }, { status: 404 });
}

/** GET external audio manifest — R2 when present, stub otherwise. */
export async function onAudioManifestGet({ env, bookId }) {
  if (env.VAE_PACKS) {
    const manifestObj = await env.VAE_PACKS.get(`books/${bookId}/audio/manifest.json`);
    if (manifestObj) {
      const pack = JSON.parse(await manifestObj.text());
      return Response.json({ book_id: bookId, available: true, ...pack });
    }
    const bookObj = await env.VAE_PACKS.get(`books/${bookId}.json`);
    if (bookObj) {
      return Response.json({ book_id: bookId, available: false, line_count: 0 });
    }
  }
  return Response.json({ book_id: bookId, available: false, line_count: 0 });
}

/** Poll job status — KV (edge pack build). */
export async function onPackBuildStatusGet({ env, bookId, jobId }) {
  if (env.VAE_JOBS) {
    const raw = await env.VAE_JOBS.get(`job:${jobId}`);
    if (raw) {
      const st = JSON.parse(raw);
      if (st.book_id && st.book_id !== bookId) {
        return Response.json({ error: "job book mismatch" }, { status: 404 });
      }
      return Response.json({
        ...st,
        ready: st.status === "done" && Boolean(st.r2_key || st.path),
        log: st.log || (st.debug_log || []).map((e) => `[${e.phase}] ${e.msg}`),
        debug_log: st.debug_log || [],
      });
    }
  }
  return Response.json({ error: "no such pack job" }, { status: 404 });
}
