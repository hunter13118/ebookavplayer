// Caches a computed alignment manifest (a TimingResult) so re-attaching the
// same .m4b to the same book doesn't re-run a genuinely multi-minute
// computation (WhisperX ASR + forced alignment) on every load. Reuses the
// generic settings store (packStore.js) — no new IndexedDB object store or
// version bump needed, same pattern as m4bStore.js.
import { putSetting, getSetting, deleteSetting } from "./packStore.js";

const manifestKey = (bookId, algorithmId) => `align-manifest::${bookId}::${algorithmId}`;

// Bump whenever a change to the align server's matching logic could make an
// already-cached manifest wrong (not just stale) — e.g. the false-anchor fix
// in scripts/local-align-server/server.py's IncrementalAligner (STRICT_
// ANCHOR_BLOCK_WORDS), which could have baked bogus, distant timings into
// manifests computed before the fix ("random jump" bug).
//
// Deliberately does NOT namespace the storage key (an earlier version of
// this comment did, and it was wrong): that made every pre-existing manifest
// unreachable outright, and Player.jsx's applyM4bTimeline only preserves real
// acoustic sync (and gaps!) when it finds SOME cached data to use as a
// working baseline — with nothing cached at all, it drops straight to a
// crude text-length-estimate timeline (no gaps possible, wrong-feeling
// duration) and only recovers real sync if the local align server happens to
// be reachable AND its background realign completes. Confirmed live: with
// the align server not running, a schema bump via key-namespacing silently
// downgraded a working, gap-complete book to that crude estimate with no way
// back short of starting the server and waiting through a full re-align.
//
// Instead, loadAlignManifest reports an OLD-schema record as `complete:
// false` while still returning its real `result` — reusing the EXISTING
// "resume from a real cached baseline, refine live in the background"
// machinery (built for the page-reload-mid-alignment case) instead of
// discarding working data. The book keeps its current sync/gaps immediately;
// a fresh, corrected alignment only replaces it once one actually completes.
const SCHEMA_VERSION = 2;

/**
 * Cheap fingerprint of "what was aligned": the m4b's byte size plus the
 * book's total line count and character count. Catches both "a different
 * m4b was attached" and "the book was re-extracted with different lines" —
 * a full content hash isn't needed since a false cache hit just means an
 * unnecessary re-align, not silent corruption (the manifest itself carries
 * the real lineIndex keys, so a stale-but-matching-fingerprint manifest
 * would only ever mistime lines, never crash).
 */
function fingerprint(blobSize, slidesByChapter) {
  let lineCount = 0;
  let charCount = 0;
  for (const ch of slidesByChapter || []) {
    for (const s of ch.slides || []) {
      lineCount += 1;
      charCount += s.charCount || 0;
    }
  }
  return `${blobSize || 0}:${lineCount}:${charCount}`;
}

/** Persist a computed alignment manifest for a book + algorithm.
 *  `complete` distinguishes a fully-resolved final pass (safe to use forever,
 *  never re-align again) from a snapshot taken mid-alignment — a large book
 *  (10+ hours, CPU-bound WhisperX — docs/M4B_FIRST_FLOW.md's known
 *  limitation) can easily outlive a single tab session, and without this
 *  in-progress checkpoint, every reload silently discarded whatever the
 *  align server had already worked through and restarted the whole pass
 *  from 0%, effectively re-timing the entire book from scratch on every
 *  visit — see loadAlignManifest's caller in Player.jsx for how a partial
 *  snapshot is used as the resumed baseline instead of the crude linear
 *  estimate, while alignment keeps refining in the background exactly like
 *  a first run would. */
export async function storeAlignManifest(
  bookId, algorithmId, blobSize, slidesByChapter, result, { complete = true, processedMs = null } = {},
) {
  await putSetting(manifestKey(bookId, algorithmId), {
    fingerprint: fingerprint(blobSize, slidesByChapter),
    result,
    complete,
    schemaVersion: SCHEMA_VERSION,
    // How far into the audio the align server had actually gotten as of this
    // snapshot — the ACTUAL resume offset (see Player.jsx's applyM4bTimeline).
    // Distinct from "which lines are resolved": a chunk can advance the audio
    // clock forward without resolving any NEW line (a stretch matching
    // nothing reliably, or a gap), so processedMs can legitimately sit ahead
    // of what the resolved lineTimings alone would suggest.
    processedMs,
    storedAt: Date.now(),
  });
}

/**
 * Load a previously-cached manifest, or null if none exists or the
 * fingerprint no longer matches (different m4b / different extracted lines).
 * Returns `{result, complete, processedMs}` — `complete: false` means this is
 * a mid-alignment snapshot (or a pre-SCHEMA_VERSION manifest downgraded for a
 * refresh — see SCHEMA_VERSION's comment), not a finished pass.
 */
export async function loadAlignManifest(bookId, algorithmId, blobSize, slidesByChapter) {
  const record = await getSetting(manifestKey(bookId, algorithmId));
  if (!record) return null;
  if (record.fingerprint !== fingerprint(blobSize, slidesByChapter)) return null;
  // Only `complete` gets downgraded for a pre-SCHEMA_VERSION record — it's
  // the flag that decides "trust this forever" vs "use as a baseline, keep
  // refining." `processedMs` (how far into the AUDIO transcription already
  // got) is unaffected by the schema bump and must stay real: forcing it to 0
  // would resume re-transcribing from the top of the file while
  // `alreadyResolved` still skips already-resolved LINES, matching stale
  // early audio against a later, un-skipped stretch of text — exactly the
  // audio/text misalignment applyM4bTimeline's own resume comment warns
  // against, and a real risk of reintroducing a false anchor, not preventing
  // one.
  const schemaCurrent = record.schemaVersion === SCHEMA_VERSION;
  return {
    result: record.result,
    complete: schemaCurrent && record.complete !== false,
    processedMs: record.processedMs || 0,
  };
}

/** Remove a book's cached manifest for an algorithm (e.g. on m4b removal, or a forced re-align). */
export async function removeAlignManifest(bookId, algorithmId) {
  await deleteSetting(manifestKey(bookId, algorithmId));
}
