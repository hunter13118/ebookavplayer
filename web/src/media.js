// Resolve media tokens to CSS. Generated media are real URLs (/media/...);
// placeholders are deterministic css-gradient tokens emitted by the backend
// compiler so the experience renders before image-gen runs.
import { apiBase } from "./api.js";

/** Resolve a /media/... path or absolute URL for <img> / CSS. */
export function mediaUrl(token) {
  if (!token) return "";
  if (token.startsWith("http://") || token.startsWith("https://")) return token;
  if (token.startsWith("/")) {
    const base = apiBase();
    return base ? `${base}${token}` : token;
  }
  return token;
}

export function backgroundStyle(token) {
  if (!token) return { background: "#1a1d29" };
  if (token.startsWith("gradient:")) {
    const [a, b] = token.slice(9).split(",").map(Number);
    return { background: `linear-gradient(160deg, hsl(${a} 45% 28%), hsl(${b} 50% 16%))` };
  }
  const url = mediaUrl(token);
  return { backgroundImage: `url("${url}")`, backgroundSize: "cover", backgroundPosition: "center" };
}

/** Returns {type:'gradient', css} | {type:'image', url} | {type:'icon'} */
export function spriteVisual(token) {
  if (!token) return { type: "icon" };
  if (token === "sprite:narrator") return { type: "icon" };
  if (token.startsWith("sprite:gradient:")) {
    const [a, b] = token.slice(16).split(",").map(Number);
    return { type: "gradient", css: `linear-gradient(180deg, hsl(${a} 60% 60%), hsl(${b} 55% 40%))` };
  }
  if (token.startsWith("sprite:")) token = token.slice(7);
  return { type: "image", url: mediaUrl(token) };
}

/** Deterministic gradient from a seed (matches broken-image / missing-file fallback). */
export function gradientFromSeed(seed) {
  let h = 0;
  const s = String(seed || "?");
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const a = (h % 360);
  const b = (a + 40 + (h % 120)) % 360;
  return { type: "gradient", css: `linear-gradient(180deg, hsl(${a} 60% 60%), hsl(${b} 55% 40%))` };
}
