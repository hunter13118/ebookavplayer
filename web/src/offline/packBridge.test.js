import { beforeEach, describe, expect, it } from "vitest";
import {
  setActiveOfflinePack,
  getActiveOfflinePackId,
  lookupCachedMediaUrl,
  warmOfflineMedia,
  getOfflineAudioBlob,
  packSupportsOfflineAudio,
  clearMediaUrlCache,
} from "./packBridge.js";
import { importPackZip } from "./packIo.js";
import { buildTestPackZip, TIER_AUDIOBOOK } from "./testPackFixtures.js";
import { clearAllPacksForTests } from "./packStore.js";

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
});
