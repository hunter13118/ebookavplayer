import { beforeEach, describe, expect, it } from "vitest";
import { importPackZip, buildPackZipBytes, isPackArchiveName, downloadBlob, saveBlobAsFile } from "./packIo.js";
import { buildTestPackZip, minimalBook } from "./testPackFixtures.js";
import { clearAllPacksForTests } from "./packStore.js";
import { MANIFEST_NAME, BOOK_NAME } from "./packFormat.js";
import { zipSync, unzipSync } from "fflate";
import { getResume, saveResume, clearResume } from "../library.js";

describe("packIo", () => {
  beforeEach(async () => {
    await clearAllPacksForTests();
  });

  it("imports a valid zip", async () => {
    const rec = await importPackZip(buildTestPackZip());
    expect(rec.book.title).toBe("Pack Test Book");
  });

  it("rejects zip without manifest", async () => {
    const bad = zipSync({ "readme.txt": new TextEncoder().encode("nope") });
    await expect(importPackZip(bad)).rejects.toThrow(/missing vae\/manifest.json/);
  });

  it("rejects invalid manifest format", async () => {
    const enc = new TextEncoder();
    const bad = zipSync({
      [MANIFEST_NAME]: enc.encode(JSON.stringify({ format: "wrong" })),
    });
    await expect(importPackZip(bad)).rejects.toThrow(/not a vae-offline-pack/);
  });

  it("round-trips custom book content", async () => {
    const book = minimalBook({ title: "Round Trip" });
    const rec = await importPackZip(buildTestPackZip({ book }));
    expect(rec.book.title).toBe("Round Trip");
  });

  it("isPackArchiveName accepts vaepack and zip", () => {
    expect(isPackArchiveName("book.vaepack")).toBe(true);
    expect(isPackArchiveName("book.ZIP")).toBe(true);
    expect(isPackArchiveName("book.epub")).toBe(false);
  });

  it("buildPackZipBytes includes media blobs", async () => {
    const rec = await importPackZip(buildTestPackZip({ withMedia: true }));
    const bytes = await buildPackZipBytes(rec);
    expect(bytes.byteLength).toBeGreaterThan(200);
  });

  it("downloadBlob appends anchor to document before click", () => {
    const clicks = [];
    const el = {
      href: "", download: "", rel: "", style: { display: "" },
      click() { clicks.push(1); },
    };
    const origCreate = document.createElement.bind(document);
    document.createElement = (tag) => (tag === "a" ? el : origCreate(tag));
    document.body.appendChild = () => el;
    document.body.removeChild = () => {};
    URL.createObjectURL = () => "blob:test";
    URL.revokeObjectURL = () => {};
    downloadBlob("test.vaepack", new Blob(["x"]));
    document.createElement = origCreate;
    expect(clicks).toEqual([1]);
    expect(el.download).toBe("test.vaepack");
  });

  it("saveBlobAsFile uses file handle when provided", async () => {
    const writes = [];
    const handle = {
      createWritable: async () => ({
        write: (b) => { writes.push(b); },
        close: async () => {},
      }),
    };
    const method = await saveBlobAsFile(new Blob(["pack"]), "x.vaepack", { saveHandle: handle });
    expect(method).toBe("file-handle");
    expect(writes.length).toBe(1);
  });

  it("export embeds local reading progress; import restores it", async () => {
    const book = minimalBook({ book_id: "resume-pack" });
    clearResume("resume-pack");
    saveResume("resume-pack", { line: 12, sceneId: "s1", chapter: 0, total: 40 });
    const rec = await importPackZip(buildTestPackZip({ book }));
    const bytes = await buildPackZipBytes(rec);
    clearResume("resume-pack");
    const entries = unzipSync(bytes);
    const exported = JSON.parse(new TextDecoder().decode(entries[BOOK_NAME]));
    expect(exported.resume?.line).toBe(12);
    await importPackZip(bytes);
    expect(getResume("resume-pack")?.line).toBe(12);
  });
});
