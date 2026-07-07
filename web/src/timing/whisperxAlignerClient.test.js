import { describe, it, expect, vi } from "vitest";
import { whisperxAlignerClient, WHISPERX_MARKER } from "./whisperxAlignerClient.js";
import { buildSlidesByChapter } from "./slides.js";

function book(scenes) {
  return { scenes };
}

function ndjsonResponse(rows) {
  const text = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return {
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: bytes };
          },
        };
      },
    },
  };
}

const sbcOneChapter = buildSlidesByChapter(book([
  { chapter: 1, lines: [{ text: "Hello there." }, { text: "General Kenobi." }] },
]));

const sbcTwoChapters = buildSlidesByChapter(book([
  { chapter: 1, lines: [{ text: "Hello there." }] },
  { chapter: 2, lines: [{ text: "General Kenobi." }] },
]));

describe("whisperxAlignerClient", () => {
  it("POSTs a multipart m4b + flattened whole-book lines payload (no per-chapter time guesses)", async () => {
    const fetchImpl = vi.fn(async (url, opts) => {
      expect(url).toBe("http://127.0.0.1:7861/align");
      expect(opts.method).toBe("POST");
      const form = opts.body;
      expect(form.get("m4b")).toBeTruthy();
      const lines = JSON.parse(form.get("lines"));
      expect(lines).toEqual([
        { idx: 0, text: "Hello there." },
        { idx: 1, text: "General Kenobi." },
      ]);
      return ndjsonResponse([
        {
          status: "chunk",
          lines: [{ idx: 0, start_ms: 120_000, end_ms: 121_200, words: [["Hello", 120_000, 120_500]] }],
          processed_ms: 240_000, total_ms: 720_000,
          meta: { asr_device: "cpu", align_device: "mps", lead_in_ms: 120_000, unmatched_line_count: 0 },
        },
        {
          status: "chunk",
          lines: [{ idx: 1, start_ms: 121_200, end_ms: 123_000, words: [] }],
          processed_ms: 720_000, total_ms: 720_000,
          meta: { asr_device: "cpu", align_device: "mps", lead_in_ms: 120_000, unmatched_line_count: 0 },
        },
        { status: "done", meta: { asr_device: "cpu", align_device: "mps", lead_in_ms: 120_000, unmatched_line_count: 0 } },
      ]);
    });

    const result = await whisperxAlignerClient({
      blob: new Blob(["fake m4b bytes"]),
      slidesByChapter: sbcTwoChapters,
      connection: { baseUrl: "http://127.0.0.1:7861" },
      fetchImpl,
    });

    expect(result.algorithm).toBe("whisperx");
    expect(result.marker).toBe(WHISPERX_MARKER);
    expect(result.marker).toBe("whisperx-forced-align");
    // Timings land at their REAL audio position, well past a detected 2-minute
    // lead-in (publisher intro) — no guessed boundary discarded that offset.
    expect(result.lineTimings[0]).toEqual({ startMs: 120_000, endMs: 121_200, durationMs: 1_200 });
    expect(result.lineTimings[1]).toEqual({ startMs: 121_200, endMs: 123_000, durationMs: 1_800 });
    expect(result.meta.strategy).toBe("acoustic");
    expect(result.meta.chapterBoundarySource).toBe("acoustic-match");
    expect(result.meta.asr_device).toBe("cpu");
    expect(result.meta.align_device).toBe("mps");
    expect(result.meta.lead_in_ms).toBe(120_000);
    expect(result.meta.unmatched_line_count).toBe(0);
  });

  it("fires onLinesReady progressively, once per non-empty chunk row, before the final result resolves", async () => {
    const fetchImpl = vi.fn(async () => ndjsonResponse([
      { status: "chunk", lines: [{ idx: 0, start_ms: 0, end_ms: 1000, words: [] }], processed_ms: 240_000, total_ms: 720_000, meta: {} },
      { status: "chunk", lines: [], processed_ms: 480_000, total_ms: 720_000, meta: {} }, // empty chunk — no matches this round
      { status: "chunk", lines: [{ idx: 1, start_ms: 1000, end_ms: 2000, words: [] }], processed_ms: 720_000, total_ms: 720_000, meta: {} },
      { status: "done", meta: {} },
    ]));
    const onLinesReady = vi.fn();
    await whisperxAlignerClient({
      blob: new Blob(["x"]), slidesByChapter: sbcTwoChapters,
      connection: { baseUrl: "http://127.0.0.1:7861" }, fetchImpl, onLinesReady,
    });

    // Only the two NON-empty chunk rows trigger onLinesReady.
    expect(onLinesReady).toHaveBeenCalledTimes(2);
    expect(onLinesReady).toHaveBeenNthCalledWith(1, { 0: { startMs: 0, endMs: 1000, durationMs: 1000, words: [] } });
    expect(onLinesReady).toHaveBeenNthCalledWith(2, { 1: { startMs: 1000, endMs: 2000, durationMs: 1000, words: [] } });
  });

  it("leaves a line with no timing entry at zero duration when the server never matched it", async () => {
    const fetchImpl = vi.fn(async () => ndjsonResponse([
      { status: "done", meta: {} },
    ]));
    const result = await whisperxAlignerClient({
      blob: new Blob(["x"]), slidesByChapter: sbcOneChapter,
      connection: { baseUrl: "http://127.0.0.1:7861" }, fetchImpl,
    });
    expect(result.lineTimings[0]).toEqual({ startMs: 0, endMs: 0, durationMs: 0 });
  });

  it("reports transcription progress in audio-ms-processed as chunk rows arrive", async () => {
    const fetchImpl = vi.fn(async () => ndjsonResponse([
      { status: "chunk", lines: [], processed_ms: 240_000, total_ms: 720_000, meta: {} },
      { status: "chunk", lines: [], processed_ms: 720_000, total_ms: 720_000, meta: {} },
      { status: "done", meta: {} },
    ]));
    const onChapterProgress = vi.fn();
    await whisperxAlignerClient({
      blob: new Blob(["x"]), slidesByChapter: sbcOneChapter,
      connection: { baseUrl: "http://127.0.0.1:7861" }, fetchImpl, onChapterProgress,
    });
    expect(onChapterProgress).toHaveBeenCalledWith(240_000, 720_000);
    expect(onChapterProgress).toHaveBeenCalledWith(720_000, 720_000);
  });

  it("throws a descriptive error when the stream reports a hard failure", async () => {
    const fetchImpl = vi.fn(async () => ndjsonResponse([
      { status: "error", error: "ffprobe failed to read duration" },
    ]));
    await expect(whisperxAlignerClient({
      blob: new Blob(["x"]), slidesByChapter: sbcOneChapter,
      connection: { baseUrl: "http://127.0.0.1:7861" }, fetchImpl,
    })).rejects.toThrow(/ffprobe failed to read duration/);
  });

  it("throws when the stream ends without ever sending a done row", async () => {
    const fetchImpl = vi.fn(async () => ndjsonResponse([
      { status: "chunk", lines: [], processed_ms: 100, total_ms: 1000, meta: {} },
    ]));
    await expect(whisperxAlignerClient({
      blob: new Blob(["x"]), slidesByChapter: sbcOneChapter,
      connection: { baseUrl: "http://127.0.0.1:7861" }, fetchImpl,
    })).rejects.toThrow(/stream ended without a result/);
  });

  it("throws a descriptive error on a non-ok HTTP response", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }));
    await expect(whisperxAlignerClient({
      blob: new Blob(["x"]), slidesByChapter: sbcOneChapter,
      connection: { baseUrl: "http://127.0.0.1:7861" }, fetchImpl,
    })).rejects.toThrow(/HTTP 503/);
  });

  it("throws when no connection is provided", async () => {
    await expect(whisperxAlignerClient({
      blob: new Blob(["x"]), slidesByChapter: sbcOneChapter,
      fetchImpl: vi.fn(),
    })).rejects.toThrow(/no align server connection/);
  });

  it("throws when no fetch implementation is available", async () => {
    vi.stubGlobal("fetch", undefined);
    try {
      await expect(whisperxAlignerClient({
        blob: new Blob(["x"]), slidesByChapter: sbcOneChapter,
        connection: { baseUrl: "http://127.0.0.1:7861" }, fetchImpl: null,
      })).rejects.toThrow(/no fetch implementation/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("parses gap rows into result.syntheticSegments with stable ids", async () => {
    const fetchImpl = vi.fn(async () => ndjsonResponse([
      {
        status: "chunk",
        lines: [{ idx: 0, start_ms: 0, end_ms: 1000, words: [] }],
        gaps: [{ start_ms: 1000, end_ms: 3000, text: "hey listener this is a bonus scene", word_count: 8 }],
        processed_ms: 240_000, total_ms: 720_000, meta: {},
      },
      {
        status: "chunk",
        lines: [{ idx: 1, start_ms: 3000, end_ms: 4000, words: [] }],
        gaps: [{ start_ms: 4000, end_ms: 5500, text: "thanks for listening to this epilogue", word_count: 6 }],
        processed_ms: 720_000, total_ms: 720_000, meta: {},
      },
      { status: "done", meta: {} },
    ]));

    const result = await whisperxAlignerClient({
      blob: new Blob(["x"]), slidesByChapter: sbcTwoChapters,
      connection: { baseUrl: "http://127.0.0.1:7861" }, fetchImpl,
    });

    expect(result.syntheticSegments).toEqual([
      { id: "gap-0", startMs: 1000, endMs: 3000, text: "hey listener this is a bonus scene" },
      { id: "gap-1", startMs: 4000, endMs: 5500, text: "thanks for listening to this epilogue" },
    ]);
  });

  it("fires onGapsReady only for newly-arrived gaps, not re-delivering earlier ones", async () => {
    const fetchImpl = vi.fn(async () => ndjsonResponse([
      {
        status: "chunk", lines: [], gaps: [{ start_ms: 0, end_ms: 1500, text: "intro bumper", word_count: 8 }],
        processed_ms: 240_000, total_ms: 720_000, meta: {},
      },
      { status: "chunk", lines: [], gaps: [], processed_ms: 480_000, total_ms: 720_000, meta: {} },
      {
        status: "chunk", lines: [], gaps: [{ start_ms: 5000, end_ms: 6500, text: "outro bumper", word_count: 8 }],
        processed_ms: 720_000, total_ms: 720_000, meta: {},
      },
      { status: "done", meta: {} },
    ]));
    const onGapsReady = vi.fn();
    await whisperxAlignerClient({
      blob: new Blob(["x"]), slidesByChapter: sbcOneChapter,
      connection: { baseUrl: "http://127.0.0.1:7861" }, fetchImpl, onGapsReady,
    });

    expect(onGapsReady).toHaveBeenCalledTimes(2); // the empty-gaps chunk doesn't fire it
    expect(onGapsReady).toHaveBeenNthCalledWith(1, [{ id: "gap-0", startMs: 0, endMs: 1500, text: "intro bumper" }]);
    expect(onGapsReady).toHaveBeenNthCalledWith(2, [{ id: "gap-1", startMs: 5000, endMs: 6500, text: "outro bumper" }]);
  });

  it("returns an empty syntheticSegments array when the server never sends a gaps key (older/mocked server)", async () => {
    const fetchImpl = vi.fn(async () => ndjsonResponse([
      { status: "chunk", lines: [{ idx: 0, start_ms: 0, end_ms: 1000, words: [] }], processed_ms: 720_000, total_ms: 720_000, meta: {} },
      { status: "done", meta: {} },
    ]));
    const result = await whisperxAlignerClient({
      blob: new Blob(["x"]), slidesByChapter: sbcOneChapter,
      connection: { baseUrl: "http://127.0.0.1:7861" }, fetchImpl,
    });
    expect(result.syntheticSegments).toEqual([]);
  });
});
