import { beforeEach, describe, expect, it } from "vitest";
import { mediaUrl } from "../media.js";
import { importPackZip } from "./packIo.js";
import { buildTestPackZip } from "./testPackFixtures.js";
import { warmOfflineMedia, clearMediaUrlCache, setActiveOfflinePack, lookupCachedMediaUrl } from "./packBridge.js";
import { clearAllPacksForTests } from "./packStore.js";

describe("media offline resolution", () => {
  beforeEach(async () => {
    await clearAllPacksForTests();
    clearMediaUrlCache();
    setActiveOfflinePack(null);
  });

  it("returns cached blob URL from mediaUrl when pack is warm", async () => {
    const rec = await importPackZip(buildTestPackZip());
    await warmOfflineMedia(rec);
    const token = "/media/pack-test/semi-real/bg_s1.png";
    const resolved = mediaUrl(token);
    expect(resolved).toMatch(/^blob:/);
    expect(lookupCachedMediaUrl(token)).toBe(resolved);
  });

  it("passes through gradient tokens unchanged", () => {
    expect(mediaUrl("gradient:120,200")).toBe("gradient:120,200");
  });
});
