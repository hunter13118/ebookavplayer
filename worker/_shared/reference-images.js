/** Reference plates for character / moment image gen — EPUB art, sprites, cross-style. */
import { r2MediaKey } from "./freemium-image.js";

const MAX_REFS = 3;

export function publicMediaOrigin(env) {
  return String(env?.PUBLIC_MEDIA_ORIGIN || env?.VAE_PUBLIC_ORIGIN || "").replace(/\/$/, "");
}

/** Turn `/media/...` into an absolute URL Pollinations can fetch (requires PUBLIC_MEDIA_ORIGIN in prod). */
export function absoluteMediaUrl(origin, publicPath) {
  if (!publicPath?.startsWith("/media/")) return null;
  if (!origin) return null;
  return `${origin}${publicPath.split("?")[0]}`;
}

export function spritePublicUrl(bookId, artStyle, characterId) {
  return `/media/${bookId}/${artStyle}/char_${characterId}.png`;
}

export function guessImageExt(blob) {
  const u8 = new Uint8Array(blob);
  if (u8.length >= 8 && u8[0] === 0x89 && u8[1] === 0x50) return ".png";
  if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xd8) return ".jpg";
  if (u8.length > 12 && u8[0] === 0x52 && u8[1] === 0x49 && u8[8] === 0x57 && u8[9] === 0x45) return ".webp";
  const head = new TextDecoder().decode(u8.slice(0, Math.min(256, u8.length))).trim();
  if (head.startsWith("<?xml") || head.startsWith("<svg") || head.includes("<svg")) return ".svg";
  return ".jpg";
}

function contentTypeForExt(ext) {
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  return "image/jpeg";
}

export function r2IllustrationKey(bookId, filename) {
  return `media/${bookId}/illustrations/${filename}`;
}

export function illustrationPublicUrl(bookId, filename) {
  return `/media/${bookId}/illustrations/${filename}`;
}

/** Persist raw EPUB images → R2; return { index: publicUrl }. */
export async function persistEpubImages(env, bookId, imageByteArrays) {
  if (!env?.VAE_PACKS || !imageByteArrays?.length) return {};
  const urls = {};
  for (let i = 0; i < imageByteArrays.length; i += 1) {
    const blob = imageByteArrays[i];
    if (!blob?.byteLength) continue;
    const ext = guessImageExt(blob);
    const fname = `img_${String(i).padStart(3, "0")}${ext}`;
    await env.VAE_PACKS.put(r2IllustrationKey(bookId, fname), blob, {
      httpMetadata: { contentType: contentTypeForExt(ext) },
    });
    urls[i] = illustrationPublicUrl(bookId, fname);
  }
  return urls;
}

/** Map /media/... public URL → R2 object key. */
export function mediaUrlToR2Key(url) {
  if (!url?.startsWith("/media/")) return null;
  return `media/${url.slice("/media/".length).split("?")[0]}`;
}

/** Load bytes for a persisted /media/... asset. */
export async function loadMediaBytes(env, publicUrl) {
  if (!env?.VAE_PACKS || !publicUrl) return null;
  const key = mediaUrlToR2Key(publicUrl);
  if (!key) return null;
  const obj = await env.VAE_PACKS.get(key);
  if (!obj) return null;
  try {
    return await obj.arrayBuffer();
  } catch {
    return null;
  }
}

async function loadIllustrationTargets(env, bookId, indices, catalog, origin) {
  const bytes = [];
  const urls = [];
  for (const idx of indices) {
    let pub = catalog?.[idx] ?? catalog?.[String(idx)];
    if (!pub) {
      const base = `img_${String(idx).padStart(3, "0")}`;
      for (const ext of [".png", ".jpg", ".webp", ".jpeg"]) {
        const candidate = illustrationPublicUrl(bookId, `${base}${ext}`);
        const b = await loadMediaBytes(env, candidate);
        if (b) {
          pub = candidate;
          bytes.push(b);
          const abs = absoluteMediaUrl(origin, candidate);
          if (abs) urls.push(abs);
          break;
        }
      }
      continue;
    }
    const b = await loadMediaBytes(env, pub);
    if (b) bytes.push(b);
    const abs = absoluteMediaUrl(origin, pub);
    if (abs) urls.push(abs);
  }
  return { bytes, urls };
}

