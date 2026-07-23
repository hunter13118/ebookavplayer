import { beforeEach, describe, expect, it } from "vitest";
import { storeAlignManifest, loadAlignManifest, removeAlignManifest } from "./alignCache.js";
import { clearAllPacksForTests, putSetting } from "./packStore.js";

const sbc = [
  { chapter: 1, slides: [{ lineIndex: 0, charCount: 5 }, { lineIndex: 1, charCount: 7 }] },
  { chapter: 2, slides: [{ lineIndex: 2, charCount: 3 }] },
];

const fakeResult = { algorithm: "whisperx", lineTimings: { 0: { startMs: 0, endMs: 1000, durationMs: 1000 } } };

describe("alignCache", () => {
  beforeEach(async () => {
    await clearAllPacksForTests();
  });

  it("returns null when nothing has been cached for a book+algorithm", async () => {
    expect(await loadAlignManifest("book-1", "whisperx", 1000, sbc)).toBeNull();
  });

  it("stores and retrieves a manifest keyed by book id + algorithm id", async () => {
    await storeAlignManifest("book-1", "whisperx", 1000, sbc, fakeResult);
    const loaded = await loadAlignManifest("book-1", "whisperx", 1000, sbc);
    expect(loaded).toEqual({ result: fakeResult, complete: true, processedMs: 0 });
  });

  it("defaults to complete: true when stored without an explicit flag (back-compat with pre-existing manifests)", async () => {
    await storeAlignManifest("book-1", "whisperx", 1000, sbc, fakeResult);
    expect((await loadAlignManifest("book-1", "whisperx", 1000, sbc)).complete).toBe(true);
  });

  it("marks a manifest stored mid-alignment as complete: false", async () => {
    await storeAlignManifest("book-1", "whisperx", 1000, sbc, fakeResult, { complete: false });
    const loaded = await loadAlignManifest("book-1", "whisperx", 1000, sbc);
    expect(loaded).toEqual({ result: fakeResult, complete: false, processedMs: 0 });
  });

  it("round-trips a processedMs checkpoint for resuming a mid-alignment snapshot", async () => {
    await storeAlignManifest("book-1", "whisperx", 1000, sbc, fakeResult, { complete: false, processedMs: 456_000 });
    const loaded = await loadAlignManifest("book-1", "whisperx", 1000, sbc);
    expect(loaded.processedMs).toBe(456_000);
  });

  it("isolates cache entries per algorithm for the same book", async () => {
    await storeAlignManifest("book-1", "whisperx", 1000, sbc, fakeResult);
    expect(await loadAlignManifest("book-1", "linear", 1000, sbc)).toBeNull();
  });

  it("isolates cache entries per book for the same algorithm", async () => {
    await storeAlignManifest("book-1", "whisperx", 1000, sbc, fakeResult);
    expect(await loadAlignManifest("book-2", "whisperx", 1000, sbc)).toBeNull();
  });

  it("misses when the m4b blob size changed (different audiobook attached)", async () => {
    await storeAlignManifest("book-1", "whisperx", 1000, sbc, fakeResult);
    expect(await loadAlignManifest("book-1", "whisperx", 2000, sbc)).toBeNull();
  });

  it("misses when the book's lines changed (re-extracted with different content)", async () => {
    await storeAlignManifest("book-1", "whisperx", 1000, sbc, fakeResult);
    const changedSbc = [
      { chapter: 1, slides: [{ lineIndex: 0, charCount: 5 }] },
    ];
    expect(await loadAlignManifest("book-1", "whisperx", 1000, changedSbc)).toBeNull();
  });

  it("removeAlignManifest deletes the cached entry", async () => {
    await storeAlignManifest("book-1", "whisperx", 1000, sbc, fakeResult);
    await removeAlignManifest("book-1", "whisperx");
    expect(await loadAlignManifest("book-1", "whisperx", 1000, sbc)).toBeNull();
  });

  it("removeAlignManifest on a book with nothing cached does not throw", async () => {
    await expect(removeAlignManifest("never-aligned", "whisperx")).resolves.not.toThrow();
  });

  it("storing again overwrites the previous manifest", async () => {
    await storeAlignManifest("book-1", "whisperx", 1000, sbc, fakeResult);
    const newResult = { algorithm: "whisperx", lineTimings: { 0: { startMs: 0, endMs: 500, durationMs: 500 } } };
    await storeAlignManifest("book-1", "whisperx", 1000, sbc, newResult);
    expect((await loadAlignManifest("book-1", "whisperx", 1000, sbc)).result).toEqual(newResult);
  });

  // A schema bump (e.g. server.py's false-anchor fix) must downgrade an
  // already-cached manifest to "keep using it as a working baseline, refine
  // in the background" — NOT make it unreachable outright. Losing gaps/real
  // sync entirely whenever the align server isn't currently running (to
  // redo the whole alignment) would be a worse regression than the bug being
  // fixed. Simulates a pre-existing record via a raw put, bypassing
  // storeAlignManifest (which always stamps the CURRENT schema version).
  describe("schema-version downgrade (back-compat for a matching-logic fix)", () => {
    it("a pre-existing manifest with no schemaVersion at all loads as complete: false, result intact", async () => {
      await putSetting("align-manifest::book-1::whisperx", {
        fingerprint: `1000:${sbc.reduce((n, ch) => n + ch.slides.length, 0)}:${
          sbc.reduce((n, ch) => n + ch.slides.reduce((m, s) => m + s.charCount, 0), 0)}`,
        result: fakeResult,
        complete: true, // was a fully-resolved pass under the OLD schema
        processedMs: 999_000,
        storedAt: Date.now(),
      });
      const loaded = await loadAlignManifest("book-1", "whisperx", 1000, sbc);
      expect(loaded.complete).toBe(false); // downgraded — refine, don't trust forever
      expect(loaded.result).toEqual(fakeResult); // but the real cached data still comes back
      expect(loaded.processedMs).toBe(999_000); // real audio offset preserved (see loadAlignManifest's comment)
    });

    it("a manifest written by the CURRENT storeAlignManifest keeps its real complete flag", async () => {
      await storeAlignManifest("book-1", "whisperx", 1000, sbc, fakeResult, { complete: true });
      expect((await loadAlignManifest("book-1", "whisperx", 1000, sbc)).complete).toBe(true);
    });
  });
});
