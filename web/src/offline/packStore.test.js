import { beforeEach, describe, expect, it } from "vitest";
import {
  installPackFromEntries,
  listInstalledPacks,
  getInstalledPack,
  getInstalledPackForBook,
  getBlob,
  deletePack,
  formatBytes,
  clearAllPacksForTests,
} from "./packStore.js";
import { buildTestPackZip, minimalBook, TIER_AUDIOBOOK } from "./testPackFixtures.js";
import { importPackZip } from "./packIo.js";
import { MANIFEST_NAME } from "./packFormat.js";

describe("packStore", () => {
  beforeEach(async () => {
    await clearAllPacksForTests();
  });

  it("installs a visual pack from zip bytes", async () => {
    const zip = buildTestPackZip();
    const record = await importPackZip(zip);
    expect(record.book_id).toBe("pack-test");
    expect(record.tier).toBe("visual");

    const all = await listInstalledPacks();
    expect(all).toHaveLength(1);

    const found = await getInstalledPackForBook("pack-test");
    expect(found?.pack_id).toBe(record.pack_id);
  });

  it("stores media blobs addressable by pack path", async () => {
    const record = await importPackZip(buildTestPackZip());
    const packPath = Object.values(record.media_index)[0];
    const blob = await getBlob(record.pack_id, packPath);
    expect(blob).toBeTruthy();
    expect(blob.size).toBeGreaterThan(0);
  });

  it("installs audiobook tier with audio manifest", async () => {
    const record = await importPackZip(buildTestPackZip({ tier: TIER_AUDIOBOOK, withAudio: true }));
    expect(record.audio_manifest).toHaveLength(1);
    const audioPath = record.audio_manifest[0].path;
    const blob = await getBlob(record.pack_id, audioPath);
    expect(blob?.type).toBe("audio/mpeg");
  });

  it("deletes pack and blobs", async () => {
    const record = await importPackZip(buildTestPackZip());
    await deletePack(record.pack_id);
    expect(await getInstalledPack(record.pack_id)).toBeUndefined();
    expect(await listInstalledPacks()).toHaveLength(0);
  });

  it("formatBytes renders human sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("rejects install when manifest missing book json", async () => {
    const zip = buildTestPackZip();
    const entries = {};
    const { unzipSync } = await import("fflate");
    const raw = unzipSync(new Uint8Array(zip));
    for (const [k, v] of Object.entries(raw)) entries[k] = v;
    delete entries["vae/book.json"];
    const manifest = JSON.parse(new TextDecoder().decode(entries[MANIFEST_NAME]));
    await expect(installPackFromEntries(manifest, entries)).rejects.toThrow(/missing vae\/book.json/);
  });
});

describe("packStore book lookup", () => {
  beforeEach(async () => {
    await clearAllPacksForTests();
  });

  it("finds pack by book_id", async () => {
    const book = minimalBook({ book_id: "lookup-id", title: "Lookup" });
    await importPackZip(buildTestPackZip({ book }));
    const hit = await getInstalledPackForBook("lookup-id");
    expect(hit?.title).toBe("Lookup");
  });
});
