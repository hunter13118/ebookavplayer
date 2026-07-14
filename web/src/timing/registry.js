// The multiple-choice configuration engine: the single registry that backs both
// the settings panel (which renders one <option> per descriptor) and runtime
// dispatch (which picks the strategy by id). Keep this the ONE source of truth so
// the UI and the engine can never drift out of sync.

import { linearSplit, LINEAR_MARKER } from "./linearSplit.js";
import { punctuationDensity, PUNCTUATION_MARKER } from "./punctuationDensity.js";
import { moovAtomTiming, MOOV_MARKER } from "./moovAtomScanner.js";
import { whisperxAlignerClient, WHISPERX_MARKER } from "./whisperxAlignerClient.js";

export const DEFAULT_ALGORITHM = "linear";

/** @type {Array<import('./types.js').AlgorithmDescriptor & { run: Function }>} */
export const ALGORITHMS = [
  {
    id: "linear",
    label: "Linear (fast)",
    marker: LINEAR_MARKER,
    tier: "client",
    blurb: "Splits each chapter by character count. Instant, no acoustics — the universal fallback.",
    run: linearSplit,
  },
  {
    id: "punctuation",
    label: "Punctuation-aware",
    marker: PUNCTUATION_MARKER,
    tier: "client",
    blurb: "Weights pauses (periods, commas, line breaks) so pacing survives accent/dialect shifts.",
    run: punctuationDensity,
  },
  {
    id: "moov-atom",
    label: "Chapter-snap (accurate)",
    marker: MOOV_MARKER,
    tier: "client",
    blurb: "Reads the .m4b's own chapter markers and snaps slide boundaries to them.",
    run: moovAtomTiming,
  },
  {
    id: "whisperx",
    label: "WhisperX forced-align (local, most accurate)",
    marker: WHISPERX_MARKER,
    tier: "local-server",
    blurb: "Transcribes what the audiobook actually says and fuzzy-matches it to your lines. Real acoustic timing, chapter-by-chapter — needs a local align server connection.",
    run: whisperxAlignerClient,
  },
];

const BY_ID = new Map(ALGORITHMS.map((a) => [a.id, a]));

/** @param {string} id */
export function getAlgorithm(id) {
  return BY_ID.get(id) || BY_ID.get(DEFAULT_ALGORITHM);
}

/** Descriptors only (no `run`) — what the settings panel maps over to render options. */
export function describeAlgorithms() {
  return ALGORITHMS.map(({ run, ...d }) => d); // eslint-disable-line no-unused-vars
}

/** True if the id maps to a known algorithm. */
export function isKnownAlgorithm(id) {
  return BY_ID.has(id);
}

/**
 * Dispatch: run the chosen algorithm with its input bundle.
 * Client algorithms return synchronously; local-server algorithms return a Promise.
 * Always await the result to normalize both.
 *
 * @param {string} id
 * @param {Object} input  The algorithm-specific input bundle.
 * @returns {Promise<import('./types.js').TimingResult>}
 */
export async function computeTimeline(id, input) {
  const algo = getAlgorithm(id);
  return algo.run(input);
}
