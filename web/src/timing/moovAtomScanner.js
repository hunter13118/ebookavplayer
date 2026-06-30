// ALGORITHM 3 — Metadata Container Atom Cross-Multiplier ("Advanced Online").
//
// Low-level MPEG-4 / ISO-BMFF (ISO/IEC 14496-12) scanner that reads a local .m4b
// Blob/ArrayBuffer DIRECTLY in the browser — no native binaries, no server.
//
// MEMORY SAFETY (128MB cap, multi-GB files):
//   We NEVER read the whole file. We slice 16-byte atom HEADERS and walk the top
//   level by pointer arithmetic, skipping the gigantic `mdat` payload entirely
//   (we advance past it by its declared size without ever touching its bytes).
//   The only payload we ever materialize is the `moov` atom (typically a few MB).
//
//   Two strategies locate `moov`:
//     1. reverse-seek fast path — slice the file's tail and scan for a trailing
//        `moov` fourcc (the common non-faststart layout where moov is appended
//        after a huge mdat). Locates it "instantly" without reading the body.
//     2. forward header-walk — the correctness backstop; walks top-level atoms,
//        skipping mdat by offset, and works for front-loaded (faststart) moov too.
//
// From `moov` we extract `mvhd` (timescale + total duration) and the Nero `chpl`
// chapter list, then snap our script chapters onto those native container markers.

import { spanSlides } from "./distribute.js";
import { buildResult, countSlides } from "./slides.js";

export const MOOV_MARKER = "container-atom-snap";

const HUNDRED_NS_PER_MS = 10000; // chpl timestamps are in 100-nanosecond units
const MAX_TOP_LEVEL_ATOMS = 8192; // corruption guard for the forward walk
const DEFAULT_TAIL_BYTES = 1 << 20; // 1 MiB reverse-seek window
const MAX_MOOV_BYTES = 32 << 20; // a real m4b moov is a few MB; keep headroom under a 128MB cap

// Plausible direct children of a `moov` box. Used to structurally validate a
// reverse-seek candidate so a stray 'moov' fourcc inside mdat audio can't be
// mistaken for the real atom.
const MOOV_CHILD_TYPES = new Set(["mvhd", "trak", "udta", "mvex", "iods", "meta", "cmov", "ctab"]);

/** A Blob-like with `.size` and `.slice(start,end).arrayBuffer()` (browser File/Blob). */
/** @typedef {{ size:number, slice:(start:number,end:number)=>{arrayBuffer:()=>Promise<ArrayBuffer>} }} BlobLike */

async function readBytes(blob, start, end) {
  const s = Math.max(0, Math.min(start, blob.size));
  const e = Math.max(s, Math.min(end, blob.size));
  if (e <= s) return new Uint8Array(0);
  const buf = await blob.slice(s, e).arrayBuffer();
  return new Uint8Array(buf);
}

function u32(view, off) {
  return view.getUint32(off, false);
}
function u64(view, off) {
  // Safe for our magnitudes (durations/offsets well under 2^53).
  const hi = view.getUint32(off, false);
  const lo = view.getUint32(off + 4, false);
  return hi * 0x100000000 + lo;
}
function fourcc(bytes, off) {
  return String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
}

/**
 * Read an atom header at `offset`. Returns null if there aren't enough bytes.
 * @param {BlobLike} blob
 * @param {number} offset
 */
export async function readAtomHeader(blob, offset) {
  if (offset + 8 > blob.size) return null;
  const head = await readBytes(blob, offset, offset + 16);
  if (head.length < 8) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.length);
  let size = u32(view, 0);
  const type = fourcc(head, 4);
  let headerSize = 8;
  if (size === 1) {
    if (head.length < 16) return null;
    size = u64(view, 8);
    headerSize = 16;
  } else if (size === 0) {
    // Extends to EOF.
    size = blob.size - offset;
  }
  if (size < headerSize) return null; // malformed
  const end = offset + size;
  return { type, size, headerSize, start: offset, dataStart: offset + headerSize, end };
}

/**
 * Enumerate top-level atoms by header-walking. Reads only headers; skips mdat
 * payload by offset. Stops at EOF, malformed size, or the corruption guard.
 * @param {BlobLike} blob
 */
export async function walkTopLevel(blob) {
  const atoms = [];
  let offset = 0;
  for (let i = 0; i < MAX_TOP_LEVEL_ATOMS; i += 1) {
    if (offset + 8 > blob.size) break;
    // eslint-disable-next-line no-await-in-loop
    const h = await readAtomHeader(blob, offset);
    if (!h) break;
    atoms.push(h);
    if (h.end <= offset || h.end > blob.size) break; // truncated/eof/corrupt
    offset = h.end;
  }
  return atoms;
}

/**
 * Cheap structural sniff: a real `moov` opens with a known child box (mvhd/trak/…)
 * whose size stays within the moov body. Reading just the first child header (16
 * bytes) rejects the overwhelming majority of random-audio false positives without
 * buffering the region.
 * @param {BlobLike} blob
 * @param {{dataStart:number,end:number}} header
 */
