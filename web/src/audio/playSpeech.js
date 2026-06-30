// Edge neural TTS playback — ~160-char clips with prefetch-while-playing.
// Falls back to offline pack audio when an audiobook-tier pack is active.
import { apiUrl } from "../api.js";
import { lineWithVoice } from "./voiceOverrides.js";
import { lineGapMs, estimateDurationSec, isCheckpoint } from "./timing.js";
import { getOfflineAudioBlob } from "../offline/packBridge.js";
import {
  buildSpeechUnits, unitToLine, lineUsesOfflineWholeLine, TTS_CHUNK_MAX_CHARS,
} from "./ttsChunks.js";

let edgeAudio = null;
let edgeObjectUrl = null;
let seqToken = 0;

/** A real TTS failure (non-2xx, non-204 response, or network error) — distinct
 *  from intentional silence (empty line text / 204 "no audio"). Callers must
 *  surface this to the user rather than simulating playback and advancing. */
export class TtsError extends Error {
  constructor(status, message) {
    super(message || (status ? `TTS request failed: HTTP ${status}` : "TTS request failed"));
    this.name = "TtsError";
    this.status = status || 0;
  }
}

function stopEdgeAudio() {
  if (edgeAudio) { edgeAudio.pause(); edgeAudio = null; }
  if (edgeObjectUrl) { URL.revokeObjectURL(edgeObjectUrl); edgeObjectUrl = null; }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function stopEdgeSpeech() { seqToken += 1; stopEdgeAudio(); }

export function setEdgePlaybackRate(rate) { if (edgeAudio) edgeAudio.playbackRate = rate; }

function fetchTimeout(ms) {
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) return AbortSignal.timeout(ms);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

/** Fetch TTS audio for a line. Returns null for INTENTIONAL silence (empty
 *  text, or the server's explicit 204 "no audio"). Throws TtsError for a real
 *  failure (4xx/5xx response or network error) — callers must not treat that
 *  the same as silence. */
async function fetchTtsBlob(line, voiceOverrides) {
  const resolved = lineWithVoice(line, voiceOverrides);
  const text = (resolved.text || "").trim();
  if (!text) return null;
  const offline = await getOfflineAudioBlob(resolved);
  if (offline) return offline;
  let res;
  try {
    res = await fetch(apiUrl("/tts"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        voice: resolved.voice,
        pitch: resolved.pitch || undefined,
        rate: resolved.rate || undefined,
        volume: resolved.volume || undefined,
        character: line.character_id || undefined,
        expression: line.expression || undefined,
        environment: line.environment || undefined,
        intensity: line.intensity != null ? line.intensity : undefined,
      }),
      signal: fetchTimeout(20000),
    });
  } catch (e) {
    throw new TtsError(0, e?.message);
  }
  if (res.status === 204) return null;
  if (!res.ok) throw new TtsError(res.status);
  const blob = await res.blob();
  return blob?.size ? blob : null;
}

/** Always-resolving wrapper: never rejects, so it's safe to fire-and-await
 *  later (prefetch pattern) without unhandled rejection risk. */
async function fetchTtsBlobSafe(line, voiceOverrides) {
  try {
    const blob = await fetchTtsBlob(line, voiceOverrides);
    return { blob, error: null };
  } catch (error) {
    return { blob: null, error };
  }
}

async function playBlob(blob, rate, { onStart, onEnd }) {
  stopEdgeAudio();
  edgeObjectUrl = URL.createObjectURL(blob);
  edgeAudio = new Audio(edgeObjectUrl);
  edgeAudio.playbackRate = rate ?? 1;
  return new Promise((resolve) => {
    edgeAudio.onloadedmetadata = () => {
      const dur = Number.isFinite(edgeAudio.duration) ? edgeAudio.duration : 0;
      onStart?.(dur / (edgeAudio.playbackRate || 1));
    };
    edgeAudio.onended = () => { stopEdgeAudio(); onEnd?.(); resolve(true); };
    edgeAudio.onerror = () => { stopEdgeAudio(); onEnd?.(); resolve(false); };
    edgeAudio.play().catch(() => {
      stopEdgeAudio();
      onEnd?.();
      resolve(false);
    });
  });
}

