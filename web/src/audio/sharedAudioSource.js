// Plays per-line segments out of ONE shared local audiobook file (e.g. a
// .m4b the user attached) by seeking a single <audio> element to a
// precomputed [startMs, endMs) window per line, instead of synthesizing or
// fetching audio per line. This is the playback-consumption side of the
// four-tier timing engine (../timing/) — it consumes a TimingResult's
// lineTimings, it does not compute one.
//
// Mirrors playSpeech.js's existing edgeAudio conventions: ONE reused <audio>
// element, property-style event handlers (onended/onerror), not
// addEventListener — this keeps it consistent with the rest of the audio
// layer and with the FakeAudio test double in tests/setup.js.
//
// Boundary detection: the underlying media's natural `onended` only fires at
// EOF, not at an arbitrary mid-file line boundary. So the primary stop
// mechanism is a setTimeout sized to the segment's own duration — the same
// pattern orchestrator.js's _playSilent already uses for estimated/simulated
// duration. The real `onended`/`onerror` are wired too, as a safety net for
// the last line in the book or a genuinely broken file.

let audioEl = null;
let objectUrl = null;
let loadedBlob = null;
let boundaryTimer = null;
let activeToken = 0; // invalidates a stale timer/handler after stop()/load()
let activeSegment = null; // { token, settleAsEnded() } for the in-flight playSharedSegment() call, if any

// True whenever the element is stalled waiting for more data (a real,
// sometimes multi-second-or-longer delay for a large m4b whose moov atom
// isn't at the front — see moovAtomScanner.js's comments on this same
// container quirk). Without surfacing this, a fresh seek into unbuffered
// territory looks identical on screen to a genuine freeze: same text, same
// clock, same "playing" status — nothing distinguishes "loading" from
// "stuck", including to a user tempted to re-press Play (which actually
// hits Pause once it secretly *has* started, silently reversing it).
let isBuffering = false;
const bufferingListeners = new Set();

function setBuffering(next) {
  if (isBuffering === next) return;
  isBuffering = next;
  bufferingListeners.forEach((fn) => fn(next));
}

export function isSharedAudioBuffering() {
  return isBuffering;
}

/** Subscribe to buffering state changes; returns an unsubscribe function. */
export function onSharedAudioBufferingChange(fn) {
  bufferingListeners.add(fn);
  return () => bufferingListeners.delete(fn);
}

function ensureAudioEl() {
  if (!audioEl) {
    audioEl = new Audio();
    // Persistent for the element's lifetime (unlike onended/onerror below,
    // which get swapped per in-flight call) — buffering can start/stop at
    // any time, not just around a specific playSharedSegment/Continuous call.
    audioEl.onwaiting = () => setBuffering(true);
    audioEl.onplaying = () => setBuffering(false);
  }
  return audioEl;
}

/** Load (or replace) the shared audiobook Blob. Revokes any previous object URL. */
export function loadSharedAudio(blob) {
  const el = ensureAudioEl();
  stopSharedAudio();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(blob);
  loadedBlob = blob;
  el.src = objectUrl;
}

/** Release the loaded blob/object URL and detach the element. */
export function unloadSharedAudio() {
  stopSharedAudio();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  loadedBlob = null;
  if (audioEl) {
    audioEl.src = "";
    audioEl.currentTime = 0;
  }
}

export function isSharedAudioLoaded() {
  return loadedBlob != null;
}

/**
 * Play [startMs, endMs) of the loaded shared audio at `rate`.
 * Calls onStart(durSec) once playback begins (durSec already divided by
 * rate, matching the contract orchestrator._runTypewriter expects), then
 * onEnd() exactly once when the segment boundary is reached — whichever
 * fires first: our duration timer, the element's own onended/onerror, or an
 * explicit stopSharedAudio() call (which the orchestrator's pause()/stop()/
 * seek() always reach — its caller awaits this segment ending one way or
 * another, so a stop MUST still resolve it, just like the silent-playback
 * path's plain setTimeout always fires regardless of pause).
 *
 * A newer playSharedSegment() call silently supersedes an older one that's
 * still pending (no callback fires for the superseded call) — the
 * orchestrator never overlaps two calls itself, so this only matters as a
 * defensive guarantee, not a behavior real playback relies on.
 */
