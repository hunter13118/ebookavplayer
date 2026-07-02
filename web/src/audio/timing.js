// Pure timing helpers — no DOM, no audio. Unit-tested in tests/.

/** Estimate spoken duration (sec) from text when audio metadata is absent
 *  (no backend / TTS unavailable). ~165 wpm baseline, scaled by speed. */
export function estimateDurationSec(text, speed = 1) {
  const words = (text || "").trim().split(/\s+/).filter(Boolean).length;
  const base = Math.max(0.6, (words / 165) * 60);
  return base / (speed || 1);
}

/** How many characters of `text` should be revealed at elapsed/total ratio. */
export function revealedCount(text, elapsedSec, totalSec) {
  const n = (text || "").length;
  if (n === 0 || totalSec <= 0) return n;
  const ratio = Math.min(1, elapsedSec / totalSec);
  return Math.min(n, Math.ceil(ratio * n));
}

/** Prefer measured audio duration; fall back when metadata is missing/implausible. */
export function effectiveLineDuration(text, measuredSec, speed = 1) {
  const est = estimateDurationSec(text, speed);
  if (!measuredSec || !Number.isFinite(measuredSec) || measuredSec < est * 0.55) {
    return est;
  }
  return measuredSec;
}

/** Brief pause between auto-advanced lines (ms) — tighter at higher speeds. */
export function lineGapMs(speed = 1) {
  return Math.max(8, Math.round(40 / (speed || 1)));
}

/**
 * Real-time sleep timer countdown — pauses playback after `minutes` of wall
 * clock time regardless of how much has been read/listened to. Returns null
 * when the timer is off (falsy minutes) or hasn't been started (no
 * startedAt), otherwise the remaining ms, clamped to >= 0.
 */
export function sleepTimerRemainingMs(startedAt, minutes, now) {
  if (!minutes || minutes <= 0 || !startedAt) return null;
  const totalMs = minutes * 60_000;
  return Math.max(0, totalMs - (now - startedAt));
}

/** Stable horizontal slot (%) for character index in a scene of `total` sprites. */
export function slotXForIndex(index, total) {
  const presets = {
    1: [50],
    2: [32, 68],
    3: [22, 50, 78],
  };
  if (presets[total]) return presets[total][index];
  const margin = 15;
  const span = 70;
  return margin + (span * index) / Math.max(1, total - 1);
}

/** Pick which present characters to show + who is spotlighted.
 *  Slots are stable (sorted by character_id); spotlight/dim never reorder DOM. */
export function stageLayout(present, speakerId, maxFocused = 2) {
  const list = [...(present || [])].sort((a, b) =>
    String(a.character_id).localeCompare(String(b.character_id)),
  );
  const total = list.length;
  const withSlot = (p, i, spotlight, dim) => ({
    ...p,
    spotlight,
    dim,
    slotX: slotXForIndex(i, total),
  });

  if (total <= maxFocused) {
    return list.map((p, i) =>
      withSlot(p, i, p.character_id === speakerId, false),
    );
  }

  const speaking = list.filter((p) => p.character_id === speakerId);
  const others = list.filter((p) => p.character_id !== speakerId);
  const kept = others.slice(0, Math.max(0, maxFocused - speaking.length));
  const dimIds = new Set(
    others.slice(Math.max(0, maxFocused - speaking.length)).map((p) => p.character_id),
  );

  return list.map((p, i) =>
    withSlot(
      p,
      i,
      p.character_id === speakerId,
      dimIds.has(p.character_id),
    ),
  );
}
