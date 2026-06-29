/** Edge TTS prosody strings ↔ slider numbers. */

const HZ_DEFAULT = 0;
const PCT_DEFAULT = 0;

export function parseHz(s) {
  if (!s) return HZ_DEFAULT;
  const m = String(s).match(/^([+-]?\d+)\s*Hz$/i);
  return m ? parseInt(m[1], 10) : HZ_DEFAULT;
}

export function formatHz(n) {
  const v = Math.round(Number(n) || 0);
  return `${v >= 0 ? "+" : ""}${v}Hz`;
}

export function parsePct(s) {
  if (!s) return PCT_DEFAULT;
  const m = String(s).match(/^([+-]?\d+)\s*%$/);
  return m ? parseInt(m[1], 10) : PCT_DEFAULT;
}

export function formatPct(n) {
  const v = Math.round(Number(n) || 0);
  return `${v >= 0 ? "+" : ""}${v}%`;
}

export function prosodySummary({ pitch, rate, volume } = {}) {
  const parts = [];
  if (pitch && pitch !== "+0Hz") parts.push(pitch);
  if (rate && rate !== "+0%") parts.push(rate);
  if (volume && volume !== "+0%") parts.push(`vol ${volume}`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}