export async function playSharedSegment(startMs, endMs, rate, { onStart, onEnd, onError } = {}) {
  if (!loadedBlob) { onError?.(new Error("playSharedSegment: no shared audio loaded")); return; }
  const el = ensureAudioEl();
  const myToken = ++activeToken; // implicitly supersedes any still-pending prior segment
  clearBoundaryTimer();

  const effectiveRate = rate || 1;
  const startSec = Math.max(0, startMs / 1000);
  const endSec = Math.max(startSec, endMs / 1000);
  const durSec = Math.max(0, (endSec - startSec) / effectiveRate);

  let settled = false;
  const finish = (cb, ...args) => {
    if (myToken !== activeToken || settled) return;
    settled = true;
    clearBoundaryTimer();
    el.onended = null;
    el.onerror = null;
    if (activeSegment && activeSegment.token === myToken) activeSegment = null;
    cb?.(...args);
  };

  el.onended = () => { el.pause(); finish(onEnd); };
  el.onerror = () => { el.pause(); finish(onError, new Error("shared audio playback error")); };

  try {
    el.playbackRate = effectiveRate;
    el.currentTime = startSec;
    await el.play();
  } catch (e) {
    finish(onError, e);
    return;
  }
  if (myToken !== activeToken) return; // a newer call superseded us mid-await

  activeSegment = { token: myToken, settleAsEnded: () => finish(onEnd) };
  onStart?.(durSec);
  boundaryTimer = setTimeout(() => { el.pause(); finish(onEnd); }, durSec * 1000);
}

function clearBoundaryTimer() {
  if (boundaryTimer != null) clearTimeout(boundaryTimer);
  boundaryTimer = null;
}

/**
 * Play the loaded shared audio CONTINUOUSLY from fromMs onward — no
 * boundary-kill setTimeout, unlike playSharedSegment(). This is Mode B
 * (acoustic-timeline) playback: the caller (orchestrator._playMediaElementClock)
 * polls getSharedAudioCurrentTimeMs() itself via a single rAF loop to detect
 * line boundaries and drive typewriter reveal, rather than us chopping
 * playback into discrete per-line segments.
 *
 * onEnded fires once, only on real end-of-file or a genuine element error —
 * a later call to this function or to stopSharedAudio() supersedes/cancels
 * this one silently (same superseding convention as playSharedSegment).
 */
export async function playSharedContinuous(fromMs, rate, { onEnded, onError } = {}) {
  if (!loadedBlob) { onError?.(new Error("playSharedContinuous: no shared audio loaded")); return; }
  const el = ensureAudioEl();
  const myToken = ++activeToken;
  clearBoundaryTimer();
  activeSegment = null;

  el.onended = () => { if (myToken === activeToken) onEnded?.(); };
  el.onerror = () => { if (myToken === activeToken) onError?.(new Error("shared audio playback error")); };

  try {
    el.playbackRate = rate || 1;
    el.currentTime = Math.max(0, fromMs / 1000);
    await el.play();
  } catch (e) {
    if (myToken === activeToken) onError?.(e);
  }
}

/** Read the shared audio element's current playhead position, in ms. */
export function getSharedAudioCurrentTimeMs() {
  return audioEl ? (audioEl.currentTime || 0) * 1000 : 0;
}

/** Read the shared audio element's total duration, in ms (0 before metadata loads). */
export function getSharedAudioDurationMs() {
  return audioEl && Number.isFinite(audioEl.duration) ? audioEl.duration * 1000 : 0;
}

/** Seek the shared audio element without starting or stopping playback. */
export function seekSharedAudioMs(ms) {
  if (audioEl) audioEl.currentTime = Math.max(0, ms / 1000);
}

/** Update playbackRate on the live element without seeking or restarting. */
export function setSharedAudioPlaybackRate(rate) {
  if (audioEl) audioEl.playbackRate = rate || 1;
}

/**
 * Stop any in-flight segment playback (does not unload the blob). If a
 * segment is currently in flight, its onEnd is settled (as if the segment
 * just ended) BEFORE the token is invalidated — so a caller awaiting
 * playSharedSegment's completion (the orchestrator's playback loop) is
 * always unblocked by an explicit stop, never left hanging.
 */
export function stopSharedAudio() {
  const seg = activeSegment;
  activeSegment = null;
  clearBoundaryTimer();
  if (audioEl) {
    audioEl.onended = null;
    audioEl.onerror = null;
    try { audioEl.pause(); } catch { /* element may not support pause in this state */ }
  }
  if (seg) seg.settleAsEnded();
  activeToken += 1; // now invalidate, so no stray async work can resurrect the stopped segment
}
