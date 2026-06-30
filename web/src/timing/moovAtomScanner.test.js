import { describe, it, expect } from "vitest";
import {
  scan, moovAtomTiming, findMoov, walkTopLevel, tailScanForMoov, readAtomHeader,
} from "./moovAtomScanner.js";
import { buildSlidesByChapter } from "./slides.js";

// ---------------------------------------------------------------------------
// Minimal ISO-BMFF atom builders — just enough structure to exercise the
// scanner's header-walking, mvhd parsing, and Nero chpl chapter parsing.
// ---------------------------------------------------------------------------
const enc = new TextEncoder();

function atom(type, payload, { size32Override } = {}) {
  const size = 8 + payload.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, size32Override !== undefined ? size32Override : size, false);
  out.set(enc.encode(type), 4);
  out.set(payload, 8);
  return out;
}

function atom64(type, payload) {
  // size===1 -> 64-bit largesize follows the fourcc
  const size = 16 + payload.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 1, false);
  out.set(enc.encode(type), 4);
  dv.setUint32(8, 0, false);
  dv.setUint32(12, size, false);
  out.set(payload, 16);
  return out;
}

function concat(arrs) {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

function mvhd(timescale, duration, version = 0) {
  if (version === 1) {
    const p = new Uint8Array(112);
    const dv = new DataView(p.buffer);
    p[0] = 1; // version
    dv.setUint32(20, timescale, false); // after version/flags(4)+created(8)+modified(8)
    // duration is 8 bytes at offset 24
    const hi = Math.floor(duration / 0x100000000);
    const lo = duration >>> 0;
    dv.setUint32(24, hi, false);
    dv.setUint32(28, lo, false);
    return atom("mvhd", p);
  }
  const p = new Uint8Array(100); // v0, zeros
  const dv = new DataView(p.buffer);
  dv.setUint32(12, timescale, false); // after version/flags(4)+created(4)+modified(4)
  dv.setUint32(16, duration, false);
  return atom("mvhd", p);
}

function chpl(entries) {
  // version=1, flags(3), reserved dword, count(1), then [ts(8,100ns)][len(1)][title]
  const parts = [new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, entries.length])];
  for (const [ms, title] of entries) {
    const t = enc.encode(title);
    const head = new Uint8Array(9);
    const dv = new DataView(head.buffer);
    const units = ms * 10000;
    dv.setUint32(0, Math.floor(units / 0x100000000), false);
    dv.setUint32(4, units >>> 0, false);
    head[8] = t.length;
    parts.push(head, t);
  }
  return atom("chpl", concat(parts));
}

const ftyp = atom("ftyp", enc.encode("M4A mp42M4A "));
const moov = (ts, dur, chapters) => atom("moov", concat([mvhd(ts, dur), atom("udta", chpl(chapters))]));
const moovNoChapters = (ts, dur) => atom("moov", mvhd(ts, dur));
const mdat = (n, fill = 0xaa) => atom("mdat", new Uint8Array(n).fill(fill));

function blobOf(u8) {
  return {
    size: u8.length,
    slice: (s, e) => ({ arrayBuffer: async () => u8.slice(Math.max(0, s), Math.max(0, e)).buffer }),
  };
}

const CHAPS = [[0, "Chapter 1"], [5000, "Chapter 2"]];

describe("scan — front-loaded (faststart) moov", () => {
  it("parses mvhd duration and chpl chapters", async () => {
    const info = await scan(blobOf(concat([ftyp, moov(1000, 10000, CHAPS), mdat(2000)])));
    expect(info.moovFound).toBe(true);
    expect(info.durationMs).toBe(10000);
    expect(info.hasChapters).toBe(true);
    expect(info.chapters).toHaveLength(2);
    expect(info.chapters[0]).toMatchObject({ startMs: 0, title: "Chapter 1" });
    expect(info.chapters[1]).toMatchObject({ startMs: 5000, title: "Chapter 2" });
  });

  it("is located via the forward-walk path when a large trailing mdat pushes moov outside the reverse-seek tail window", async () => {
    // mdat here is bigger than DEFAULT_TAIL_BYTES (1 MiB), so a genuinely
    // faststart moov (positioned before mdat) falls outside the tail-scan
    // window and reverse-seek correctly finds nothing — forward-walk must
    // be the fallback that locates it.
    const info = await scan(blobOf(concat([ftyp, moov(1000, 10000, CHAPS), mdat(2 << 20)])));
    expect(info.moovFound).toBe(true);
    expect(info.durationMs).toBe(10000);
    expect(info.source).toBe("forward-walk");
  });

  it("handles mvhd version 1 (64-bit duration field)", async () => {
    const v1moov = atom("moov", concat([mvhd(1000, 10000, 1), atom("udta", chpl(CHAPS))]));
    const info = await scan(blobOf(concat([ftyp, v1moov, mdat(500)])));
    expect(info.durationMs).toBe(10000);
  });

  it("handles a moov with no udta/chpl (no chapters) gracefully", async () => {
    const info = await scan(blobOf(concat([ftyp, moovNoChapters(1000, 7000), mdat(500)])));
    expect(info.moovFound).toBe(true);
    expect(info.durationMs).toBe(7000);
    expect(info.hasChapters).toBe(false);
    expect(info.chapters).toEqual([]);
  });

  it("handles a size===0 (extends-to-EOF) final atom", async () => {
    const m = moov(1000, 8000, CHAPS);
    new DataView(m.buffer).setUint32(0, 0, false); // declare size 0 => to EOF
    const info = await scan(blobOf(concat([ftyp, mdat(1000), m])));
    expect(info.moovFound).toBe(true);
    expect(info.durationMs).toBe(8000);
  });

  it("handles a size===1 (64-bit largesize) top-level atom", async () => {
    const bigMoov = atom64("moov", concat([mvhd(1000, 9000), atom("udta", chpl(CHAPS))]));
    const info = await scan(blobOf(concat([ftyp, bigMoov, mdat(500)])));
    expect(info.moovFound).toBe(true);
    expect(info.durationMs).toBe(9000);
  });
});

