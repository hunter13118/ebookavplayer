// Edge neural TTS playback — ~160-char clips with prefetch-while-playing.
// Falls back to offline pack audio when an audiobook-tier pack is active.
import { apiUrl } from "../api.js";
import { lineWithVoice } from "./voiceOverrides.js";
import { lineGapMs, estimateDurationSec } from "./timing.js";
import { getOfflineAudioBlob } from "../offline/packBridge.js";
import {
  buildSpeechUnits, unitToLine, lineUsesOfflineWholeLine, TTS_CHUNK_MAX_CHARS,
} from "./ttsChunks.js";

let edgeAudio = null;
let edgeObjectUrl = null;
let seqToken = 0;

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

async function fetchTtsBlob(line, voiceOverrides) {
  const resolved = lineWithVoice(line, voiceOverrides);
  const text = (resolved.text || "").trim();
  if (!text) return null;
  const offline = await getOfflineAudioBlob(resolved);
  if (offline) return offline;
  const res = await fetch(apiUrl("/tts"), {
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
  if (!res.ok || res.status === 204) return null;
  const blob = await res.blob();
  return blob?.size ? blob : null;
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

async function playPrepared(line, rate, { onStart, onEnd, voiceOverrides, preparedBlob } = {}) {
  const text = (lineWithVoice(line, voiceOverrides).text || "").trim();
  if (!text) { onEnd?.(); return false; }
  try {
    const blob = preparedBlob || await fetchTtsBlob(line, voiceOverrides);
    if (!blob) { onEnd?.(); return false; }
    return playBlob(blob, rate, { onStart, onEnd });
  } catch {
    stopEdgeAudio();
    onEnd?.();
    return false;
  }
}

/** Speak one line — sentence-chunked online; whole-line blob offline. */
export async function speakLine(line, { rate, onStart, onEnd, voiceOverrides, onPartStart } = {}) {
  stopEdgeSpeech();
  const myToken = seqToken;
  const lineRate = rate ?? 1;

  if (lineUsesOfflineWholeLine(line)) {
    return playPrepared(line, lineRate, {
      voiceOverrides,
      onStart: (dur) => onStart?.(dur),
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
      onEnd,
    });
  }

  let prefetch = fetchTtsBlob(unitToLine(units[0]), voiceOverrides);
  for (let u = 0; u < units.length; u += 1) {
    if (seqToken !== myToken) return false;
    const unit = units[u];
    const blobPromise = prefetch;
    prefetch = u + 1 < units.length
      ? fetchTtsBlob(unitToLine(units[u + 1]), voiceOverrides)
      : null;
    // eslint-disable-next-line no-await-in-loop
    const prepared = await blobPromise.catch(() => null);
    // eslint-disable-next-line no-await-in-loop
    const ok = await playPrepared(unitToLine(unit), lineRate, {
      preparedBlob: prepared,
      voiceOverrides,
      onStart: (dur) => onPartStart?.(unit, dur),
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
 */
export async function speakLinesViaEdge(lines, {
  rate, getRate, startIndex = 0, onLine, onLinePart, onAdvance, onEnd, voiceOverrides,
} = {}) {
  const list = lines || [];
  if (!list.length) { onEnd?.(); return false; }
  const resolveRate = () => (typeof getRate === "function" ? getRate() : rate) ?? 1;
  stopEdgeSpeech();
  const myToken = seqToken;
  let playedAny = false;

  const units = await buildPlaybackUnits(list, startIndex, voiceOverrides);

  if (!units.length) { onEnd?.(); return false; }

  let prefetch = fetchTtsBlob(
    units[0].offlineWhole ? units[0].line : unitToLine(units[0]),
    voiceOverrides,
  );

  for (let u = 0; u < units.length; u += 1) {
    if (seqToken !== myToken) return playedAny;
    const unit = units[u];
    const lineRate = resolveRate();
    const speakLineObj = unit.offlineWhole ? unit.line : unitToLine(unit);
    const blobPromise = prefetch;
    const next = units[u + 1];
    prefetch = next
      ? fetchTtsBlob(next.offlineWhole ? next.line : unitToLine(next), voiceOverrides)
      : null;

    // eslint-disable-next-line no-await-in-loop
    const preparedBlob = await blobPromise.catch(() => null);

    const isLineStart = unit.partIndex === 0;
    const isLineEnd = unit.partIndex === unit.partTotal - 1;
    const lineIdx = unit.lineIndex;

    // eslint-disable-next-line no-await-in-loop
    const ok = await new Promise((resolve) => {
      playPrepared(speakLineObj, lineRate, {
        preparedBlob,
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
        onEnd: () => resolve(true),
      }).then((started) => { if (!started) resolve(false); });
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
    } else {
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
