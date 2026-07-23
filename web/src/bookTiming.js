import { estimateDurationSec } from "./audio/timing.js";

/** Gap between auto-advanced lines (ms) — tighter at higher speeds. */
export function lineGapMs(speed = 1) {
  return Math.max(8, Math.round(40 / (speed || 1)));
}

export function bookDurationSec(lines, speed = 1) {
  return (lines || []).reduce(
    (sum, ln) => sum + estimateDurationSec(ln?.text || "", speed),
    0,
  );
}

export function elapsedSec(lines, index, revealed, speed = 1) {
  let t = 0;
  for (let i = 0; i < index; i += 1) {
    t += estimateDurationSec(lines[i]?.text || "", speed);
  }
  const cur = lines[index];
  if (cur?.text) {
    const dur = estimateDurationSec(cur.text, speed);
    const ratio = cur.text.length ? (revealed || 0) / cur.text.length : 0;
    t += dur * Math.min(1, ratio);
  }
  return t;
}

/** `M:SS` under an hour; `H:MM:SS` at/past an hour — audiobooks run long
 *  enough that a bare minute count (e.g. "312:45") stops being readable. */
export function formatClock(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}
