// Pure timing helpers — no DOM, no audio. Unit-tested in tests/.

/** Estimate spoken duration (sec) from text when audio metadata is absent
 *  (no backend / TTS unavailable). ~165 wpm baseline, scaled by speed. */
export function estimateDurationSec(text, speed = 1) {
  const words = (text || "").trim().split(/\s+/).filter(Boolean).length;
  const base = Math.max(0.6, (words / 165) * 60);
  return base / (speed || 1);
}

/** How many characters of `text` should be revealed at elapsed/total ratio.
 *  Reveal finishes a touch before audio ends so the last word isn't clipped. */
export function revealedCount(text, elapsedSec, totalSec) {
  const n = (text || "").length;
  if (n === 0 || totalSec <= 0) return n;
  const ratio = Math.min(1, elapsedSec / (totalSec * 0.92));
  return Math.min(n, Math.ceil(ratio * n));
}

/** Should a checkpoint fire after finishing line `idx`? (catch sleepers) */
export function isCheckpoint(idx, every) {
  if (!every || every <= 0) return false;
  return (idx + 1) % every === 0;
}

/** Pick which present characters to show + who is spotlighted.
 *  MVP rule: max 2 for 1:1; in groups, spotlight the speaker, dim the rest. */
export function stageLayout(present, speakerId, maxFocused = 2) {
  const list = present || [];
  const speaking = list.filter((p) => p.character_id === speakerId);
  const others = list.filter((p) => p.character_id !== speakerId);
  if (list.length <= maxFocused) {
    return list.map((p) => ({
      ...p, spotlight: p.character_id === speakerId, dim: false,
    }));
  }
  // group scene: speaker foreground, a couple companions kept, rest dimmed
  const kept = others.slice(0, Math.max(0, maxFocused - speaking.length));
  const kdim = others.slice(Math.max(0, maxFocused - speaking.length));
  return [
    ...speaking.map((p) => ({ ...p, spotlight: true, dim: false })),
    ...kept.map((p) => ({ ...p, spotlight: false, dim: false })),
    ...kdim.map((p) => ({ ...p, spotlight: false, dim: true })),
  ];
}
