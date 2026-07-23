// Plays ONE shared local audiobook file (e.g. a .m4b the user attached)
// through a single <audio> element, continuously — the orchestrator
// (_playMediaElementClock) polls getSharedAudioCurrentTimeMs() itself via a
// single rAF loop to detect line/gap boundaries and drive typewriter reveal,
// rather than this module chopping playback into discrete per-line
// seek-and-stop segments. This is the playback-consumption side of the
// four-tier timing engine (../timing/) — it consumes a TimingResult's
// lineTimings, it does not compute one.
//
// Mirrors playSpeech.js's existing edgeAudio conventions: ONE reused <audio>
// element, property-style event handlers (onended/onerror), not
// addEventListener — this keeps it consistent with the rest of the audio
// layer and with the FakeAudio test double in tests/setup.js.
//
// An earlier version of this module played per-line [startMs,endMs) segments
// via a hard seek + a setTimeout sized to the segment's own duration. That
// setTimeout was wall-clock only, with no awareness of buffering stalls, so
// any time spent buffering after a seek (common for a local .m4b whose moov
// atom isn't at the front — see moovAtomScanner.js) silently ate into the
// segment's allotted time, cutting playback off early. Continuous playback
// has no such timer — a stall just delays when the rAF loop crosses a
// boundary, never truncates audio — so every local-M4B session now uses it.

let audioEl = null;
let objectUrl = null;
let loadedBlob = null;
let activeToken = 0; // invalidates a stale onEnded/onError after stop()/load()/a newer play call

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
    // any time, not just around a specific playSharedContinuous call.
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
 * Play the loaded shared audio CONTINUOUSLY from fromMs onward. The caller
 * (orchestrator._playMediaElementClock) polls getSharedAudioCurrentTimeMs()
 * itself via a single rAF loop to detect line/gap boundaries and drive
 * typewriter reveal, rather than us chopping playback into discrete per-line
 * segments.
 *
 * onEnded fires once, only on real end-of-file or a genuine element error —
 * a later call to this function or to stopSharedAudio() supersedes/cancels
 * this one silently.
 */
export async function playSharedContinuous(fromMs, rate, { onEnded, onError } = {}) {
  if (!loadedBlob) { onError?.(new Error("playSharedContinuous: no shared audio loaded")); return; }
  const el = ensureAudioEl();
  const myToken = ++activeToken;

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

/** Stop any in-flight continuous playback (does not unload the blob). */
export function stopSharedAudio() {
  if (audioEl) {
    audioEl.onended = null;
    audioEl.onerror = null;
    try { audioEl.pause(); } catch { /* element may not support pause in this state */ }
  }
  activeToken += 1; // invalidate any in-flight playSharedContinuous() callback
}