/** @returns {{ bytes: ArrayBuffer[], urls: string[] }} */
export async function referenceTargetsForCharacter(env, bookId, analysis, characterId, artStyle) {
  if (!env?.VAE_PACKS || !bookId) return { bytes: [], urls: [] };

  const origin = publicMediaOrigin(env);
  const catalog = analysis?.illustration_urls || {};
  const byId = Object.fromEntries((analysis?.characters || []).map((c) => [c.id, c]));
  const char = characterId ? byId[characterId] : null;
  const bytes = [];
  const urls = [];

  const { loadExternalRefs, externalRefUrlsForCharacter, fetchExternalRefBytes } = await import(
    "./external-refs.js"
  );
  // character.reference_images (worker/_shared/character-merge.js's
  // addCharacterReferenceImageIn{Analysis,Playback}) is the highest-priority
  // source: it's the cleanest possible signal — either a face+upper-body
  // crop from the illustration-character-match pass (see
  // illustration-character-match-consumer.js), or a picture the user
  // deliberately uploaded specifically as this character's reference. Both
  // are strictly better than a whole multi-character plate or an unrelated
  // external URL. This field previously wasn't read here at all — it was
  // stored (visible in Character settings) but never actually reached
  // generateImage().
  if (char?.reference_images?.length) {
    for (const url of char.reference_images.slice(0, MAX_REFS)) {
      const b = await loadMediaBytes(env, url);
      if (b) bytes.push(b);
      const abs = absoluteMediaUrl(origin, url);
      if (abs) urls.push(abs);
    }
  }

  const extRefs = await loadExternalRefs(env, bookId);
  const extUrls = externalRefUrlsForCharacter(extRefs, characterId);
  if (extUrls.length) {
    urls.push(...extUrls.slice(0, MAX_REFS));
    const extBytes = await fetchExternalRefBytes(extUrls, { limit: MAX_REFS });
    bytes.push(...extBytes);
  }

  // Only use an illustration plate as this character's reference when
  // illustration_ref is explicitly set — either by the model's own match
  // during extraction, or by the user via EpubPlatesSheet's manual
  // assignment. There used to be a fallback here that grabbed the first few
  // catalog plates *unconditionally* whenever the catalog was non-empty,
  // with zero guarantee any of them actually depicted this character (could
  // just as easily be a random background, the book's own cover, or a
  // completely different character's plate). Beyond being speculative, it
  // had a much sharper cost: generateImage() (freemium-image.js) treats any
  // non-empty referenceImages/referenceImageUrls as "reference-backed
  // generation" and takes a Gemini-image / Pollinations-i2i-only code path
  // that never falls through to local_sd at all — so on a book with EPUB
  // plates but no confirmed character matches (the common case today, since
  // the "who's pictured in this plate" LLM pass is still unbuilt — see
  // docs/TODO_ILLUSTRATIONS_PROFILES_POLISH.md item 2), every character
  // portrait silently required cloud API keys with no local fallback,
  // even for a fully local extraction+imaging setup.
  const illusRef = char?.illustration_ref;
  if (illusRef != null && Number.isFinite(Number(illusRef))) {
    const t = await loadIllustrationTargets(env, bookId, [Number(illusRef)], catalog, origin);
    bytes.push(...t.bytes);
    urls.push(...t.urls);
  }

  // Only fall back to the character's current live sprite when NONE of the
  // higher-priority sources above (explicit reference_images, external refs,
  // illustration_ref) actually found anything — this block used to `unshift`
  // unconditionally, which meant the live sprite always won bytes[0] even
  // when an explicit reference crop was already in `bytes`, since local_sd
  // (freemium-image.js's tryLocalSd) only ever sends referenceImages[0].
  // Confirmed live: a character with a clean, explicitly-assigned reference
  // crop still got conditioned on their own broken "character sheet" grid
  // sprite, because the grid sprite silently displaced the real reference
  // instead of only being used when there was nothing better.
  if (characterId && bytes.length === 0) {
    const pub = spritePublicUrl(bookId, artStyle, characterId);
    const spriteKey = r2MediaKey(bookId, artStyle, `char_${characterId}.png`);
    const spriteObj = await env.VAE_PACKS.get(spriteKey);
    if (spriteObj) {
      try {
        bytes.unshift(await spriteObj.arrayBuffer());
        const abs = absoluteMediaUrl(origin, pub);
        if (abs) urls.unshift(abs);
      } catch { /* ignore */ }
    }
  }

  return {
    bytes: bytes.filter(Boolean).slice(0, MAX_REFS),
    urls: [...new Set(urls.filter(Boolean))].slice(0, MAX_REFS),
  };
}

