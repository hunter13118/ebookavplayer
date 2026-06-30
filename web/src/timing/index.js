// Public surface of the four-tier audiobook→script timing engine.
// See ./ARCHITECTURE.md for the trade-off analysis and data flow.

export { distributeProportional, spanSlides } from "./distribute.js";
export { buildSlidesByChapter, countSlides, buildResult, resolveChapterSpans } from "./slides.js";

export { linearSplit, LINEAR_MARKER } from "./linearSplit.js";
export {
  punctuationDensity, punctuationWeight, DEFAULT_PUNCTUATION_WEIGHTS, PUNCTUATION_MARKER,
} from "./punctuationDensity.js";
export {
  scan as scanContainer, moovAtomTiming, findMoov, walkTopLevel, tailScanForMoov, readAtomHeader, MOOV_MARKER,
} from "./moovAtomScanner.js";
export {
  forcedAlignerClient, manifestToTimingResult, ALIGNER_MARKER,
} from "./forcedAlignerClient.js";

export {
  ALGORITHMS, DEFAULT_ALGORITHM, getAlgorithm, describeAlgorithms, isKnownAlgorithm, computeTimeline,
} from "./registry.js";

export {
  computeTimelineFromM4b, resolveChapterDurationsFromContainer,
} from "./fromContainer.js";