describe("scan — trailing-edge (non-faststart) moov", () => {
  it("locates moov appended after a large mdat via reverse-seek", async () => {
    const info = await scan(blobOf(concat([ftyp, mdat(5000), moov(600, 6000, CHAPS)])));
    expect(info.moovFound).toBe(true);
    expect(info.durationMs).toBe(10000); // 6000/600 * 1000
    expect(info.source).toBe("reverse-seek");
  });

  it("never buffers the mdat payload while locating a trailing moov (memory-safety contract)", async () => {
    let maxSliceLen = 0;
    const real = blobOf(concat([ftyp, mdat(2_000_000), moov(1000, 10000, CHAPS)]));
    const spy = {
      size: real.size,
      slice: (s, e) => {
        maxSliceLen = Math.max(maxSliceLen, e - s);
        return real.slice(s, e);
      },
    };
    const info = await scan(spy);
    expect(info.moovFound).toBe(true);
    // The largest single slice should be far smaller than the mdat payload —
    // we only ever read atom headers + the (small) moov region, never mdat bytes.
    expect(maxSliceLen).toBeLessThan(2_000_000);
  });

  it("finds the LAST structurally-valid moov when the tail window contains more than one candidate", async () => {
    // Two moov-shaped atoms near the tail; only the final, complete one should win.
    const decoy = moov(1000, 1234, [[0, "Decoy"]]);
    const real = moov(2000, 20000, CHAPS);
    const info = await scan(blobOf(concat([ftyp, mdat(1000), decoy, real])));
    expect(info.durationMs).toBe(10000); // 20000/2000*1000, from `real`
  });
});

describe("scan — sudden EOF / truncated / malformed streams", () => {
  it("returns moovFound:false for a file with no moov atom at all", async () => {
    const info = await scan(blobOf(concat([ftyp, mdat(4000)])));
    expect(info.moovFound).toBe(false);
    expect(info.durationMs).toBe(0);
    expect(info.chapters).toEqual([]);
    expect(info.source).toBe("none");
  });

  it("returns the empty/none shape for a zero-byte blob", async () => {
    const info = await scan(blobOf(new Uint8Array(0)));
    expect(info.moovFound).toBe(false);
  });

  it("returns the empty/none shape for a null/undefined blob", async () => {
    expect((await scan(null)).moovFound).toBe(false);
    expect((await scan(undefined)).moovFound).toBe(false);
  });

  it("does not throw when the file is truncated mid-header (sudden EOF)", async () => {
    const full = concat([ftyp, moov(1000, 10000, CHAPS)]);
    const truncated = full.slice(0, full.length - 50); // cut off mid-moov
    await expect(scan(blobOf(truncated))).resolves.toBeDefined();
  });

  it("does not throw or hang on a file truncated to a single byte", async () => {
    await expect(scan(blobOf(new Uint8Array([0x00])))).resolves.toBeDefined();
  });

  it("does not throw on a top-level atom whose declared size overruns the file", async () => {
    const corrupt = atom("ftyp", new Uint8Array(4), { size32Override: 999_999 });
    const info = await scan(blobOf(concat([corrupt, mdat(100)])));
    expect(info.moovFound).toBe(false);
  });

  it("does not loop forever on a zero-size, non-final atom (corruption guard)", async () => {
    const zeroSizeMid = atom("free", new Uint8Array(4), { size32Override: 0 });
    // size 0 means "to EOF" per spec, so walkTopLevel should stop, not loop.
    const blob = blobOf(concat([zeroSizeMid, mdat(100)]));
    await expect(walkTopLevel(blob)).resolves.toBeDefined();
  });

  it("rejects a reverse-seek 'moov' fourcc that occurs inside random audio bytes (false-positive guard)", async () => {
    // Plant the literal 'moov' fourcc inside an mdat payload that otherwise has no
    // valid child-box structure following it — moovLooksValid must reject it.
    const fakeBytes = new Uint8Array(2000).fill(0x41); // 'A' filler, no structure
    const moovFourccBytes = enc.encode("moov");
    fakeBytes.set(moovFourccBytes, 1000); // plant fourcc with garbage on both sides
    const blob = blobOf(concat([ftyp, atom("mdat", fakeBytes), moov(1000, 5000, CHAPS)]));
    const info = await scan(blob);
    // The real moov (appended last) must still be the one found, not the planted fourcc.
    expect(info.moovFound).toBe(true);
    expect(info.durationMs).toBe(5000);
  });

  it("readAtomHeader returns null when fewer than 8 bytes remain", async () => {
    const blob = blobOf(new Uint8Array([1, 2, 3, 4]));
    const header = await readAtomHeader(blob, 0);
    expect(header).toBeNull();
  });

  it("findMoov returns null (not a throw) when no moov exists anywhere", async () => {
    const blob = blobOf(concat([ftyp, mdat(1000)]));
    expect(await findMoov(blob)).toBeNull();
  });
});

