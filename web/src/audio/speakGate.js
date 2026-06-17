/** One playback at a time — collapse double-fire. Copied from parallel-reader. */
export const SPEAK_COOLDOWN_MS = 350;
let lastSpeakAt = 0;
export function takeSpeakGate() {
  const now = Date.now();
  if (now - lastSpeakAt < SPEAK_COOLDOWN_MS) return false;
  lastSpeakAt = now;
  return true;
}
export function resetSpeakGate() { lastSpeakAt = 0; }
