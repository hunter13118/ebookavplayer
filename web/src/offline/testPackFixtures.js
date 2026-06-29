/** Shared minimal vae-offline-pack bytes for unit + e2e tests. */
import { zipSync } from "fflate";
import {
  FORMAT_ID, FORMAT_VERSION, MANIFEST_NAME, BOOK_NAME, VOICES_NAME,
  MEDIA_INDEX_NAME, AUDIO_MANIFEST_NAME, MEDIA_PREFIX, AUDIO_PREFIX,
  TIER_VISUAL, TIER_AUDIOBOOK,
} from "./packFormat.js";

export function minimalBook(overrides = {}) {
  return {
    book_id: "pack-test",
    title: "Pack Test Book",
    author: "Tester",
    scenes: [{
      id: "s1",
      title: "Scene 1",
      background: "/media/pack-test/semi-real/bg_s1.png",
      present: [{ character_id: "narrator", name: "Narrator" }],
      lines: [{
        idx: 0,
        text: "Hello offline.",
        character_id: "narrator",
        voice: "en-US-AndrewMultilingualNeural",
      }],
    }],
    ...overrides,
  };
}

export function buildTestPackZip({
  book = minimalBook(),
  tier = TIER_VISUAL,
  style = "semi-real",
  withMedia = true,
  withAudio = false,
} = {}) {
  const enc = new TextEncoder();
  const bookId = book.book_id;
  const packId = `${bookId}@${style}@${tier}`;
  const mediaPath = `${MEDIA_PREFIX}${bookId}/${style}/bg_s1.png`;
  const mediaIndex = {};
  if (withMedia) {
    mediaIndex[`/media/${bookId}/${style}/bg_s1.png`] = mediaPath;
  }

  const files = {};
  files[MANIFEST_NAME] = enc.encode(JSON.stringify({
    format: FORMAT_ID,
    format_version: FORMAT_VERSION,
    pack_id: packId,
    book_id: bookId,
    title: book.title,
    author: book.author,
    tier,
    style,
    audio_engine: withAudio ? "edge-tts" : null,
    media_count: Object.keys(mediaIndex).length,
    audio_line_count: withAudio ? 1 : 0,
    line_count: 1,
  }, null, 2));
  files[BOOK_NAME] = enc.encode(JSON.stringify(book, null, 2));
  files[VOICES_NAME] = enc.encode("{}");
  files[MEDIA_INDEX_NAME] = enc.encode(JSON.stringify(mediaIndex, null, 2));

  if (withMedia) {
    files[mediaPath] = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  }

  if (withAudio || tier === TIER_AUDIOBOOK) {
    const audioPath = `${AUDIO_PREFIX}000000.mp3`;
    files[AUDIO_MANIFEST_NAME] = enc.encode(JSON.stringify([{
      line_idx: 0,
      path: audioPath,
      bytes: 4,
    }], null, 2));
    files[audioPath] = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
  }

  return zipSync(files, { level: 0 });
}

export { TIER_VISUAL, TIER_AUDIOBOOK };
