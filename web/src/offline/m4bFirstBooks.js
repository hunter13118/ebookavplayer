// M4B-first local book install (docs/M4B_FIRST_FLOW.md) — the audiobook is
// the ONLY input, so the "book" starts life entirely client-side: a local
// pack record (PACKS store, reusing the SAME shape a real .vaepack installs
// as — see packStore.js's installPackFromEntries) carrying the live
// transcript as scenes/lines, plus the attached .m4b blob via the EXISTING
// m4bStore.js (already keyed by book_id, already what Player.jsx's
// mount-time m4b-reload effect looks for).
//
// Because fetchBook() (bookSource.js) already prefers a matching REMOTE book
// over the local-pack fallback the moment one exists, this book "upgrades"
// itself automatically once formal extraction (ingest-text) completes
// server-side — no merge step needed here.
import { savePackRecord, getInstalledPack, deletePack } from "./packStore.js";
import { storeM4b, removeM4b } from "./m4bStore.js";
import { FORMAT_ID, FORMAT_VERSION, TIER_VISUAL } from "./packFormat.js";

const PACK_ORIGIN = "m4b-first";

function packIdFor(bookId) {
  return `${bookId}::m4b-first`;
}

/** "my-book-title.m4b" -> "My Book Title" — a readable default before the
 *  user (or later, formal extraction) supplies a real title. */
export function titleFromFilename(fileName) {
  const stem = String(fileName || "").replace(/\.m4b$/i, "");
  const spaced = stem.replace(/[_-]+/g, " ").trim();
  return spaced.replace(/\b\w/g, (c) => c.toUpperCase()) || "Untitled audiobook";
}

/** "My Book Title.m4b" -> "my-book-title" — same slugging convention the
 *  worker uses for EPUB ingest (worker/api/v1/ingest.js), so an M4B-first
 *  book_id looks and behaves like any other. */
export function bookIdFromFilename(fileName) {
  const stem = String(fileName || "book").replace(/\.m4b$/i, "");
  return stem.replace(/[^\w-]+/g, "-").slice(0, 64) || `m4b-${Date.now()}`;
}

function transcriptLineToBookLine(line) {
  return {
    idx: line.idx,
    kind: "narration",
    character_id: "narrator",
    text: line.text,
    chapter: 1,
    // M4B-first exact timing, carried directly on the line — Player.jsx's
    // fast path (timing/m4bFirstTimeline.js) reads these instead of running
    // the 4-algorithm estimate/alignment dance real attach-.m4b books need,
    // since we already know precisely where each line sits in the file.
    startMs: line.startMs,
    endMs: line.endMs,
    words: line.words,
  };
}

function emptyBook(bookId, title) {
  return {
    book_id: bookId,
    title,
    author: "",
    art_style: null,
    art_filter: null,
    characters: {
      narrator: {
        name: "Narrator", importance: "primary", gender: "male", sprite: "sprite:narrator",
        voice: "", pitch: "+0Hz", rate: "+0%", description: "",
      },
    },
    scenes: [
      { id: "scene-0001", chapter: 1, title: "", location: "", background: null, present: [], lines: [] },
    ],
    m4b_first_status: "transcribing",
    // No real EPUB yet — this book's only text is the live ASR transcript.
    // Settings' "text source" indicator reads this; formal extraction
    // (worker/queue/ingest-text-consumer.js) sets the same value on the
    // server book it upgrades to, until a real EPUB is attached (PlayerMenu's
    // "Attach EPUB…", worker/api/v1/ingest.js) flips it to "epub".
    text_source: "m4b_transcript",
  };
}

function bookLineCount(book) {
  return (book.scenes || []).reduce((n, s) => n + (s.lines?.length || 0), 0);
}

/** Start a new M4B-first local book: save the initial (empty) pack record
 *  and store the attached .m4b blob. Call appendLines() as transcription
 *  streams in. */
