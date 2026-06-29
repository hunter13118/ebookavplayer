/** vae-offline-pack v1 — client-side format constants (mirrors server/pack/format.py). */
export const FORMAT_ID = "vae-offline-pack";
export const FORMAT_VERSION = 1;

export const MANIFEST_NAME = "vae/manifest.json";
export const BOOK_NAME = "vae/book.json";
export const VOICES_NAME = "vae/voices.json";
export const MEDIA_INDEX_NAME = "vae/media/index.json";
export const MEDIA_PREFIX = "vae/media/files/";
export const AUDIO_MANIFEST_NAME = "vae/audio/manifest.json";
export const AUDIO_PREFIX = "vae/audio/lines/";

export const TIER_VISUAL = "visual";
export const TIER_AUDIOBOOK = "audiobook";

export function packFilename(manifest) {
  const id = manifest?.book_id || "book";
  const style = manifest?.style || "style";
  const tier = manifest?.tier || TIER_VISUAL;
  return `${id}.${style}.${tier}.vaepack`;
}

export function validateManifest(m) {
  if (!m || m.format !== FORMAT_ID) throw new Error("not a vae-offline-pack");
  if (m.format_version !== FORMAT_VERSION) throw new Error("unsupported pack format version");
  if (!m.book_id || !m.pack_id) throw new Error("invalid pack manifest");
  return m;
}

/** Namespaced local storage key for a pack asset blob. */
export function blobKey(packId, path) {
  return `${packId}::${path}`;
}

export function tierLabel(tier) {
  if (tier === TIER_AUDIOBOOK) return "Full offline (script + art + audio)";
  return "Visual only (script + art; voices need network)";
}

export function tierShort(tier) {
  return tier === TIER_AUDIOBOOK ? "audiobook" : "visual";
}