/** `prepared` is an optional pre-resolved { blob, error } (prefetch pattern).
 *  Real failures (TtsError) call onError and return false WITHOUT playing —
 *  callers must not treat that as "line finished, advance to the next one". */
async function playPrepared(line, rate, { onStart, onEnd, onError, voiceOverrides, prepared } = {}) {
  const text = (lineWithVoice(line, voiceOverrides).text || "").trim();
  if (!text) { onEnd?.(); return false; }
  const { blob, error } = prepared || await fetchTtsBlobSafe(line, voiceOverrides);
  if (error) { onError?.(error); onEnd?.(); return false; }
  if (!blob) { onEnd?.(); return false; }
  try {
    return await playBlob(blob, rate, { onStart, onEnd });
  } catch {
    stopEdgeAudio();
    onEnd?.();
    return false;
  }
}

/** Speak one line — sentence-chunked online; whole-line blob offline.
 *  `onError` fires (with a TtsError) when a real failure occurs; the caller
 *  must not treat that as a normal end-of-line. */
export async function speakLine(line, { rate, onStart, onEnd, onError, voiceOverrides, onPartStart } = {}) {
  stopEdgeSpeech();
  const myToken = seqToken;
  const lineRate = rate ?? 1;

  if (lineUsesOfflineWholeLine(line)) {
    return playPrepared(line, lineRate, {
      voiceOverrides,
      onStart: (dur) => onStart?.(dur),
      onError,
      onEnd,
    });
  }

  const units = buildSpeechUnits([line], 0);
  if (units.length <= 1 && (line.text || "").trim().length <= TTS_CHUNK_MAX_CHARS) {
    const only = units[0] || { partIndex: 0, charStart: 0, charEnd: (line.text || "").length, text: line.text };
    return playPrepared(line, lineRate, {
      voiceOverrides,
      onStart: (dur) => {
        onPartStart?.({
          ...only,
          lineIndex: 0,
          line,
          partTotal: 1,
        }, dur);
        onStart?.(dur);
      },
      onError,
      onEnd,
    });
  }

  let prefetch = fetchTtsBlobSafe(unitToLine(units[0]), voiceOverrides);
  for (let u = 0; u < units.length; u += 1) {
    if (seqToken !== myToken) return false;
    const unit = units[u];
    const preparedPromise = prefetch;
    prefetch = u + 1 < units.length
      ? fetchTtsBlobSafe(unitToLine(units[u + 1]), voiceOverrides)
      : null;
    // eslint-disable-next-line no-await-in-loop
    const prepared = await preparedPromise;
    // eslint-disable-next-line no-await-in-loop
    const ok = await playPrepared(unitToLine(unit), lineRate, {
      prepared,
      voiceOverrides,
      onStart: (dur) => onPartStart?.(unit, dur),
      onError,
      onEnd: () => {},
    });
    if (!ok) {
      onEnd?.();
      return false;
    }
  }
  onEnd?.();
  return true;
}

/**
 * Sequential playback with sentence-sized TTS and prefetch of the next clip
 * while the current one plays. Line callbacks fire once per script line.
 *
 * A real TTS failure (TtsError) STOPS auto-advance at that line — it must
 * never be treated like intentional silence (empty text / 204) and simulated
 * through. `onError` fires once with { lineIndex, line, error } and the
 * promise resolves without calling `onEnd` — the caller (orchestrator) owns
 * deciding what happens next (surface to the user, switch to manual mode).
 */