async function moovLooksValid(blob, header) {
  const child = await readAtomHeader(blob, header.dataStart);
  if (!child) return false;
  if (child.end > header.end || child.size < child.headerSize) return false;
  return MOOV_CHILD_TYPES.has(child.type);
}

/**
 * Reverse-seek fast path: scan the file tail for a trailing `moov` atom. Only
 * STRUCTURALLY-VALID candidates (see moovLooksValid) are accepted, so a 'moov'
 * fourcc that coincidentally occurs inside mdat audio bytes is rejected.
 * @param {BlobLike} blob
 * @param {number} [tailBytes]
 * @returns {Promise<{start:number,size:number,headerSize:number,dataStart:number,end:number}|null>}
 */
export async function tailScanForMoov(blob, tailBytes = DEFAULT_TAIL_BYTES) {
  const tailLen = Math.min(tailBytes, blob.size);
  if (tailLen < 8) return null;
  const tailStart = blob.size - tailLen;
  const bytes = await readBytes(blob, tailStart, blob.size);
  // Search for the 'moov' fourcc; the size field sits 4 bytes before the type.
  let best = null;
  for (let p = 0; p + 8 <= bytes.length; p += 1) {
    if (bytes[p] === 0x6d && bytes[p + 1] === 0x6f && bytes[p + 2] === 0x6f && bytes[p + 3] === 0x76) {
      const typePos = tailStart + p;
      const atomStart = typePos - 4;
      if (atomStart < 0) continue;
      // eslint-disable-next-line no-await-in-loop
      const h = await readAtomHeader(blob, atomStart);
      if (
        h && h.type === "moov" && h.end <= blob.size && h.size >= h.headerSize
        && h.size <= MAX_MOOV_BYTES
        // eslint-disable-next-line no-await-in-loop
        && (await moovLooksValid(blob, h))
      ) {
        best = h; // keep the last structurally-valid candidate (the trailing moov)
      }
    }
  }
  return best;
}

/**
 * Locate the `moov` atom: reverse-seek first, forward-walk as backstop.
 * @param {BlobLike} blob
 * @returns {Promise<{header:object, source:'reverse-seek'|'forward-walk'}|null>}
 */
export async function findMoov(blob) {
  const tail = await tailScanForMoov(blob);
  if (tail) return { header: tail, source: "reverse-seek" };
  const atoms = await walkTopLevel(blob);
  const moov = atoms.find((a) => a.type === "moov");
  return moov ? { header: moov, source: "forward-walk" } : null;
}

/** Walk child atoms within an already-buffered container region (in-memory). */
function walkChildren(bytes, regionStart, regionEnd) {
  const children = [];
  let off = regionStart;
  while (off + 8 <= regionEnd) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + off, Math.min(16, regionEnd - off));
    let size = u32(view, 0);
    const type = fourcc(bytes, off + 4);
    let headerSize = 8;
    if (size === 1) {
      if (off + 16 > regionEnd) break;
      size = u64(view, 8);
      headerSize = 16;
    } else if (size === 0) {
      size = regionEnd - off;
    }
    if (size < headerSize || off + size > regionEnd) break;
    children.push({ type, start: off, dataStart: off + headerSize, end: off + size });
    off += size;
  }
  return children;
}

function parseMvhd(bytes, atom) {
  const v = new DataView(bytes.buffer, bytes.byteOffset + atom.dataStart, atom.end - atom.dataStart);
  const version = v.getUint8(0);
  let timescale;
  let duration;
  if (version === 1) {
    timescale = v.getUint32(4 + 8 + 8, false); // after version/flags(4)+created(8)+modified(8)
    duration = u64(v, 4 + 8 + 8 + 4);
  } else {
    timescale = v.getUint32(4 + 4 + 4, false); // version/flags(4)+created(4)+modified(4)
    duration = v.getUint32(4 + 4 + 4 + 4, false);
  }
  if (!timescale) return null;
  return { timescale, durationMs: Math.round((duration / timescale) * 1000) };
}

/** Parse a Nero `chpl` chapter list (mirrors ffmpeg mov_read_chpl). */
function parseChpl(bytes, atom) {
  const start = atom.dataStart;
  const end = atom.end;
  if (end - start < 5) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, end - start);
  let off = 0;
  const version = view.getUint8(off); off += 1;
  off += 3; // flags
  if (version) off += 4; // version-1 reserved dword
  if (off >= view.byteLength) return [];
  const count = view.getUint8(off); off += 1;
  const chapters = [];
  for (let i = 0; i < count; i += 1) {
    if (off + 9 > view.byteLength) break;
    const ts100ns = u64(view, off); off += 8;
    const len = view.getUint8(off); off += 1;
    if (off + len > view.byteLength) break;
    let title = "";
    for (let k = 0; k < len; k += 1) title += String.fromCharCode(view.getUint8(off + k));
    off += len;
    chapters.push({ index: i, startMs: Math.round(ts100ns / HUNDRED_NS_PER_MS), title });
  }
  return chapters;
}

