/** Labels + resolution for Edge voice UI. */

export function voiceShortName(voiceId) {
  if (!voiceId) return "—";
  const tail = voiceId.split("-").pop() || voiceId;
  return tail
    .replace(/MultilingualNeural$/i, "")
    .replace(/Neural$/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2");
}

export function voiceFriendlyLabel(voices, voiceId) {
  if (!voiceId) return "—";
  const row = (voices || []).find((v) => (v.id || v.ShortName) === voiceId);
  if (row?.label) return row.label;
  return voiceShortName(voiceId);
}

/** Voice id actually used at playback (override edge → else book default). */
export function resolveActiveVoiceId(override, compiledVoice) {
  if (override?.source === "edge" && override.voice) return override.voice;
  return compiledVoice || "";
}

export function voiceIdFromSelect(selectValue, compiledVoice) {
  if (!selectValue || selectValue === "uploaded") return compiledVoice || "";
  if (selectValue.startsWith("edge:")) return selectValue.slice(5);
  return compiledVoice || "";
}
