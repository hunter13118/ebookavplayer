/** Per-book voice overrides (narrator + characters). */

export const VOICE_SOURCES = {
  default: "default",
  edge: "edge",
  uploaded: "uploaded",
};

const DEFAULT_PITCH = "+0Hz";
const DEFAULT_RATE = "+0%";
const DEFAULT_VOLUME = "+0%";

/** Effective Edge settings for preview / playback. */
export function resolveVoiceSettings(override, compiled = {}) {
  const useEdgeVoice = override?.source === VOICE_SOURCES.edge && override.voice;
  return {
    voice: useEdgeVoice ? override.voice : (compiled.voice || ""),
    pitch: override?.pitch ?? compiled.pitch ?? DEFAULT_PITCH,
    rate: override?.rate ?? compiled.rate ?? DEFAULT_RATE,
    volume: override?.volume ?? compiled.volume ?? DEFAULT_VOLUME,
  };
}

/** Apply server-stored overrides before /tts. */
export function lineWithVoice(line, overrides) {
  if (!line || !overrides) return line;
  const cid = line.character_id || "narrator";
  const ov = cid === "narrator"
    ? overrides.narrator
    : overrides.characters?.[cid];
  if (!ov) return line;

  const out = { ...line };
  if (ov.source === VOICE_SOURCES.edge && ov.voice) {
    out.voice = ov.voice;
  }
  if (ov.pitch) out.pitch = ov.pitch;
  if (ov.rate) out.rate = ov.rate;
  if (ov.volume) out.volume = ov.volume;
  return out;
}

export function voiceSelectValue(ov, compiledVoice) {
  if (!ov || ov.source === VOICE_SOURCES.default) return `default:${compiledVoice || ""}`;
  if (ov.source === VOICE_SOURCES.uploaded) return "uploaded";
  if (ov.source === VOICE_SOURCES.edge && ov.voice) return `edge:${ov.voice}`;
  return `default:${compiledVoice || ""}`;
}

export function parseVoiceSelect(value, prev = {}) {
  const keep = {
    pitch: prev.pitch,
    rate: prev.rate,
    volume: prev.volume,
  };
  if (!value || value === "uploaded") {
    return { source: VOICE_SOURCES.uploaded, voice: "", ...keep };
  }
  if (value.startsWith("edge:")) {
    return { source: VOICE_SOURCES.edge, voice: value.slice(5), ...keep };
  }
  return { source: VOICE_SOURCES.default, voice: "", ...keep };
}

export function mergeVoiceOverride(prev, patch) {
  return { ...(prev || {}), ...patch };
}
