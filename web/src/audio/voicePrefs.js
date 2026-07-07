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
  sleepTimerMinutes: "vae-sleep-timer-minutes",
  rewindSteps: "vae-rewind-steps",
  nextSteps: "vae-next-steps",
  timingAlgorithm: "vae-timing-algorithm",   // audiobook→script sync strategy
  alignConnectionId: "vae-align-connection-id", // which backend connection runs whisperx alignment
  portraitLayout: "vae-portrait-layout",
  progressScope: "vae-progress-scope",
  narratorPitch: "vae-narrator-pitch",
  narratorRate: "vae-narrator-rate",
  narratorVolume: "vae-narrator-volume",
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
    artStyle: g(KEYS.artStyle, "anime"),
    theme: g(KEYS.theme, "dark"),
    spriteBorders: g(KEYS.spriteBorders, "false") === "true",
    // 0 = off. Pauses playback automatically after this many real-time minutes.
    sleepTimerMinutes: parseInt(g(KEYS.sleepTimerMinutes, "0"), 10) || 0,
    rewindSteps: parseInt(g(KEYS.rewindSteps, "3"), 10) || 3,
    nextSteps: parseInt(g(KEYS.nextSteps, "1"), 10) || 1,
    timingAlgorithm: g(KEYS.timingAlgorithm, "linear"),
    alignConnectionId: g(KEYS.alignConnectionId, ""),
    portraitLayout: g(KEYS.portraitLayout, "false") === "true",
    progressScope: g(KEYS.progressScope, "chapter"),
    narratorPitch: g(KEYS.narratorPitch, "+0Hz"),
    narratorRate: g(KEYS.narratorRate, "+0%"),
    narratorVolume: g(KEYS.narratorVolume, "+0%"),
    fullscreen: false,
  };
}
export function setPref(key, value) {
  if (typeof localStorage !== "undefined") localStorage.setItem(key, String(value));
}
