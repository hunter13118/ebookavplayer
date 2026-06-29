import { beforeEach, describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { buildPackOnEdge, TIER_VISUAL } from "../../../worker/_shared/pack-build-edge.js";
import { validatePackManifest } from "../../../worker/_shared/pack-manifest.js";
import { importPackZip } from "./packIo.js";
import { clearAllPacksForTests, getInstalledPack } from "./packStore.js";
import { MANIFEST_NAME } from "./packFormat.js";

describe("edge pack build → client import", () => {
  beforeEach(async () => {
    await clearAllPacksForTests();
  });

  it("buildPackOnEdge zip passes validateManifest and importPackZip", async () => {
    const book = {
      book_id: "edge-import-test",
      title: "Edge Import",
      author: "Tester",
      art_style: "semi-real",
      scenes: [{
        id: "s1",
        background: "/media/edge-import-test/semi-real/bg.png",
        lines: [{ idx: 0, text: "Offline line.", character_id: "narrator" }],
      }],
    };

    const { bytes, manifest } = await buildPackOnEdge({
      env: {},
      book,
      tier: TIER_VISUAL,
      style: "semi-real",
    });

    validatePackManifest(manifest);
    const fromZip = JSON.parse(
      new TextDecoder().decode(unzipSync(bytes)[MANIFEST_NAME]),
    );
    expect(fromZip.format_version).toBe(1);
    expect(fromZip.pack_id).toBe("edge-import-test@semi-real@visual");

    const record = await importPackZip(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    expect(record.book_id).toBe("edge-import-test");
    expect(record.tier).toBe(TIER_VISUAL);

    const stored = await getInstalledPack(record.pack_id);
    expect(stored?.manifest.format_version).toBe(1);
  });
});
