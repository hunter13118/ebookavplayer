import { beforeEach, describe, expect, it } from "vitest";
import { storeM4b, loadM4b, loadM4bName, removeM4b } from "./m4bStore.js";
import { clearAllPacksForTests } from "./packStore.js";

describe("m4bStore", () => {
  beforeEach(async () => {
    await clearAllPacksForTests();
  });

  it("returns null when nothing has been attached for a book", async () => {
    expect(await loadM4b("no-such-book")).toBeNull();
    expect(await loadM4bName("no-such-book")).toBeNull();
  });

  it("stores and retrieves a blob keyed by book id", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/mp4" });
    await storeM4b("book-1", blob, "my-audiobook.m4b");

    const loaded = await loadM4b("book-1");
    expect(loaded).toBeTruthy();
    expect(loaded.size).toBe(4);

    expect(await loadM4bName("book-1")).toBe("my-audiobook.m4b");
  });

  it("isolates storage per book id", async () => {
    await storeM4b("book-a", new Blob([new Uint8Array(10)]), "a.m4b");
    await storeM4b("book-b", new Blob([new Uint8Array(20)]), "b.m4b");

    expect((await loadM4b("book-a")).size).toBe(10);
    expect((await loadM4b("book-b")).size).toBe(20);
    expect(await loadM4bName("book-a")).toBe("a.m4b");
    expect(await loadM4bName("book-b")).toBe("b.m4b");
  });

  it("replacing a stored blob overwrites both the blob and the filename", async () => {
    await storeM4b("book-1", new Blob([new Uint8Array(5)]), "first.m4b");
    await storeM4b("book-1", new Blob([new Uint8Array(9)]), "second.m4b");

    expect((await loadM4b("book-1")).size).toBe(9);
    expect(await loadM4bName("book-1")).toBe("second.m4b");
  });

  it("storing without a filename leaves the name unset", async () => {
    await storeM4b("book-1", new Blob([new Uint8Array(3)]));
    expect(await loadM4bName("book-1")).toBeNull();
  });

  it("removeM4b deletes both the blob and the filename", async () => {
    await storeM4b("book-1", new Blob([new Uint8Array(3)]), "x.m4b");
    await removeM4b("book-1");
    expect(await loadM4b("book-1")).toBeNull();
    expect(await loadM4bName("book-1")).toBeNull();
  });

  it("removeM4b on a book with nothing attached does not throw", async () => {
    await expect(removeM4b("never-attached")).resolves.not.toThrow();
  });

  describe("MIME type normalization", () => {
    // Regression: many browsers/OSes have no MIME mapping for .m4b
    // specifically, so a file picked via <input accept=".m4b"> often comes
    // through with an empty type — packStore.js's blobToStored() then
    // defaults that to "application/octet-stream", which many browsers'
    // <audio> element silently refuses to play (reader/text still renders
    // fine, only playback goes silent — the reported "UI works, audio
    // doesn't" symptom this fixes).
    it("normalizes an untyped blob to audio/mp4 on store", async () => {
      const blob = new Blob([new Uint8Array([1, 2, 3])]); // no type — the common real-world case
      expect(blob.type).toBe("");
      await storeM4b("book-1", blob, "book.m4b");
      const loaded = await loadM4b("book-1");
      expect(loaded.type).toBe("audio/mp4");
      expect(loaded.size).toBe(3);
    });

    it("normalizes a wrong generic type (application/octet-stream) too", async () => {
      const blob = new Blob([new Uint8Array([1, 2])], { type: "application/octet-stream" });
      await storeM4b("book-1", blob, "book.m4b");
      expect((await loadM4b("book-1")).type).toBe("audio/mp4");
    });

    it("leaves an already-correct audio type alone", async () => {
      const blob = new Blob([new Uint8Array([1, 2])], { type: "audio/x-m4a" });
      await storeM4b("book-1", blob, "book.m4b");
      expect((await loadM4b("book-1")).type).toBe("audio/x-m4a");
    });

    it("also normalizes on load — fixes a blob stored before this fix existed, no re-upload needed", async () => {
      // Simulates data already in IndexedDB from before storeM4b normalized:
      // write directly via the lower-level putBlob, bypassing storeM4b.
      const { putBlob } = await import("./packStore.js");
      await putBlob("book-1", "m4b/audiobook.m4b", new Blob([new Uint8Array([9])], { type: "application/octet-stream" }));
      const loaded = await loadM4b("book-1");
      expect(loaded.type).toBe("audio/mp4");
    });
  });
});
