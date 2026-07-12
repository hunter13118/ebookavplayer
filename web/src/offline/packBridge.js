/** Active offline pack context + URL/audio resolution for playback. */
import { getInstalledPack, getInstalledPackForBook, getBlob, putBlob } from "./packStore.js";
import { TIER_AUDIOBOOK } from "./packFormat.js";

let activePackId = null;
const mediaUrlCache = new Map();
const serverUrlCache = new Map();

export function setActiveOfflinePack(packId) {
  if (activePackId && activePackId !== packId) clearMediaUrlCache(activePackId);
  activePackId = packId || null;
}

export function getActiveOfflinePackId() {
  return activePackId;
}

export function lookupCachedMediaUrl(serverUrl) {
  if (!serverUrl || !activePackId) return null;
  const base = serverUrl.split("?", 1)[0];
  return serverUrlCache.get(`${activePackId}::${base}`) || null;
}

export function clearMediaUrlCache(packId = activePackId) {
  for (const [k, url] of mediaUrlCache.entries()) {
    if (!packId || k.startsWith(`${packId}::`)) {
      URL.revokeObjectURL(url);
      mediaUrlCache.delete(k);
    }
  }
  for (const k of [...serverUrlCache.keys()]) {
    if (!packId || k.startsWith(`${packId}::`)) serverUrlCache.delete(k);
  }
}

/** Drop just the in-memory blob-url cache entries for one asset, rather than
 * the whole pack's (see clearMediaUrlCache) — used by patchOfflineMediaAsset
 * so patching one regenerated sprite doesn't force every other cached
 * image/audio blob url in the pack to be recreated on next render too. */
function clearMediaUrlCacheForPath(packId, base, packPath) {
  const serverKey = `${packId}::${base}`;
  serverUrlCache.delete(serverKey);
  const blobKey = `${packId}::${packPath}`;
  const url = mediaUrlCache.get(blobKey);
  if (url) {
    URL.revokeObjectURL(url);
    mediaUrlCache.delete(blobKey);
  }
}

export async function warmOfflineMedia(pack) {
  if (!pack?.media_index) return;
  setActiveOfflinePack(pack.pack_id);
  await Promise.all(Object.keys(pack.media_index).map((url) => resolveOfflineMediaUrl(url)));
}

export async function activatePackForBook(bookId) {
  const pack = await getInstalledPackForBook(bookId);
  setActiveOfflinePack(pack?.pack_id || null);
  return pack;
}

export async function getActivePack() {
  if (!activePackId) return null;
  return getInstalledPack(activePackId);
}

export async function resolveOfflineMediaUrl(serverUrl) {
  if (!serverUrl || !activePackId) return null;
  const base = serverUrl.split("?", 1)[0];
  const hit = serverUrlCache.get(`${activePackId}::${base}`);
  if (hit) return hit;
  const pack = await getActivePack();
  if (!pack?.media_index) return null;
  const packPath = pack.media_index[base];
  if (!packPath) return null;
  const cacheKey = `${activePackId}::${packPath}`;
  if (mediaUrlCache.has(cacheKey)) {
    const url = mediaUrlCache.get(cacheKey);
    serverUrlCache.set(`${activePackId}::${base}`, url);
    return url;
  }
  const blob = await getBlob(activePackId, packPath);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  mediaUrlCache.set(cacheKey, url);
  serverUrlCache.set(`${activePackId}::${base}`, url);
  return url;
}

/**
 * Refresh ONE offline-cached asset in place after a regen commits/reverts,
 * instead of requiring a full pack re-download. A regen only ever changes
 * bytes at an existing media path (character sprite, background, cover) —
 * the pack's media_index already maps that server path to a storage key
 * from the original install, so there's no manifest work to do, just:
 * fetch the new bytes, overwrite the stored blob at the SAME storage key,
 * and drop the in-memory blob-url cache entry for that one path so the
 * next render re-derives a fresh blob url instead of reusing the stale one.
 *
 * Root cause this fixes: media.js/packBridge strip the `?v=` cache-bust
 * query before resolving against the offline pack (media_index is keyed by
 * bare path — see server/pack/build.py's collect_media_urls), so an
 * installed book kept serving the pre-regen blob forever; the live `?v=`
 * URL updating correctly server-side never had any effect on offline
 * playback. No-ops (cheaply) for a book with no installed pack, or for a
 * path that was never part of the pack to begin with — same as
 * resolveOfflineMediaUrl's own miss behavior, since a full pack rebuild is
 * still the right tool for "add a wholly new asset to an existing pack".
 */
export async function patchOfflineMediaAsset(bookId, serverUrl) {
  if (!serverUrl) return false;
  const pack = await getInstalledPackForBook(bookId);
  if (!pack?.media_index) return false;
  const base = serverUrl.split("?", 1)[0];
  const packPath = pack.media_index[base];
  if (!packPath) return false;
  const res = await fetch(serverUrl);
  if (!res.ok) return false;
  const blob = await res.blob();
  await putBlob(pack.pack_id, packPath, blob);
  clearMediaUrlCacheForPath(pack.pack_id, base, packPath);
  return true;
}

const audioByLine = new Map();

export async function getOfflineAudioBlob(line) {
  if (!activePackId || !line) return null;
  const pack = await getActivePack();
  if (!pack || pack.tier !== TIER_AUDIOBOOK) return null;
  const idx = line.idx != null ? line.idx : null;
  if (idx == null) return null;

  const cacheKey = `${activePackId}::audio::${idx}`;
  if (audioByLine.has(cacheKey)) return audioByLine.get(cacheKey);

  const entry = (pack.audio_manifest || []).find((a) => a.line_idx === idx);
  if (!entry?.path) return null;
  const blob = await getBlob(activePackId, entry.path);
  if (blob) audioByLine.set(cacheKey, blob);
  return blob || null;
}

export function packSupportsOfflineAudio(pack) {
  return pack?.tier === TIER_AUDIOBOOK && (pack.audio_manifest?.length || 0) > 0;
}

export function isOfflinePlaybackReady(pack) {
  return Boolean(pack?.book);
}
