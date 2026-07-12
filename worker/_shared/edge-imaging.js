import {
  generateImage, composeImagePrompt, mediaUrl, r2MediaKey, artStyleKey, applyImagingPinState,
} from "./freemium-image.js";
import { compilePlayback } from "./compile-playback.js";
import { planCharacterImaging, stockSpriteUrl } from "./generic-sprites.js";
import {
  backupMediaAsset,
  writeStagingAsset,
} from "./media-versions.js";
import {
  loadStyleReferenceBytes,
  loadStyleReferencePublicUrls,
  referenceTargetsForCharacterWithStylePool,
  publicMediaOrigin,
} from "./reference-images.js";
import { expressionPromptSuffix } from "./moment-inserts.js";
import { normalizeExpressionBucket } from "./expression-bucket.js";
import { getChapterPack } from "./book-checkpoint.js";

// Expression Sensitivity Plan Phase 3d: starting subset per the plan's own
// "Open questions" note — expand once cost/quality is confirmed acceptable.
export const DEFAULT_EXPRESSIVE_BUCKETS = ["happy", "angry", "sad", "surprised"];

function characterGenDescription(c) {
  const parts = [c.description, c.name, c.id].filter(Boolean);
  let desc = String(parts[0] || c.id).trim();
  if (Array.isArray(c.appearance_changes) && c.appearance_changes.length) {
    desc += `. Current look: ${c.appearance_changes.join("; ")}`;
  }
  return desc;
}

