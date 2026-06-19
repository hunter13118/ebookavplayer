// Edge neural TTS playback — copied to a tee from the Gyōkan parallel-reader's
// playSpeech.js (seqToken cancellation + per-call POST /tts). The ONLY change:
// the parallel-reader routed voices by language; here every LINE already
// carries its own character voice/pitch/rate, so we route by character and
// never by screen position.
import { apiUrl } from "../api.js";
import { lineWithVoice } from "./voiceOverrides.js";

let edgeAudio = null;
let edgeObjectUrl = null;
let seqToken = 0;            // bumps on every stop; a running sequence aborts when stale

function stopEdgeAudio() {
  if (edgeAudio) { edgeAudio.pause(); edgeAudio = null; }
  if (edgeObjectUrl) { URL.revokeObjectURL(edgeObjectUrl); edgeObjectUrl = null; }
}

/** Public stop: cancels any in-flight sequence AND current audio. */
export function stopEdgeSpeech() { seqToken += 1; stopEdgeAudio(); }

export function setEdgePlaybackRate(rate) { if (edgeAudio) edgeAudio.playbackRate = rate; }

function fetchTimeout(ms) {
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) return AbortSignal.timeout(ms);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

/**
 * Fetch one /tts clip for a line and play to completion.
 * onStart(durationSec) fires when audio begins (orchestrator starts the
 * typewriter against the real clip duration — keeps text/audio in sync).
 * Resolves true once it has played.
 */
async function edgeFetchPlay(line, rate, { onStart, onEnd, voiceOverrides } = {}) {
  const resolved = lineWithVoice(line, voiceOverrides);
  const text = (resolved.text || "").trim();
  if (!text) { onEnd?.(); return false; }
  stopEdgeAudio();
  try {
    const res = await fetch(apiUrl("/tts"), {
      method: "POST",
      headers: { "content-type": "application/json" },
        body: JSON.stringify({
        text,
        voice: resolved.voice,
        pitch: resolved.pitch || undefined,
        rate: resolved.rate || undefined,
        character: line.character_id || undefined,
        expression: line.expression || undefined,
        environment: line.environment || undefined,
        intensity: line.intensity != null ? line.intensity : undefined,
      }),
      signal: fetchTimeout(20000),
    });
    if (!res.ok || res.status === 204) { onEnd?.(); return false; }
    const blob = await res.blob();
    if (!blob.size) { onEnd?.(); return false; }
    edgeObjectUrl = URL.createObjectURL(blob);
    edgeAudio = new Audio(edgeObjectUrl);
    edgeAudio.playbackRate = rate ?? 1;
    edgeAudio.onloadedmetadata = () => {
      const dur = Number.isFinite(edgeAudio.duration) ? edgeAudio.duration : 0;
      onStart?.(dur / (edgeAudio.playbackRate || 1));
    };
    edgeAudio.onended = () => { stopEdgeAudio(); onEnd?.(); };
    edgeAudio.onerror = () => { stopEdgeAudio(); onEnd?.(); };
    await edgeAudio.play();
    return true;
  } catch {
    stopEdgeAudio();
    onEnd?.();
    return false;
  }
}

/**
 * Speak a single line. Voice comes from the line itself.
 * @returns {Promise<boolean>}
 */
export async function speakLine(line, { rate, onStart, onEnd, voiceOverrides } = {}) {
  stopEdgeSpeech();
  return edgeFetchPlay(line, rate, { onStart, onEnd, voiceOverrides });
}

/**
 * Speak a list of lines sequentially — one /tts call per line (SPEC: TTS is
 * always per-line). Stoppable: the loop aborts when its token goes stale.
 * Hooks let the orchestrator drive sprites + typewriter per line.
 *   onLine(i, line, durationSec) — fires as each line's audio starts
 *   onAdvance(i)                 — fires after each line ends
 * @returns {Promise<boolean>} true if at least one line played
 */
export async function speakLinesViaEdge(lines, {
  rate, startIndex = 0, onLine, onAdvance, onEnd, voiceOverrides,
} = {}) {
  const list = (lines || []).filter((l) => (l.text || "").trim());
  if (!list.length) { onEnd?.(); return false; }
  stopEdgeSpeech();                 // cancel anything prior + bump token
  const myToken = seqToken;         // claim this generation
  let playedAny = false;
  for (let i = startIndex; i < list.length; i += 1) {
    if (seqToken !== myToken) return playedAny;          // stopped/superseded
    const line = list[i];
    // eslint-disable-next-line no-await-in-loop
    const ok = await new Promise((resolve) => {
      edgeFetchPlay(line, rate, {
        onStart: (dur) => onLine?.(i, line, dur),
        onEnd: () => resolve("ended"),
        voiceOverrides,
      }).then((started) => { if (!started) resolve(false); });
    });
    if (seqToken !== myToken) return playedAny;
    if (ok) { playedAny = true; onAdvance?.(i); }
    else break;                     // a failed line stops the run
  }
  if (seqToken === myToken) onEnd?.();
  return playedAny;
}

export function stopAllSpeech() { stopEdgeSpeech(); }