export async function installM4bFirstBook({ bookId, title, blob, fileName }) {
  const packId = packIdFor(bookId);
  const record = {
    pack_id: packId,
    book_id: bookId,
    title,
    author: "",
    tier: TIER_VISUAL,
    style: null,
    audio_engine: null,
    manifest: {
      format: FORMAT_ID, format_version: FORMAT_VERSION, book_id: bookId, pack_id: packId,
      tier: TIER_VISUAL, style: null,
    },
    book: emptyBook(bookId, title),
    voices: {},
    media_index: {},
    audio_manifest: [],
    blob_paths: [],
    pack_origin: PACK_ORIGIN,
    installed_at: Date.now(),
    size_bytes: 0,
  };
  await savePackRecord(record);
  await storeM4b(bookId, blob, fileName);
  return record;
}

/** Append newly-transcribed lines (from transcribeM4b's onLinesReady) into
 *  the book's single scene, in order. Safe to call repeatedly as chunks
 *  stream in — each call re-saves the whole (still small — plain text)
 *  pack record. */
export async function appendM4bFirstLines(bookId, newLines) {
  if (!newLines?.length) return null;
  const packId = packIdFor(bookId);
  const record = await getInstalledPack(packId);
  if (!record) return null;
  const scene = record.book.scenes[0];
  scene.lines.push(...newLines.map(transcriptLineToBookLine));
  await savePackRecord(record);
  return record;
}

/** Checkpoint how far transcription has gotten (called on every server chunk,
 *  not just ones that produced new lines) so a refresh/crash can resume from
 *  here instead of re-transcribing the whole file — see resumeM4bFirstPoint()
 *  and transcribeM4b's resumeMs/resumeIdx. Cheap: same small pack-record save
 *  as appendM4bFirstLines. */
export async function checkpointM4bFirstProgress(bookId, processedMs) {
  if (processedMs == null) return null;
  const packId = packIdFor(bookId);
  const record = await getInstalledPack(packId);
  if (!record) return null;
  record.book.m4b_first_progress_ms = processedMs;
  await savePackRecord(record);
  return record;
}

/** Where a stalled/interrupted transcription left off — the ASR offset to
 *  resume from (checkpointM4bFirstProgress) and the line index to continue
 *  numbering from (however many lines are already saved). Null if there's
 *  nothing to resume (no local record, or already fully transcribed). */
export async function resumeM4bFirstPoint(bookId) {
  const record = await getInstalledPack(packIdFor(bookId));
  if (!record || record.book.m4b_first_status !== "transcribing") return null;
  return {
    resumeMs: record.book.m4b_first_progress_ms || 0,
    resumeIdx: bookLineCount(record.book),
  };
}

/** Mark the transcript complete (all chunks applied) — flips the status flag
 *  the reader/library can use to stop showing a "transcribing…" hint. Does
 *  NOT trigger formal extraction itself; the caller (the upload flow) does
 *  that once this resolves. */
export async function markM4bFirstTranscriptComplete(bookId, { durationMs } = {}) {
  const packId = packIdFor(bookId);
  const record = await getInstalledPack(packId);
  if (!record) return null;
  record.book.m4b_first_status = "transcribed";
  if (durationMs != null) record.book.m4b_duration_ms = durationMs;
  await savePackRecord(record);
  return record;
}

/** Full transcript text, book lines in order — this is exactly the
 *  `body_text` formal extraction (POST /books/:id/ingest-text) needs. */
export async function m4bFirstTranscriptText(bookId) {
  const record = await getInstalledPack(packIdFor(bookId));
  if (!record) return "";
  return bookLineCount(record.book) > 0
    ? record.book.scenes.flatMap((s) => s.lines.map((l) => l.text)).join(" ")
    : "";
}

/** Remove an M4B-first book's local pack + attached blob (e.g. user deletes
 *  it, or a fresh re-upload replaces it). */
export async function removeM4bFirstBook(bookId) {
  await deletePack(packIdFor(bookId));
  await removeM4b(bookId);
}