/** Buffer a moov region and parse mvhd (duration) + udta/chpl (chapters). */
async function parseMoovRegion(blob, header) {
  const moovBytes = await readBytes(blob, header.start, header.end);
  const top = walkChildren(moovBytes, header.headerSize, moovBytes.length);
  let timescale = 0;
  let durationMs = 0;
  let chapters = [];
  let mvhdFound = false;
  for (const child of top) {
    if (child.type === "mvhd") {
      const parsed = parseMvhd(moovBytes, child);
      if (parsed) { timescale = parsed.timescale; durationMs = parsed.durationMs; mvhdFound = true; }
    } else if (child.type === "udta") {
      const udtaChildren = walkChildren(moovBytes, child.dataStart, child.end);
      const chpl = udtaChildren.find((c) => c.type === "chpl");
      if (chpl) chapters = parseChpl(moovBytes, chpl);
    }
  }
  return { timescale, durationMs, chapters, mvhdFound };
}

/**
 * Scan an .m4b Blob and extract container timing facts.
 * @param {BlobLike} blob
 * @returns {Promise<import('./types.js').ContainerInfo>}
 */
export async function scan(blob) {
  const none = { moovFound: false, timescale: 0, durationMs: 0, hasChapters: false, chapters: [], source: "none" };
  if (!blob || !blob.size) return none;

  const found = await findMoov(blob);
  if (!found) return none;
  let { header, source } = found;
  if (header.size > MAX_MOOV_BYTES) return { ...none, moovFound: true, source };

  let parsed = await parseMoovRegion(blob, header);

  // If a reverse-seek region didn't actually contain an mvhd, it may have been a
  // weak match — re-resolve via the structural forward header-walk and re-parse.
  if (!parsed.mvhdFound && source === "reverse-seek") {
    const atoms = await walkTopLevel(blob);
    const fwd = atoms.find((a) => a.type === "moov");
    if (fwd && fwd.size <= MAX_MOOV_BYTES && fwd.start !== header.start) {
      header = fwd;
      source = "forward-walk";
      parsed = await parseMoovRegion(blob, header);
    }
  }

  return {
    moovFound: true,
    timescale: parsed.timescale,
    durationMs: parsed.durationMs,
    hasChapters: parsed.chapters.length > 0,
    chapters: parsed.chapters,
    source,
  };
}

/**
 * Snap the script's chapters onto the container's native chapter markers, then
 * sub-distribute each chapter's lines linearly (zero-drift) within its real span.
 *
 * @param {Object} input
 * @param {import('./types.js').ChapterSlides[]} input.slidesByChapter
 * @param {import('./types.js').ContainerInfo} input.containerInfo
 * @returns {import('./types.js').TimingResult}
 */
export function moovAtomTiming({ slidesByChapter, containerInfo }) {
  const totalMs = containerInfo?.durationMs || 0;
  const markers = containerInfo?.chapters || [];

  // Build per-script-chapter spans by index-mapping onto container markers.
  const aligned =
    containerInfo?.hasChapters && markers.length === slidesByChapter.length;

  if (aligned) {
    /** @type {import('./types.js').ChapterTiming[]} */
    const chapters = slidesByChapter.map((ch, i) => {
      const startMs = markers[i].startMs;
      const endMs = i + 1 < markers.length ? markers[i + 1].startMs : totalMs;
      const durationMs = Math.max(0, endMs - startMs);
      const slides = spanSlides(startMs, durationMs, ch.slides, (s) => s.charCount);
      return { chapter: ch.chapter, startMs, endMs: startMs + durationMs, durationMs, slides };
    });
    return buildResult("moov-atom", MOOV_MARKER, chapters, {
      strategy: "container-snap",
      source: containerInfo.source,
      snapped: true,
    });
  }

  // Degraded: no usable per-chapter markers (missing chpl, or count mismatch).
  // Fall back to one linear distribution of the whole container duration across
  // every slide in the book, so playback still tracks total length.
  const allSlides = slidesByChapter.flatMap((c) => c.slides);
  const slides = spanSlides(0, totalMs, allSlides, (s) => s.charCount);
  // Regroup the flat timings back under their chapters for the result shape.
  let cursor = 0;
  const chapters = slidesByChapter.map((ch) => {
    const slice = slides.slice(cursor, cursor + ch.slides.length);
    cursor += ch.slides.length;
    const startMs = slice.length ? slice[0].startMs : 0;
    const endMs = slice.length ? slice[slice.length - 1].endMs : startMs;
    return { chapter: ch.chapter, startMs, endMs, durationMs: endMs - startMs, slides: slice };
  });
  return buildResult("moov-atom", MOOV_MARKER, chapters, {
    strategy: "container-snap",
    source: containerInfo?.source || "none",
    snapped: false,
    degraded: true,
    reason: containerInfo?.hasChapters
      ? `chapter count mismatch (container ${markers.length} vs script ${slidesByChapter.length})`
      : "no container chapter markers (chpl); distributed across total duration",
    slidesCounted: countSlides(slidesByChapter),
  });
}
