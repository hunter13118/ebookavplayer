import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  setActiveOfflinePack,
  getActiveOfflinePackId,
  lookupCachedMediaUrl,
  warmOfflineMedia,
  getOfflineAudioBlob,
  packSupportsOfflineAudio,
  clearMediaUrlCache,
  patchOfflineMediaAsset,
  resolveOfflineMediaUrl,
} from "./packBridge.js";
import { importPackZip } from "./packIo.js";
import { buildTestPackZip, TIER_AUDIOBOOK } from "./testPackFixtures.js";
import { clearAllPacksForTests, getBlob } from "./packStore.js";

describe("packBridge", () => {
  beforeEach(async () => {
    await clearAllPacksForTests();
    clearMediaUrlCache();
    setActiveOfflinePack(null);
  });

  it("activates pack and warms media URLs", async () => {
    const rec = await importPackZip(buildTestPackZip());
    await warmOfflineMedia(rec);
    expect(getActiveOfflinePackId()).toBe(rec.pack_id);
    const url = lookupCachedMediaUrl("/media/pack-test/semi-real/bg_s1.png");
    expect(url).toMatch(/^blob:/);
  });

  it("returns offline audio blob for audiobook tier", async () => {
    const rec = await importPackZip(buildTestPackZip({ tier: TIER_AUDIOBOOK, withAudio: true }));
    setActiveOfflinePack(rec.pack_id);
    const line = rec.book.scenes[0].lines[0];
    const blob = await getOfflineAudioBlob(line);
    expect(blob).toBeTruthy();
    expect(blob.size).toBeGreaterThan(0);
  });

  it("returns null audio for visual tier", async () => {
    const rec = await importPackZip(buildTestPackZip());
    setActiveOfflinePack(rec.pack_id);
    const blob = await getOfflineAudioBlob(rec.book.scenes[0].lines[0]);
    expect(blob).toBeNull();
  });

  it("packSupportsOfflineAudio reflects tier + manifest", async () => {
    const visual = await importPackZip(buildTestPackZip());
    const audio = await importPackZip(buildTestPackZip({
      book: { ...visual.book, book_id: "audio-only" },
      tier: TIER_AUDIOBOOK,
      withAudio: true,
    }));
    expect(packSupportsOfflineAudio(visual)).toBe(false);
    expect(packSupportsOfflineAudio(audio)).toBe(true);
  });

  describe("patchOfflineMediaAsset", () => {
    // Root cause of a real, confirmed-live bug: media.js/packBridge strip
    // the `?v=` cache-bust query before resolving against the offline
    // pack's media_index (keyed by bare path), so an installed book kept
    // serving the pre-regen blob forever after a character-art regen —
    // the live `?v=` URL updated correctly server-side, but that never
    // touched offline playback at all. This patches the ONE changed asset
    // in place instead of requiring a full pack re-download.
    const serverUrl = "/media/pack-test/semi-real/bg_s1.png";
    const newBytes = new Uint8Array([1, 2, 3, 4, 5]);

    beforeEach(() => {
      global.fetch = vi.fn(async (url) => {
        if (String(url).split("?")[0] === serverUrl) {
          return { ok: true, blob: async () => new Blob([newBytes], { type: "image/png" }) };
        }
        throw new Error(`unexpected fetch ${url}`);
      });
    });

    it("overwrites the stored blob at the existing pack path", async () => {
      const rec = await importPackZip(buildTestPackZip());
      const ok = await patchOfflineMediaAsset(rec.book_id, `${serverUrl}?v=999`);
      expect(ok).toBe(true);

      const stored = await getBlob(rec.pack_id, rec.media_index[serverUrl]);
      const bytes = new Uint8Array(await stored.arrayBuffer());
      expect([...bytes]).toEqual([...newBytes]);
    });

    it("evicts only the patched asset's in-memory blob-url cache entry", async () => {
      const rec = await importPackZip(buildTestPackZip());
      await warmOfflineMedia(rec);
      const before = await resolveOfflineMediaUrl(serverUrl);
      expect(before).toMatch(/^blob:/);

      await patchOfflineMediaAsset(rec.book_id, `${serverUrl}?v=999`);
      const after = await resolveOfflineMediaUrl(serverUrl);

      expect(after).toMatch(/^blob:/);
      expect(after).not.toBe(before); // stale object URL must not be reused
    });

    it("is a no-op when the book has no installed pack", async () => {
      const ok = await patchOfflineMediaAsset("never-installed", `${serverUrl}?v=999`);
      expect(ok).toBe(false);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("is a no-op when the path was never part of the pack", async () => {
      const rec = await importPackZip(buildTestPackZip());
      const ok = await patchOfflineMediaAsset(rec.book_id, "/media/pack-test/semi-real/char_new.png?v=1");
      expect(ok).toBe(false);
    });
  });
});
