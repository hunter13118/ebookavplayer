import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installM4bFirstBook, appendM4bFirstLines, markM4bFirstTranscriptComplete,
  m4bFirstTranscriptText, removeM4bFirstBook, bookIdFromFilename, titleFromFilename,
} from "./m4bFirstBooks.js";
import { clearAllPacksForTests } from "./packStore.js";
import { loadM4b, loadM4bName } from "./m4bStore.js";
import { m4bFirstTimelineFromBook } from "../timing/m4bFirstTimeline.js";

vi.mock("../api.js", () => ({
  fetchCatalog: vi.fn(async () => { throw new Error("no server in this test"); }),
  fetchBook: vi.fn(async () => { throw new Error("no server book yet"); }),
}));

// Imported AFTER the mock so bookSource.js picks up the mocked api.js.
const { fetchLocalCatalog, mergeCatalog, fetchBook } = await import("./bookSource.js");

function chunk(startIdx, count, msPerLine = 1000) {
  return Array.from({ length: count }, (_, i) => {
    const idx = startIdx + i;
    return {
      idx,
      text: `Sentence number ${idx}.`,
      startMs: idx * msPerLine,
      endMs: idx * msPerLine + msPerLine,
      words: [["Sentence", idx * msPerLine, idx * msPerLine + 300]],
    };
  });
}

describe("bookIdFromFilename / titleFromFilename", () => {
  it("slugifies a filename into a book id, matching the epub ingest convention", () => {
    expect(bookIdFromFilename("My Quiet Blacksmith Life, Vol 6.m4b")).toBe("My-Quiet-Blacksmith-Life-Vol-6");
  });
  it("titleizes the same filename into a readable title", () => {
    expect(titleFromFilename("my-quiet-blacksmith_life.m4b")).toBe("My Quiet Blacksmith Life");
  });
});

describe("m4bFirstBooks lifecycle", () => {
  beforeEach(async () => {
    await clearAllPacksForTests();
  });

  it("installs a book with an empty scene, ready to grow", async () => {
    const blob = new Blob(["fake m4b bytes"]);
    const record = await installM4bFirstBook({ bookId: "book-1", title: "Book One", blob, fileName: "book-1.m4b" });
    expect(record.tier).toBe("visual");
    expect(record.pack_origin).toBe("m4b-first");
    expect(record.book.scenes).toHaveLength(1);
    expect(record.book.scenes[0].lines).toEqual([]);
    expect(record.book.m4b_first_status).toBe("transcribing");

    // The blob round-trips through the SAME m4bStore Player.jsx already reads on mount.
    const storedBlob = await loadM4b("book-1");
    expect(storedBlob).toBeInstanceOf(Blob);
    expect(await loadM4bName("book-1")).toBe("book-1.m4b");
  });

  it("appends streamed chunks in order across multiple calls", async () => {
    const blob = new Blob(["x"]);
    await installM4bFirstBook({ bookId: "book-2", title: "Book Two", blob, fileName: "book-2.m4b" });

    await appendM4bFirstLines("book-2", chunk(0, 3));
    await appendM4bFirstLines("book-2", chunk(3, 2));

    const text = await m4bFirstTranscriptText("book-2");
    expect(text).toBe(
      "Sentence number 0. Sentence number 1. Sentence number 2. Sentence number 3. Sentence number 4.",
    );
  });

  it("marks the transcript complete", async () => {
    const blob = new Blob(["x"]);
    await installM4bFirstBook({ bookId: "book-3", title: "Book Three", blob, fileName: "book-3.m4b" });
    await appendM4bFirstLines("book-3", chunk(0, 1));
    const updated = await markM4bFirstTranscriptComplete("book-3", { durationMs: 60000 });
    expect(updated.book.m4b_first_status).toBe("transcribed");
    expect(updated.book.m4b_duration_ms).toBe(60000);
  });

  it("removes the pack and the attached blob together", async () => {
    const blob = new Blob(["x"]);
    await installM4bFirstBook({ bookId: "book-4", title: "Book Four", blob, fileName: "book-4.m4b" });
    await removeM4bFirstBook("book-4");
    expect(await loadM4b("book-4")).toBeNull();
    const catalog = await fetchLocalCatalog();
    expect(catalog.find((b) => b.book_id === "book-4")).toBeUndefined();
  });

  it("shows up in the catalog immediately at 0 lines, before the first chunk lands", async () => {
    // App.jsx refreshes the catalog right after install, before transcription
    // has produced anything — Player.jsx's own notReady (lines.length === 0)
    // state is what covers this brief window if the user opens it that fast.
    const blob = new Blob(["x"]);
    await installM4bFirstBook({ bookId: "book-5", title: "Book Five", blob, fileName: "book-5.m4b" });
    const local = await fetchLocalCatalog();
    const entry = local.find((b) => b.book_id === "book-5");
    expect(entry.lines).toBe(0);
  });
});

describe("integration: the installed pack merges into the app's real catalog + fetchBook path", () => {
  beforeEach(async () => {
    await clearAllPacksForTests();
  });

  it("appears in fetchLocalCatalog with pack_origin m4b-first and the right line count", async () => {
    const blob = new Blob(["x"]);
    await installM4bFirstBook({ bookId: "book-6", title: "Book Six", blob, fileName: "book-6.m4b" });
    await appendM4bFirstLines("book-6", chunk(0, 4));

    const local = await fetchLocalCatalog();
    const entry = local.find((b) => b.book_id === "book-6");
    expect(entry).toBeTruthy();
    expect(entry.pack_origin).toBe("m4b-first");
    expect(entry.offline_pack).toBe(true);
    expect(entry.lines).toBe(4);
    expect(entry.status).toBe("ready"); // catalogFromPack: any installed pack reads as ready to open
  });

  it("mergeCatalog marks it server_available:false when no matching server entry exists", async () => {
    const blob = new Blob(["x"]);
    await installM4bFirstBook({ bookId: "book-7", title: "Book Seven", blob, fileName: "book-7.m4b" });
    await appendM4bFirstLines("book-7", chunk(0, 2));

    const merged = await mergeCatalog([]); // empty server list — no server book yet
    const entry = merged.find((b) => b.book_id === "book-7");
    expect(entry.server_available).toBe(false);
  });

  it("fetchBook falls back to the local pack when no server book exists yet, in the exact shape Player.jsx needs", async () => {
    const blob = new Blob(["x"]);
    await installM4bFirstBook({ bookId: "book-8", title: "Book Eight", blob, fileName: "book-8.m4b" });
    await appendM4bFirstLines("book-8", chunk(0, 3));

    const book = await fetchBook("book-8");
    expect(book.book_id).toBe("book-8");
    expect(book.scenes).toHaveLength(1);
    expect(book.scenes[0].lines).toHaveLength(3);
    expect(book.scenes[0].lines[0]).toMatchObject({ kind: "narration", character_id: "narrator" });
  });

  it("closes the loop end to end: fetchBook's result is exactly what m4bFirstTimelineFromBook needs", async () => {
    const blob = new Blob(["x"]);
    await installM4bFirstBook({ bookId: "book-9", title: "Book Nine", blob, fileName: "book-9.m4b" });
    await appendM4bFirstLines("book-9", chunk(0, 5, 800));

    const book = await fetchBook("book-9");
    const result = m4bFirstTimelineFromBook(book);
    expect(result).not.toBeNull();
    expect(result.meta.strategy).toBe("acoustic");
    expect(Object.keys(result.lineTimings)).toHaveLength(5);
    expect(result.lineTimings[2]).toEqual({ startMs: 1600, endMs: 2400, durationMs: 800, words: expect.any(Array) });
  });
});