export async function speakLinesViaEdge(lines, {
  rate, getRate, startIndex = 0, checkpointEvery = 0, onLine, onLinePart, onAdvance, onEnd, onError, voiceOverrides,
} = {}) {
  const list = lines || [];
  if (!list.length) { onEnd?.(); return false; }
  const resolveRate = () => (typeof getRate === "function" ? getRate() : rate) ?? 1;
  stopEdgeSpeech();
  const myToken = seqToken;
  let playedAny = false;

  const units = await buildPlaybackUnits(list, startIndex, voiceOverrides);

  if (!units.length) { onEnd?.(); return false; }

  let prefetch = fetchTtsBlobSafe(
    units[0].offlineWhole ? units[0].line : unitToLine(units[0]),
    voiceOverrides,
  );

  for (let u = 0; u < units.length; u += 1) {
    if (seqToken !== myToken) return playedAny;
    const unit = units[u];
    const lineRate = resolveRate();
    const speakLineObj = unit.offlineWhole ? unit.line : unitToLine(unit);
    const preparedPromise = prefetch;
    const next = units[u + 1];
    const isLineEnd = unit.partIndex === unit.partTotal - 1;
    // Don't prefetch the next line if the current line (about to finish) is a checkpoint.
    // This gives the orchestrator time to halt before the next line's audio is queued.
    const isCurrentLineCheckpoint = isLineEnd && isCheckpoint(unit.lineIndex, checkpointEvery);
    const shouldPrefetchNext = !next || !isCurrentLineCheckpoint;
    prefetch = shouldPrefetchNext && next
      ? fetchTtsBlobSafe(next.offlineWhole ? next.line : unitToLine(next), voiceOverrides)
      : null;

    // eslint-disable-next-line no-await-in-loop
    const prepared = await preparedPromise;

    const isLineStart = unit.partIndex === 0;
    const lineIdx = unit.lineIndex;

    let lineError = null;
    // eslint-disable-next-line no-await-in-loop
    const ok = await playPrepared(speakLineObj, lineRate, {
      prepared,
      voiceOverrides,
      onStart: (dur) => {
        if (isLineStart) onLine?.(lineIdx, unit.line, dur);
        onLinePart?.(lineIdx, unit.line, {
          durSec: dur,
          partIndex: unit.partIndex,
          partTotal: unit.partTotal,
          charStart: unit.charStart,
          charEnd: unit.charEnd,
          text: unit.text,
        });
      },
      onError: (e) => { lineError = e; },
      onEnd: () => {},
    });

    if (seqToken !== myToken) return playedAny;

    if (ok) {
      playedAny = true;
      if (isLineEnd) {
        onAdvance?.(lineIdx);
        const nextUnit = units[u + 1];
        if (nextUnit && nextUnit.lineIndex !== lineIdx) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(lineGapMs(lineRate));
        }
      }
    } else if (lineError) {
      // Real failure — halt here. Do not advance past this line, do not call
      // onEnd (that would read as "the book finished").
      onError?.({ lineIndex: lineIdx, line: unit.line, error: lineError });
      return playedAny;
    } else {
      // Intentional silence (empty text / 204 / offline blob missing) — simulate
      // the typewriter off an estimated duration and advance as before.
      const est = estimateDurationSec(unit.text, lineRate);
      if (isLineStart) onLine?.(lineIdx, unit.line, est);
      onLinePart?.(lineIdx, unit.line, {
        durSec: est,
        partIndex: unit.partIndex,
        partTotal: unit.partTotal,
        charStart: unit.charStart,
        charEnd: unit.charEnd,
        text: unit.text,
      });
      playedAny = true;
      if (isLineEnd) {
        onAdvance?.(lineIdx);
        const nextUnit = units[u + 1];
        if (nextUnit && nextUnit.lineIndex !== lineIdx) {
          // eslint-disable-next-line no-await-in-loop
          await sleep((est + 0.04) * 1000);
        } else {
          // eslint-disable-next-line no-await-in-loop
          await sleep((est + 0.04) * 1000);
        }
      } else {
        // eslint-disable-next-line no-await-in-loop
        await sleep((est + 0.04) * 1000);
      }
    }
  }

  if (seqToken === myToken) onEnd?.();
  return playedAny;
}

async function buildPlaybackUnits(list, startIndex, voiceOverrides) {
  const units = [];
  for (let i = startIndex; i < list.length; i += 1) {
    const line = list[i];
    const full = (line?.text || "").trim();
    if (!full) continue;
    if (lineUsesOfflineWholeLine(line)) {
      const offline = await getOfflineAudioBlob(lineWithVoice(line, voiceOverrides));
      if (offline) {
        units.push({
          lineIndex: i,
          line,
          text: full,
          partIndex: 0,
          partTotal: 1,
          charStart: 0,
          charEnd: full.length,
          offlineWhole: true,
        });
        continue;
      }
    }
    units.push(...buildSpeechUnits(list, i).filter((u) => u.lineIndex === i));
  }
  return units;
}

export const speakSentencesViaEdge = speakLinesViaEdge;

export function stopAllSpeech() { stopEdgeSpeech(); }
