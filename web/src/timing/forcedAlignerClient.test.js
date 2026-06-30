import { describe, it, expect, vi } from "vitest";
import { forcedAlignerClient, manifestToTimingResult, ALIGNER_MARKER } from "./forcedAlignerClient.js";
import { buildSlidesByChapter } from "./slides.js";

function book(scenes) {
  return { scenes };
}

describe("manifestToTimingResult", () => {
  const sbc = buildSlidesByChapter(book([{ chapter: 1, lines: [{ text: "a" }, { text: "b" }] }]));

  it("tags output with the phonetic-forced-align marker", () => {
    const result = manifestToTimingResult({ lines: [] }, sbc);
    expect(result.algorithm).toBe("forced-aligner");
    expect(result.marker).toBe(ALIGNER_MARKER);
    expect(result.marker).toBe("phonetic-forced-align");
  });

  it("normalizes line_idx/start_ms/end_ms into the unified per-line lookup", () => {
    const manifest = { lines: [{ line_idx: 0, start_ms: 0, end_ms: 1500 }, { line_idx: 1, start_ms: 1500, end_ms: 4000 }] };
    const result = manifestToTimingResult(manifest, sbc);
    expect(result.lineTimings[0]).toEqual({ startMs: 0, endMs: 1500, durationMs: 1500 });
    expect(result.lineTimings[1]).toEqual({ startMs: 1500, endMs: 4000, durationMs: 2500 });
  });

  it("handles a zero-text-slide line (entry present but degenerate)", () => {
    const manifest = { lines: [{ line_idx: 0, start_ms: 1000, end_ms: 1000 }, { line_idx: 1, start_ms: 1000, end_ms: 2000 }] };
    const result = manifestToTimingResult(manifest, sbc);
    expect(result.lineTimings[0].durationMs).toBe(0);
  });

  it("handles a malformed/missing manifest (no lines array) without throwing", () => {
    expect(() => manifestToTimingResult({}, sbc)).not.toThrow();
    expect(() => manifestToTimingResult(null, sbc)).not.toThrow();
    expect(() => manifestToTimingResult(undefined, sbc)).not.toThrow();
    const result = manifestToTimingResult(null, sbc);
    expect(result.lineTimings[0]).toEqual({ startMs: 0, endMs: 0, durationMs: 0 });
  });

  it("skips malformed entries that have no line_idx", () => {
    const manifest = { lines: [{ start_ms: 0, end_ms: 100 }, { line_idx: 0, start_ms: 0, end_ms: 200 }] };
    const result = manifestToTimingResult(manifest, sbc);
    expect(result.lineTimings[0].durationMs).toBe(200);
  });

  it("clamps a malformed entry whose end_ms precedes start_ms to a zero-length span (never negative)", () => {
    const manifest = { lines: [{ line_idx: 0, start_ms: 5000, end_ms: 1000 }] };
    const result = manifestToTimingResult(manifest, sbc);
    expect(result.lineTimings[0].durationMs).toBe(0);
    expect(result.lineTimings[0].endMs).toBeGreaterThanOrEqual(result.lineTimings[0].startMs);
  });

  it("merges extra meta passed through", () => {
    const result = manifestToTimingResult({ lines: [] }, sbc, { source: "local-server", engine: "stub" });
    expect(result.meta.source).toBe("local-server");
    expect(result.meta.engine).toBe("stub");
  });
});

describe("forcedAlignerClient", () => {
  const sbc = buildSlidesByChapter(book([{ chapter: 1, lines: [{ text: "a" }] }]));

  it("POSTs to /books/{id}/audio/align and normalizes the JSON response", async () => {
    const fetchImpl = vi.fn(async (url, opts) => {
      expect(url).toBe("/books/my-book/audio/align");
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body);
      expect(body.book_id).toBe("my-book");
      return {
        ok: true,
        json: async () => ({ audio_engine: "forced-aligner", lines: [{ line_idx: 0, start_ms: 0, end_ms: 999 }] }),
      };
    });
    const result = await forcedAlignerClient({ bookId: "my-book", slidesByChapter: sbc, fetchImpl });
    expect(result.lineTimings[0].durationMs).toBe(999);
    expect(result.meta.source).toBe("local-server");
    expect(result.meta.engine).toBe("forced-aligner");
  });

  it("respects a custom apiBase prefix", async () => {
    const fetchImpl = vi.fn(async (url) => {
      expect(url).toBe("http://localhost:8000/books/b1/audio/align");
      return { ok: true, json: async () => ({ lines: [] }) };
    });
    await forcedAlignerClient({ bookId: "b1", slidesByChapter: sbc, apiBase: "http://localhost:8000/", fetchImpl });
  });

  it("throws a descriptive error on a non-ok HTTP response (e.g. local server down)", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }));
    await expect(forcedAlignerClient({ bookId: "b1", slidesByChapter: sbc, fetchImpl }))
      .rejects.toThrow(/HTTP 503/);
  });

  it("throws when no fetch implementation is available", async () => {
    vi.stubGlobal("fetch", undefined);
    try {
      await expect(forcedAlignerClient({ bookId: "b1", slidesByChapter: sbc, fetchImpl: null }))
        .rejects.toThrow(/no fetch implementation/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("passes m4bPath through to the request body when provided", async () => {
    const fetchImpl = vi.fn(async (url, opts) => {
      const body = JSON.parse(opts.body);
      expect(body.m4b_path).toBe("/local/book.m4b");
      return { ok: true, json: async () => ({ lines: [] }) };
    });
    await forcedAlignerClient({ bookId: "b1", slidesByChapter: sbc, m4bPath: "/local/book.m4b", fetchImpl });
  });
});
