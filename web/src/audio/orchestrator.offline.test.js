import { beforeEach, describe, expect, it, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { importPackZip } from "../offline/packIo.js";
import { buildTestPackZip, TIER_AUDIOBOOK } from "../offline/testPackFixtures.js";
import { setActiveOfflinePack, clearMediaUrlCache, packSupportsOfflineAudio } from "../offline/packBridge.js";
import { clearAllPacksForTests } from "../offline/packStore.js";

vi.mock("../api.js", () => ({
  backendConfigured: () => false,
}));

describe("Orchestrator offline audiobook pack", () => {
  beforeEach(async () => {
    await clearAllPacksForTests();
    clearMediaUrlCache();
    const rec = await importPackZip(buildTestPackZip({ tier: TIER_AUDIOBOOK, withAudio: true }));
    setActiveOfflinePack(rec.pack_id);
  });

  it("uses pack audio path when backend is unavailable", async () => {
    const orch = new Orchestrator();
    const lines = [{ idx: 0, text: "Hello offline.", character_id: "narrator" }];
    const rec = await importPackZip(buildTestPackZip({
      book: { book_id: "orch-test", title: "Orch", scenes: [{ id: "s", lines }] },
      tier: TIER_AUDIOBOOK,
      withAudio: true,
    }));
    expect(packSupportsOfflineAudio(rec)).toBe(true);

    let ended = false;
    orch.onEnd = () => { ended = true; };
    await orch.play(lines, 0);
    await new Promise((r) => setTimeout(r, 100));
    expect(["playing", "done", "paused"]).toContain(orch.status);
    orch.stop();
  });
});
