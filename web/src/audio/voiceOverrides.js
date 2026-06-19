/** Per-book voice overrides (narrator + characters). */

export const VOICE_SOURCES = {
  default: "default",   // compiled / uploaded clip (future)
  edge: "edge",
  uploaded: "uploaded",
};

/** Apply server-stored overrides before /tts. */
export function lineWithVoice(line, overrides) {
  if (!line || !overrides) return line;
  const cid = line.character_id || "narrator";
  const ov = cid === "narrator"
    ? overrides.narrator
    : overrides.characters?.[cid];
  if (!ov || ov.source === VOICE_SOURCES.default || ov.source === VOICE_SOURCES.uploaded) {
    return line;
  }
  if (ov.source === VOICE_SOURCES.edge && ov.voice) {
    return { ...line, voice: ov.voice };
  }
  return line;
}

export function voiceSelectValue(ov, compiledVoice) {
  if (!ov || ov.source === VOICE_SOURCES.default) return `default:${compiledVoice || ""}`;
  if (ov.source === VOICE_SOURCES.uploaded) return "uploaded";
  if (ov.source === VOICE_SOURCES.edge && ov.voice) return `edge:${ov.voice}`;
  return `default:${compiledVoice || ""}`;
}

export function parseVoiceSelect(value) {
  if (!value || value === "uploaded") return { source: VOICE_SOURCES.uploaded, voice: "" };
  if (value.startsWith("edge:")) {
    return { source: VOICE_SOURCES.edge, voice: value.slice(5) };
  }
  return { source: VOICE_SOURCES.default, voice: "" };
}
