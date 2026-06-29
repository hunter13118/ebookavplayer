import { beforeEach, describe, expect, it, vi } from "vitest";
import { speakLine, stopAllSpeech } from "./playSpeech.js";
import { importPackZip } from "../offline/packIo.js";
import { buildTestPackZip, TIER_AUDIOBOOK } from "../offline/testPackFixtures.js";
import { setActiveOfflinePack, clearMediaUrlCache } from "../offline/packBridge.js";
import { clearAllPacksForTests } from "../offline/packStore.js";

describe("playSpeech offline pack", () => {
  beforeEach(async () => {
    await clearAllPacksForTests();
    clearMediaUrlCache();
    setActiveOfflinePack(null);
    stopAllSpeech();
    vi.restoreAllMocks();
  });

  it("uses pack audio without calling /tts", async () => {
    const rec = await importPackZip(buildTestPackZip({ tier: TIER_AUDIOBOOK, withAudio: true }));
    setActiveOfflinePack(rec.pack_id);

    const fetchSpy = vi.spyOn(global, "fetch");
    const line = rec.book.scenes[0].lines[0];
    let started = false;
    await speakLine(line, {
      onStart: () => { started = true; },
      onEnd: () => {},
    });
    expect(started).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to /tts when no pack audio", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob([0xff, 0xfb], { type: "audio/mpeg" }),
    });
    const line = { idx: 0, text: "Online only.", character_id: "narrator", voice: "en-US-AndrewMultilingualNeural" };
    await speakLine(line, { onEnd: () => {} });
    expect(global.fetch).toHaveBeenCalled();
  });
});
