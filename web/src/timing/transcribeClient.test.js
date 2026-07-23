import { describe, it, expect } from "vitest";
import { transcribeM4b } from "./transcribeClient.js";

/** Build a fake fetch that streams the given NDJSON rows as a response body. */
function fakeFetch(rows) {
  const ndjson = rows.map((r) => JSON.stringify(r)).join("\n");
  return async () => ({
    ok: true,
    body: {
      getReader() {
        let sent = false;
        const bytes = new TextEncoder().encode(ndjson);
        return {
          async read() {
            if (sent) return { done: true };
            sent = true;
            return { done: false, value: bytes };
          },
        };
      },
    },
  });
}

describe("transcribeM4b", () => {
  const conn = { baseUrl: "http://127.0.0.1:7861" };

  it("assembles streamed chunk rows into a contiguous transcript", async () => {
    const rows = [
      { status: "chunk", processed_ms: 100, total_ms: 200, lines: [
        { idx: 0, text: "One.", start_ms: 0, end_ms: 100, words: [["One.", 0, 100]] },
      ] },
      { status: "chunk", processed_ms: 200, total_ms: 200, lines: [
        { idx: 1, text: "Two.", start_ms: 100, end_ms: 200, words: [["Two.", 100, 200]] },
      ] },
      { status: "done", line_count: 2, total_ms: 200, meta: { model: "small" } },
    ];
    const seen = [];
    const out = await transcribeM4b({
      blob: new Blob(["x"]), connection: conn, bookId: "b", title: "T",
      onLinesReady: (lines) => seen.push(...lines.map((l) => l.idx)),
      fetchImpl: fakeFetch(rows),
    });
    expect(out.durationMs).toBe(200);
    expect(out.lines.map((l) => l.text)).toEqual(["One.", "Two."]);
    expect(out.lines[0].words).toEqual([["One.", 0, 100]]);
    expect(seen).toEqual([0, 1]); // incremental callback fired per chunk
  });

  it("reindexes lines contiguously even if server idx has gaps", async () => {
    const rows = [
      { status: "chunk", processed_ms: 100, total_ms: 100, lines: [
        { idx: 5, text: "B.", start_ms: 50, end_ms: 100, words: [] },
        { idx: 2, text: "A.", start_ms: 0, end_ms: 50, words: [] },
      ] },
      { status: "done", line_count: 2, total_ms: 100 },
    ];
    const out = await transcribeM4b({ blob: new Blob(["x"]), connection: conn, fetchImpl: fakeFetch(rows) });
    // sorted by original idx, then reindexed 0..n-1
    expect(out.lines.map((l) => [l.idx, l.text])).toEqual([[0, "A."], [1, "B."]]);
  });

  it("throws if the stream ends without a done row", async () => {
    const rows = [{ status: "chunk", processed_ms: 100, total_ms: 100, lines: [] }];
    await expect(transcribeM4b({ blob: new Blob(["x"]), connection: conn, fetchImpl: fakeFetch(rows) }))
      .rejects.toThrow(/without a result/);
  });

  it("awaits onLinesReady before onProgress, and awaits both before the next row", async () => {
    // Regression: both callbacks persist to the SAME local pack record
    // (appendM4bFirstLines / checkpointM4bFirstProgress). If they ran
    // concurrently, or the next row started before either settled, a
    // slow write could be clobbered by a stale read-modify-write from
    // another in-flight write — symptom: resume silently loses its
    // checkpoint and a "resumed" run restarts from 0.
    const rows = [
      { status: "chunk", processed_ms: 100, total_ms: 300, lines: [
        { idx: 0, text: "One.", start_ms: 0, end_ms: 100, words: [] },
      ] },
      { status: "chunk", processed_ms: 200, total_ms: 300, lines: [
        { idx: 1, text: "Two.", start_ms: 100, end_ms: 200, words: [] },
      ] },
      { status: "done", line_count: 2, total_ms: 300 },
    ];
    const events = [];
    const delay = (ms) => new Promise((r) => { setTimeout(r, ms); });
    await transcribeM4b({
      blob: new Blob(["x"]), connection: conn, bookId: "b", title: "T",
      fetchImpl: fakeFetch(rows),
      onLinesReady: async (lines) => { events.push(`lines-start:${lines[0].idx}`); await delay(5); events.push(`lines-end:${lines[0].idx}`); },
      onProgress: async (processedMs) => { events.push(`progress-start:${processedMs}`); await delay(5); events.push(`progress-end:${processedMs}`); },
    });
    expect(events).toEqual([
      "lines-start:0", "lines-end:0", "progress-start:100", "progress-end:100",
      "lines-start:1", "lines-end:1", "progress-start:200", "progress-end:200",
    ]);
  });

  it("surfaces a server error row", async () => {
    const rows = [{ status: "error", error: "boom" }];
    await expect(transcribeM4b({ blob: new Blob(["x"]), connection: conn, fetchImpl: fakeFetch(rows) }))
      .rejects.toThrow(/boom/);
  });
});