describe("moovAtomTiming", () => {
  it("snaps script chapters to container chapter markers and sub-distributes with zero drift (aligned case)", () => {
    const book = { scenes: [{ chapter: 1, lines: [{ text: "a" }, { text: "bb" }] }] };
    const sbc = buildSlidesByChapter(book);
    const containerInfo = {
      moovFound: true, timescale: 1000, durationMs: 10000, hasChapters: true,
      chapters: [{ index: 0, startMs: 0, title: "C1" }], source: "forward-walk",
    };
    const result = moovAtomTiming({ slidesByChapter: sbc, containerInfo });
    expect(result.marker).toBe("container-atom-snap");
    expect(result.meta.snapped).toBe(true);
    const sum = result.chapters[0].slides.reduce((a, s) => a + s.durationMs, 0);
    expect(sum).toBe(10000);
    expect(result.chapters[0].slides[0].startMs).toBe(0);
  });

  it("degrades gracefully (whole-book linear) when the container has no chapter markers", () => {
    const book = { scenes: [{ chapter: 1, lines: [{ text: "a" }, { text: "bb" }] }] };
    const sbc = buildSlidesByChapter(book);
    const containerInfo = { moovFound: true, timescale: 1000, durationMs: 5000, hasChapters: false, chapters: [], source: "reverse-seek" };
    const result = moovAtomTiming({ slidesByChapter: sbc, containerInfo });
    expect(result.meta.snapped).toBe(false);
    expect(result.meta.degraded).toBe(true);
    const sum = Object.values(result.lineTimings).reduce((a, t) => a + t.durationMs, 0);
    expect(sum).toBe(5000);
  });

  it("degrades gracefully when the container chapter count doesn't match the script chapter count", () => {
    const book = { scenes: [{ chapter: 1, lines: [{ text: "a" }] }] }; // 1 script chapter
    const sbc = buildSlidesByChapter(book);
    const containerInfo = {
      moovFound: true, timescale: 1000, durationMs: 10000, hasChapters: true,
      chapters: [{ index: 0, startMs: 0, title: "C1" }, { index: 1, startMs: 5000, title: "C2" }], // 2 markers
      source: "reverse-seek",
    };
    const result = moovAtomTiming({ slidesByChapter: sbc, containerInfo });
    expect(result.meta.degraded).toBe(true);
    expect(result.meta.reason).toMatch(/chapter count mismatch/);
  });

  it("degrades to zero-duration output (no crash) when moov was never found", () => {
    const book = { scenes: [{ chapter: 1, lines: [{ text: "a" }] }] };
    const sbc = buildSlidesByChapter(book);
    const containerInfo = { moovFound: false, timescale: 0, durationMs: 0, hasChapters: false, chapters: [], source: "none" };
    const result = moovAtomTiming({ slidesByChapter: sbc, containerInfo });
    expect(result.totalDurationMs).toBe(0);
    expect(result.lineTimings[0]).toEqual({ startMs: 0, endMs: 0, durationMs: 0 });
  });

  it("handles a missing/undefined containerInfo without throwing", () => {
    const book = { scenes: [{ chapter: 1, lines: [{ text: "a" }] }] };
    const sbc = buildSlidesByChapter(book);
    expect(() => moovAtomTiming({ slidesByChapter: sbc, containerInfo: undefined })).not.toThrow();
  });
});

describe("tailScanForMoov", () => {
  it("returns null when the tail window is too small to contain a header", async () => {
    const blob = blobOf(new Uint8Array(4));
    expect(await tailScanForMoov(blob)).toBeNull();
  });

  it("respects a custom tailBytes window", async () => {
    // moov sits well outside a tiny 16-byte tail window — must not be found via reverse-seek.
    const blob = blobOf(concat([ftyp, moov(1000, 5000, CHAPS), mdat(10000)]));
    const result = await tailScanForMoov(blob, 16);
    expect(result).toBeNull();
  });
});
