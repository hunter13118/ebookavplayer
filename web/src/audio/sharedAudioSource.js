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

function ensureAudioEl() {
  if (!audioEl) {
    audioEl = new Audio();
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
  if (audioEl) audioEl.src = "";
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
