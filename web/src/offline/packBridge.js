/** Active offline pack context + URL/audio resolution for playback. */
import { getInstalledPack, getInstalledPackForBook, getBlob } from "./packStore.js";
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