function optionalLimit(env, key) {
  const v = parseInt(env[key], 10);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function wantsCharacter(filter, id) {
  if (!filter || filter.scope === "all") return true;
  if (filter.scope === "characters") return true;
  if (filter.scope === "selected") return (filter.character_ids || []).includes(id);
  return false;
}

/**
 * An explicit selection (scope: "selected") is a deliberate "generate THIS
 * character" signal that overrides the stock-sprite heuristic. That heuristic
 * (generic-sprites.js's useStockSprite) exists to save compute on low-dialogue
 * side characters during bulk/auto imaging — not to veto a user who explicitly
 * picked someone to regenerate. Promote any explicitly-selected stock character
 * from `fromStock` into `toGenerate` so it gets a real portrait (local_sd etc.)
 * instead of a deterministic pooled sprite. Confirmed live: Eizo (protagonist,
 * but under VAE_CUSTOM_SPRITE_MIN_LINES attributed lines in this volume's
 * prologue) was silently stock-spritzed on an explicit regen, and the empty
 * `ok` count then tripped a misleading "set GEMINI_API_KEY" error downstream.
 * Pure — returns a new plan, does not mutate its input.
 */
export function applySelectionStockOverride(plan, filter) {
  if (!filter || filter.scope !== "selected") return plan;
  const wanted = new Set(filter.character_ids || []);
  if (!wanted.size) return plan;
  const promote = plan.fromStock.filter((c) => wanted.has(c.id));
  if (!promote.length) return plan;
  return {
    ...plan,
    toGenerate: [...plan.toGenerate, ...promote],
    fromStock: plan.fromStock.filter((c) => !wanted.has(c.id)),
  };
}

function wantsCover(filter) {
  if (!filter || filter.scope === "all") return true;
  if (filter.scope === "cover") return true;
  if (filter.scope === "selected") return Boolean(filter.include_cover);
  return false;
}

function wantsBackground(filter, sid) {
  if (!filter || filter.scope === "all") return true;
  if (filter.scope === "backgrounds") return true;
  if (filter.scope === "selected") return (filter.scene_ids || []).includes(sid);
  return false;
}

async function storeGeneratedAsset({
  env, book_id, art_style, kind, key, img, compare, stageUntilConfirm,
  media, bust, beforeLive,
}) {
  if (compare && stageUntilConfirm) {
    const prevUrl = await backupMediaAsset(env, book_id, art_style, kind, key);
    const afterUrl = await writeStagingAsset(
      env, book_id, art_style, kind, key, img.bytes, img.contentType,
    );
    return {
      afterUrl: afterUrl ? `${afterUrl}?v=${bust}` : null,
      beforeUrl: beforeLive || prevUrl || null,
      promoted: false,
    };
  }

  const fname = kind === "cover"
    ? "cover.png"
    : kind === "characters"
      ? `char_${key}.png`
      : `bg_${String(key).replace(/[^\w-]+/g, "_")}.png`;
  if (compare) await backupMediaAsset(env, book_id, art_style, kind, key);
  await env.VAE_PACKS.put(r2MediaKey(book_id, art_style, fname), img.bytes, {
    httpMetadata: { contentType: img.contentType || "image/png" },
  });
  const liveUrl = mediaUrl(book_id, art_style, fname, { bust });
  if (kind === "characters") media.characters[key] = liveUrl;
  else if (kind === "cover") media.cover = liveUrl;
  else media.backgrounds[key] = liveUrl;
  return {
    afterUrl: liveUrl,
    beforeUrl: beforeLive,
    promoted: true,
  };
}

/**
 * Expression Sensitivity Plan Phase 3d: 2-4 alt-expression portrait variants
 * for a single primary character, using its base sprite as an IP-Adapter-style
 * reference so the alt-expression stays recognizably the same character.
 * Opt-in, best-effort — one bucket failing doesn't affect the others.
 * Shared by the main imaging loop (base sprite just generated, still in
 * memory) and by onMediaCommitPost's backfill path (base sprite already
 * live in R2, loaded fresh as the reference).
 *
 * @returns {{ sprites: Record<string,string>, ok: number, fail: number }}
 */
export async function generateExpressionSpritesForCharacter({
  env, book_id, art_style, character, baseImageBytes, preferProvider = "local_sd",
  expressiveBuckets = DEFAULT_EXPRESSIVE_BUCKETS, bust = Date.now(), dbg,
  onProgress = null, onProviderAttempt = null, onProviderWait = null, onImageFailure = null,
}) {
  const desc = characterGenDescription(character);
  const isHumanoid = character.is_humanoid !== false;
  const sprites = {};
  let ok = 0;
  let fail = 0;
  for (const bucket of expressiveBuckets) {
    onProgress?.({ kind: "expression_sprite", id: `${character.id}:${bucket}` });
    const exprDesc = `${desc}. ${expressionPromptSuffix(bucket)}`;
    const exprPrompt = composeImagePrompt(exprDesc, {
      subjectType: "character", style: art_style, gender: character.gender, isHumanoid,
    });
    const exprLocalPrompt = composeImagePrompt(exprDesc, {
      subjectType: "character", style: art_style, gender: character.gender, isHumanoid, compact: true,
    });
    const exprSeed = hashSeed(`${book_id}:${character.id}:${art_style}:expr:${bucket}`);
    try {
      // Pin to whatever provider already holds the warm model (default
      // local_sd, same as the just-generated base sprite) instead of
      // letting generateImage re-run the whole freemium cascade per bucket
      // — Gemini/freemium retries+timeouts between each of the 4 images
      // would burn real time for zero benefit once local_sd is already up.
      const exprImg = await generateImage(exprPrompt, {
        subjectType: "character",
        preferProvider,
        seed: exprSeed,
        env,
        localPrompt: exprLocalPrompt,
        referenceImages: [baseImageBytes],
        onAttempt: (provider) => onProviderAttempt?.(provider, { kind: "expression_sprite", id: `${character.id}:${bucket}` }),
        onProviderWait: (provider, waitMs) => onProviderWait?.(provider, { kind: "expression_sprite", id: `${character.id}:${bucket}`, waitMs }),
      });
      const fname = `char_${character.id}_expr_${bucket}.png`;
      await env.VAE_PACKS.put(r2MediaKey(book_id, art_style, fname), exprImg.bytes, {
        httpMetadata: { contentType: exprImg.contentType || "image/png" },
      });
      sprites[bucket] = mediaUrl(book_id, art_style, fname, { bust });
      ok += 1;
      dbg?.log("P3_IMAGES", `expr sprite ok ${character.id}:${bucket}`, { provider: exprImg.provider });
    } catch (e) {
      fail += 1;
      const errText = String(e.message || e).slice(0, 300);
      dbg?.log("P3_IMAGES", `expr sprite fail ${character.id}:${bucket}`, { error: errText.slice(0, 120) });
      onImageFailure?.({ kind: "expression_sprite", id: `${character.id}:${bucket}`, error: errText });
    }
  }
  return { sprites, ok, fail };
}

/** Phase 3 — freemium sprites + backgrounds → R2 + updated playback JSON. */
export async function runEdgeImaging({
  env,
  book_id,
  analysis,
  art_style,
  narrator_gender,
  dbg,
  onProgress,
  filter = null,
  existingMedia = null,
  diversify = false,
  ignorePins = false,
  preferProvider = null,
  compare = false,
  stageUntilConfirm = false,
  onComparison = null,
  onCoverReady = null,
  onProviderAttempt = null,
  onProviderWait = null,
  onImageFailure = null,
  generateExpressiveSprites = false,
  expressiveBuckets = DEFAULT_EXPRESSIVE_BUCKETS,
}) {
  const styleKey = artStyleKey(art_style);
  const maxChars = optionalLimit(env, "VAE_IMAGING_MAX_CHARS");
  const maxBgs = optionalLimit(env, "VAE_IMAGING_MAX_BGS");

  const media = {
    characters: { ...(existingMedia?.characters || {}) },
    backgrounds: { ...(existingMedia?.backgrounds || {}) },
    cover: existingMedia?.cover || null,
    inserts: { ...(existingMedia?.inserts || {}) },
    // Expression Sensitivity Plan Phase 3d: { [characterId]: { [bucket]: url } }
    expressionSprites: { ...(existingMedia?.expressionSprites || {}) },
  };
  // `ignorePins` never actually carried a prior pin into this function — a
  // regen batch always started fresh regardless of its value (dead branch,
  // both sides were `null`). It answers "respect an old pin?"; an explicit
  // `preferProvider` answers "the user picked X for this run" — unrelated,
  // so it seeds the starting pin unconditionally.
  let imagePin = preferProvider || null;
  let pollinationsAltFirst = false;
  let ok = 0;
  let fail = 0;
  let stock = 0;
  const runBust = Date.now();

  let styleRefPool = [];
  let styleRefPoolUrls = [];
  const mediaOrigin = publicMediaOrigin(env);
  if (env.VAE_PACKS) {
    for (const alt of ["anime", "semi-real", "cartoon", "pixel"]) {
      if (alt === art_style) continue;
      const blobs = await loadStyleReferenceBytes(env, book_id, alt, 3);
      if (blobs.length) {
        styleRefPool = blobs;
        styleRefPoolUrls = await loadStyleReferencePublicUrls(env, book_id, alt, mediaOrigin, 3);
        break;
      }
    }
  }

  const { toGenerate, fromStock, lineCounts, totalLines } = applySelectionStockOverride(
    planCharacterImaging(analysis, env), filter,
  );
  let chars = toGenerate.filter((c) => wantsCharacter(filter, c.id));
  if (maxChars) chars = chars.slice(0, maxChars);

  dbg?.log("P3_IMAGES", `imaging ${chars.length} custom + ${fromStock.length} stock characters`, {
    styleKey,
    capped: Boolean(maxChars),
    totalLines,
    partial: Boolean(filter),
    stageUntilConfirm,
    cover: wantsCover(filter),
  });

  if (wantsCover(filter)) {
    onProgress?.({ kind: "cover", index: 1, total: 1, id: "cover" });
    const title = analysis.title || book_id;
    const coverDesc = `Evocative book cover key art for '${title}'. No text.`;
    const prompt = composeImagePrompt(coverDesc, { subjectType: "background", style: art_style });
    const seed = hashSeed(`${book_id}:cover:${art_style}${diversify ? `:${Date.now()}` : ""}`);
    const beforeLive = media.cover || null;
    try {
      const img = await generateImage(prompt, {
        subjectType: "background",
        preferProvider: imagePin,
        seed,
        env,
        pollinationsAltFirst,
        onAttempt: (provider) => onProviderAttempt?.(provider, { kind: "cover", id: "cover" }),
        onProviderWait: (provider, waitMs) => onProviderWait?.(provider, { kind: "cover", id: "cover", waitMs }),
      });
      if (!ignorePins) {
        ({ imagePin, pollinationsAltFirst } = applyImagingPinState(
          { imagePin, pollinationsAltFirst }, img, env,
        ));
      }
      const bust = runBust;
      const stored = await storeGeneratedAsset({
        env, book_id, art_style, kind: "cover", key: "cover", img,
        compare, stageUntilConfirm, media, bust, beforeLive,
      });
      ok += 1;
      if (compare && stored.afterUrl && onComparison) {
        await onComparison({
          kind: "cover",
          key: "cover",
          before_url: stored.beforeUrl || null,
          after_url: stored.afterUrl,
        });
      }
      if (stored.promoted && stored.afterUrl) {
        onCoverReady?.(stored.afterUrl);
      }
      dbg?.log("P3_IMAGES", "cover ok", { provider: img.provider, staged: !stored.promoted });
    } catch (e) {
      fail += 1;
      const errText = String(e.message || e).slice(0, 300);
      dbg?.log("P3_IMAGES", "cover fail", { error: errText.slice(0, 120) });
      onImageFailure?.({ kind: "cover", id: "cover", error: errText });
    }
  }

  for (const c of fromStock) {
    if (!wantsCharacter(filter, c.id)) continue;
    const url = await stockSpriteUrl(c.id, c.gender, env);
    media.characters[c.id] = url;
    stock += 1;
    onProgress?.({ kind: "stock", index: stock, total: fromStock.length, id: c.id });
  }

  for (let ci = 0; ci < chars.length; ci++) {
    const c = chars[ci];
    onProgress?.({ kind: "character", index: ci + 1, total: chars.length, id: c.id });
    const desc = characterGenDescription(c);
    const isHumanoid = c.is_humanoid !== false; // unset/missing defaults to humanoid
    const prompt = composeImagePrompt(desc, { subjectType: "character", style: art_style, gender: c.gender, isHumanoid });
    const localPrompt = composeImagePrompt(desc, {
      subjectType: "character", style: art_style, gender: c.gender, isHumanoid, compact: true,
    });
    const seed = hashSeed(`${book_id}:${c.id}:${art_style}${diversify ? `:${Date.now()}` : ""}`);
    const beforeLive = media.characters[c.id] || null;
    const refTargets = await referenceTargetsForCharacterWithStylePool(
      env, book_id, analysis, c.id, art_style, { stylePool: styleRefPool, stylePoolUrls: styleRefPoolUrls },
    );
    try {
      const img = await generateImage(prompt, {
        subjectType: "character",
        preferProvider: imagePin,
        seed,
        env,
        pollinationsAltFirst,
        localPrompt,
        referenceImages: refTargets.bytes.length ? refTargets.bytes : undefined,
        referenceImageUrls: refTargets.urls.length ? refTargets.urls : undefined,
        forceReference: Boolean(filter?.force_reference),
        onAttempt: (provider) => onProviderAttempt?.(provider, { kind: "character", id: c.id }),
        onProviderWait: (provider, waitMs) => onProviderWait?.(provider, { kind: "character", id: c.id, waitMs }),
      });
      if (!ignorePins) {
        ({ imagePin, pollinationsAltFirst } = applyImagingPinState(
          { imagePin, pollinationsAltFirst }, img, env,
        ));
      }
      const bust = runBust + ci;
      const stored = await storeGeneratedAsset({
        env, book_id, art_style, kind: "characters", key: c.id, img,
        compare, stageUntilConfirm, media, bust, beforeLive,
      });
      ok += 1;
      if (compare && stored.afterUrl && onComparison) {
        await onComparison({
          kind: "characters",
          key: c.id,
          before_url: stored.beforeUrl || null,
          after_url: stored.afterUrl,
        });
      }
      dbg?.log("P3_IMAGES", `char ok ${c.id}`, { provider: img.provider, staged: !stored.promoted });

      // Expression Sensitivity Plan Phase 3d: 2-4 alt-expression portrait
      // variants for primary characters only (cost control), using the base
      // sprite just generated as a reference so the alt-expression stays
      // recognizably the same character. Opt-in, best-effort — one variant
      // failing doesn't affect the base sprite or the others. Requires
      // `stored.promoted` (not staged for compare) — see
      // onMediaCommitPost/expression-sprites-consumer.js for the backfill
      // path that covers a character confirmed later out of compare mode.
      if (generateExpressiveSprites && c.importance === "primary" && stored.promoted) {
        const { sprites: exprSprites, ok: exprOk, fail: exprFail } = await generateExpressionSpritesForCharacter({
          env, book_id, art_style, character: { ...c, id: c.id }, baseImageBytes: img.bytes,
          preferProvider: imagePin, expressiveBuckets, bust, dbg,
          onProgress: (p) => onProgress?.({ ...p, index: ci + 1, total: chars.length }),
          onProviderAttempt, onProviderWait, onImageFailure,
        });
        ok += exprOk;
        fail += exprFail;
        if (Object.keys(exprSprites).length) {
          media.expressionSprites[c.id] = { ...(media.expressionSprites[c.id] || {}), ...exprSprites };
        }
      }
    } catch (e) {
      fail += 1;
      const errText = String(e.message || e).slice(0, 300);
      dbg?.log("P3_IMAGES", `char fail ${c.id}`, { error: errText.slice(0, 120) });
      onImageFailure?.({ kind: "character", id: c.id, error: errText });
    }
  }

  const bgSeen = new Map();
  const scenes = analysis.scenes || [];
  let bgGenerated = 0;
  for (let si = 0; si < scenes.length; si++) {
    const scene = scenes[si];
    // Ignores scene.id (was `scene.id || fallback`) for the same reason
    // compile-playback.js does — the model frequently reproduces the schema
    // hint's example id ("scene-0001") literally instead of incrementing it,
    // sometimes for dozens of scenes in a row within one chapter. Trusting
    // it here meant every one of those scenes' backgrounds generated into
    // the SAME media.backgrounds key, each overwriting the last — 97 of 133
    // scenes collided into "scene-0001" on a real extracted book, so only
    // one (arbitrary, whichever finished last) background ever survived,
    // and it didn't even line up with compilePlayback's own positional ids
    // below, which never trusted scene.id in the first place. Match that
    // scheme exactly here so image keys and compiled scene ids agree.
    const sid = `scene-${String(si + 1).padStart(4, "0")}`;
    if (!wantsBackground(filter, sid)) continue;
    if (maxBgs && bgGenerated >= maxBgs) break;
    const reuse = scene.reuse_background_of;
    if (reuse && bgSeen.has(reuse)) {
      media.backgrounds[sid] = bgSeen.get(reuse);
      onProgress?.({ kind: "background", index: si + 1, total: scenes.length, id: sid, reused: true });
      continue;
    }
    onProgress?.({ kind: "background", index: si + 1, total: scenes.length, id: sid });
    const desc = scene.background_desc || scene.location || scene.title || sid;
    const prompt = composeImagePrompt(desc, { subjectType: "background", style: art_style });
    const seed = hashSeed(`${book_id}:${sid}:${art_style}${diversify ? `:${Date.now()}` : ""}`);
    const beforeLive = media.backgrounds[sid] || null;
    try {
      const img = await generateImage(prompt, {
        subjectType: "background",
        preferProvider: imagePin,
        seed,
        env,
        pollinationsAltFirst,
        onAttempt: (provider) => onProviderAttempt?.(provider, { kind: "background", id: sid }),
        onProviderWait: (provider, waitMs) => onProviderWait?.(provider, { kind: "background", id: sid, waitMs }),
      });
      if (!ignorePins) {
        ({ imagePin, pollinationsAltFirst } = applyImagingPinState(
          { imagePin, pollinationsAltFirst }, img, env,
        ));
      }
      const bust = runBust + si;
      const stored = await storeGeneratedAsset({
        env, book_id, art_style, kind: "backgrounds", key: sid, img,
        compare, stageUntilConfirm, media, bust, beforeLive,
      });
      if (stored.promoted) {
        media.backgrounds[sid] = stored.afterUrl;
        bgSeen.set(sid, stored.afterUrl);
      }
      bgGenerated += 1;
      ok += 1;
      if (compare && stored.afterUrl && onComparison) {
        await onComparison({
          kind: "backgrounds",
          key: sid,
          before_url: stored.beforeUrl || null,
          after_url: stored.afterUrl,
        });
      }
      dbg?.log("P3_IMAGES", `bg ok ${sid}`, { provider: img.provider, staged: !stored.promoted });
    } catch (e) {
      fail += 1;
      const errText = String(e.message || e).slice(0, 300);
      dbg?.log("P3_IMAGES", `bg fail ${sid}`, { error: errText.slice(0, 120) });
      onImageFailure?.({ kind: "background", id: sid, error: errText });
    }
  }

  const playback = compilePlaybackWithMedia(analysis, {
    art_style,
    narrator_gender,
    media,
  });

  dbg?.log("P3_IMAGES", "imaging complete", { ok, fail, stock, pin: imagePin });
  return { playback, media, stats: { ok, fail, stock, pin: imagePin } };
}

export function compilePlaybackWithMedia(analysis, opts) {
  const base = compilePlayback(analysis, opts);
  const { media } = opts;
  if (!media) return base;

  for (const scene of base.scenes || []) {
    const sid = scene.id;
    if (media.backgrounds[sid]) scene.background = media.backgrounds[sid];
    for (const p of scene.present || []) {
      if (media.characters[p.character_id]) {
        p.sprite = media.characters[p.character_id];
      }
    }
    // Expression Sensitivity Plan Phase 3d: sprite_url was schema-only,
    // dormant infra (server/analyze/schema.py PlaybackLine.sprite_url;
    // Player.jsx/Stage.jsx already read it) until this — set it whenever
    // this line's speaker has a generated variant for its expression bucket.
    if (media.expressionSprites) {
      for (const line of scene.lines || []) {
        const sprites = media.expressionSprites[line.character_id];
        if (!sprites) continue;
        const bucket = normalizeExpressionBucket(line.expression);
        if (sprites[bucket]) line.sprite_url = sprites[bucket];
      }
    }
  }
  if (media.characters) {
    for (const [id, url] of Object.entries(media.characters)) {
      if (base.characters?.[id]) base.characters[id].sprite = url;
    }
  }
  if (media.expressionSprites) {
    for (const [id, sprites] of Object.entries(media.expressionSprites)) {
      if (base.characters?.[id]) base.characters[id].expressionSprites = sprites;
    }
  }
  if (media.cover) base.cover = media.cover;
  return base;
}

/**
 * Aggregates whatever media (character sprites, scene backgrounds, alt-
 * expression sprites) has already been generated across a set of chapter
 * packs — the reuse seed for both the per-chapter imaging consumer (worker/
 * queue/chapter-imaging-consumer.js, only the chapters strictly before its
 * own) and the whole-book finalization phase (chapter-extract-pipeline.js,
 * every chapter) so neither regenerates a character or background that
 * parallel per-chapter imaging already produced while extraction was still
 * running on later chapters.
 */
export async function existingMediaFromChapterPacks(env, bookId, chapterPositions) {
  const media = {
    characters: {}, backgrounds: {}, cover: null, inserts: {}, expressionSprites: {},
  };
  for (const pos of chapterPositions) {
    const pack = await getChapterPack(env, bookId, pos);
    if (!pack) continue;
    for (const [id, c] of Object.entries(pack.characters || {})) {
      if (c?.sprite) media.characters[id] = c.sprite;
      if (c?.expressionSprites) {
        media.expressionSprites[id] = { ...(media.expressionSprites[id] || {}), ...c.expressionSprites };
      }
    }
    for (const s of pack.scenes || []) {
      if (s.background) media.backgrounds[s.id] = s.background;
    }
  }
  return media;
}

function hashSeed(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 2147483647;
}

export { r2MediaKey, mediaUrl };