/** Pick reference plates for a character sprite (mirrors server/playback/illustrations.py). */
export async function referenceBytesForCharacter(env, bookId, analysis, characterId, artStyle) {
  const { bytes } = await referenceTargetsForCharacter(env, bookId, analysis, characterId, artStyle);
  return bytes.length ? bytes : null;
}

/** @returns {{ bytes: ArrayBuffer[], urls: string[] }} */
export async function referenceTargetsForMoment(env, bookId, analysis, scene, line, artStyle) {
  const primaryId = line?.character_id;
  const origin = publicMediaOrigin(env);
  const primary = await referenceTargetsForCharacter(env, bookId, analysis, primaryId, artStyle);
  const bytes = [...primary.bytes];
  const urls = [...primary.urls];

  const present = scene?.present_character_ids || [];
  for (const cid of present) {
    if (!cid || cid === primaryId || bytes.length >= MAX_REFS) continue;
    const spriteKey = r2MediaKey(bookId, artStyle, `char_${cid}.png`);
    const obj = await env.VAE_PACKS.get(spriteKey);
    if (!obj) continue;
    try {
      bytes.push(await obj.arrayBuffer());
      const abs = absoluteMediaUrl(origin, spritePublicUrl(bookId, artStyle, cid));
      if (abs) urls.push(abs);
    } catch { /* ignore */ }
  }

  const lineRef = line?.illustration_ref;
  if (lineRef != null && bytes.length < MAX_REFS) {
    const catalog = analysis?.illustration_urls || {};
    const plates = await loadIllustrationTargets(env, bookId, [Number(lineRef)], catalog, origin);
    for (const b of plates.bytes) {
      if (bytes.length >= MAX_REFS) break;
      bytes.push(b);
    }
    for (const u of plates.urls) {
      if (urls.length >= MAX_REFS) break;
      urls.push(u);
    }
  }

  return {
    bytes: bytes.filter(Boolean).slice(0, MAX_REFS),
    urls: [...new Set(urls.filter(Boolean))].slice(0, MAX_REFS),
  };
}

/** Load public URLs for sprites in another art style (for Pollinations i2i). */
// Matches a committed, live asset — excludes `.next.` (staged, awaiting
// user review via the compare UI, never confirmed) and `.prev.` (a
// superseded backup, kept only so a commit can be reverted). Both are named
// media-versions.js's stagingFilename/prevFilename convention. Without this,
// an abandoned staged-comparison job's never-promoted `.next.png` files get
// picked up here as if they were confirmed style references — confirmed as
// a real bug: they silently forced every character generation into
// generateImage()'s reference-backed-only code path (no local_sd fallback)
// on a book that had never actually confirmed ANY cross-style media.
const LIVE_IMAGE_RE = /^(?!.*\.(next|prev)\.)(?:.*)\.(png|jpe?g|webp)$/i;

