/** Playback preferences (localStorage). */
export const KEYS = {
  narratorVoice: "vae-narrator-voice",
  narratorGender: "vae-narrator-gender",
  speed: "vae-speed",
  autoAdvance: "vae-auto-advance",
  displayStyle: "vae-display-style",   // pixel | smooth | subtitle
  artStyle: "vae-art-style",           // semi-real | pixel
  theme: "vae-theme",                  // light | dark
  spriteBorders: "vae-sprite-borders",
  checkpointEvery: "vae-checkpoint-every",
};

const NARRATOR_M = "en-US-AndrewMultilingualNeural";
const NARRATOR_F = "en-US-AvaMultilingualNeural";

export function getPrefs() {
  const g = (k, d) => (typeof localStorage !== "undefined" ? localStorage.getItem(k) : null) ?? d;
  return {
    narratorGender: g(KEYS.narratorGender, "male"),
    narratorVoice: g(KEYS.narratorVoice, "") || (g(KEYS.narratorGender, "male") === "female" ? NARRATOR_F : NARRATOR_M),
    speed: parseFloat(g(KEYS.speed, "1")) || 1,
    autoAdvance: g(KEYS.autoAdvance, "true") !== "false",
    displayStyle: g(KEYS.displayStyle, "smooth"),
    artStyle: g(KEYS.artStyle, "semi-real"),
    theme: g(KEYS.theme, "dark"),
    spriteBorders: g(KEYS.spriteBorders, "false") === "true",
    checkpointEvery: parseInt(g(KEYS.checkpointEvery, "40"), 10) || 0,
  };
}
export function setPref(key, value) {
  if (typeof localStorage !== "undefined") localStorage.setItem(key, String(value));
}
