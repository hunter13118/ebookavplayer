import { beforeEach, describe, expect, it } from "vitest";
import { storeAlignManifest, loadAlignManifest, removeAlignManifest } from "./alignCache.js";
import { clearAllPacksForTests } from "./packStore.js";

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
    expect(loaded).toEqual(fakeResult);
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
    expect(await loadAlignManifest("book-1", "whisperx", 1000, sbc)).toEqual(newResult);
  });
});