export async function loadStyleReferencePublicUrls(env, bookId, sourceStyle, origin, limit = 3) {
  if (!env?.VAE_PACKS || !bookId || !sourceStyle || !origin) return [];
  const prefix = `media/${bookId}/${sourceStyle}/char_`;
  const urls = [];
  let cursor;
  do {
    const listed = await env.VAE_PACKS.list({ prefix, cursor, limit: 20 });
    for (const obj of listed.objects || []) {
      if (!LIVE_IMAGE_RE.test(obj.key)) continue;
      const rel = obj.key.replace(/^media\//, "");
      const abs = absoluteMediaUrl(origin, `/media/${rel}`);
      if (abs) urls.push(abs);
      if (urls.length >= limit) return urls;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  const coverKey = `media/${bookId}/${sourceStyle}/cover.png`;
  const coverAbs = absoluteMediaUrl(origin, `/media/${bookId}/${sourceStyle}/cover.png`);
  if (coverAbs && !urls.length) {
    const cover = await env.VAE_PACKS.get(coverKey);
    if (cover) urls.push(coverAbs);
  }
  return urls.slice(0, limit);
}

/** Load PNG/JPG refs from another art style (style-conversion regen). */
export async function loadStyleReferenceBytes(env, bookId, sourceStyle, limit = 6) {
  if (!env?.VAE_PACKS || !bookId || !sourceStyle) return [];
  const prefixes = [`media/${bookId}/${sourceStyle}/char_`, `media/${bookId}/${sourceStyle}/bg_`];
  const coverKey = `media/${bookId}/${sourceStyle}/cover.png`;
  const blobs = [];

  const cover = await env.VAE_PACKS.get(coverKey);
  if (cover) {
    try { blobs.push(await cover.arrayBuffer()); } catch { /* ignore */ }
  }

  let cursor;
  for (const prefix of prefixes) {
    if (blobs.length >= limit) break;
    cursor = undefined;
    do {
      const listed = await env.VAE_PACKS.list({ prefix, cursor, limit: 20 });
      for (const obj of listed.objects || []) {
        if (!LIVE_IMAGE_RE.test(obj.key)) continue;
        const item = await env.VAE_PACKS.get(obj.key);
        if (!item) continue;
        try {
          blobs.push(await item.arrayBuffer());
        } catch { /* ignore */ }
        if (blobs.length >= limit) break;
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor && blobs.length < limit);
  }

  return blobs.slice(0, limit);
}

/** Merge per-character refs with optional cross-style style plates (cap at MAX_REFS). */
export async function referenceTargetsForCharacterWithStylePool(
  env, bookId, analysis, characterId, artStyle, { stylePool = null, stylePoolUrls = null } = {},
) {
  const charTargets = await referenceTargetsForCharacter(env, bookId, analysis, characterId, artStyle);
  const pool = (stylePool || []).filter(Boolean);
  const poolUrls = (stylePoolUrls || []).filter(Boolean);
  if (!pool.length && !poolUrls.length) return charTargets;

  const bytes = [...charTargets.bytes];
  const urls = [...charTargets.urls];
  for (const b of pool) {
    if (bytes.length >= MAX_REFS) break;
    bytes.push(b);
  }
  for (const u of poolUrls) {
    if (urls.length >= MAX_REFS) break;
    urls.push(u);
  }
  return {
    bytes: bytes.slice(0, MAX_REFS),
    urls: [...new Set(urls)].slice(0, MAX_REFS),
  };
}

export async function referenceBytesForCharacterWithStylePool(
  env, bookId, analysis, characterId, artStyle, opts = {},
) {
  const { bytes } = await referenceTargetsForCharacterWithStylePool(
    env, bookId, analysis, characterId, artStyle, opts,
  );
  return bytes.length ? bytes : null;
}

/** @deprecated use referenceTargetsForMoment */
export async function referenceBytesForMoment(env, bookId, analysis, scene, line, artStyle) {
  const { bytes } = await referenceTargetsForMoment(env, bookId, analysis, scene, line, artStyle);
  return bytes.length ? bytes : null;
}
