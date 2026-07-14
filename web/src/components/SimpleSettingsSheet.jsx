import { KEYS, setPref } from "../audio/voicePrefs.js";

const FONT_STEPS = [1, 1.15, 1.3];

/**
 * Simple Mode settings: bigger text, day/night, narrator voice, reading
 * speed, and the door back to Full Mode. No provider/pipeline/character/
 * plates controls live here — those stay in Full Mode's GlobalSettingsSheet.
 */
export default function SimpleSettingsSheet({ open, onClose, prefs, setPrefs }) {
  if (!open) return null;

  function upd(key, prefKey, value) {
    setPref(prefKey, value);
    setPrefs((p) => ({ ...p, [key]: value }));
  }

  function setFontScale(scale) {
    upd("simpleFontScale", KEYS.simpleFontScale, scale);
  }

  function setTheme(theme) {
    upd("theme", KEYS.theme, theme);
  }

  function setNarratorGender(gender) {
    setPref(KEYS.narratorGender, gender);
    setPref(KEYS.narratorVoice, "");
    setPrefs((p) => ({ ...p, narratorGender: gender, narratorVoice: "" }));
  }

  function setSpeed(speed) {
    upd("speed", KEYS.speed, speed);
  }

  function showAdvanced() {
    setPref(KEYS.uiMode, "full");
    setPrefs((p) => ({ ...p, uiMode: "full" }));
    onClose?.();
  }

  return (
    <div className="vae-sheet-backdrop" data-testid="simple-settings" onClick={onClose}>
      <div className="vae-sheet vae-player-menu-sheet" onClick={(e) => e.stopPropagation()}>
        <header className="vae-sheet-head">
          <h2>More</h2>
          <button type="button" className="vae-sheet-close" onClick={onClose} aria-label="Close">×</button>
        </header>

        <section className="vae-menu-section">
          <h3>Bigger text</h3>
          <div className="vae-simple-choice-row">
            {FONT_STEPS.map((scale) => (
              <button
                key={scale}
                type="button"
                className={`vae-simple-choice ${prefs.simpleFontScale === scale ? "vae-simple-choice-active" : ""}`}
                data-testid={`simple-font-${scale}`}
                onClick={() => setFontScale(scale)}
              >
                A{scale > 1 ? "+".repeat(FONT_STEPS.indexOf(scale)) : ""}
              </button>
            ))}
          </div>
        </section>

        <section className="vae-menu-section">
          <h3>Day / Night</h3>
          <div className="vae-simple-choice-row">
            <button
              type="button"
              className={`vae-simple-choice ${prefs.theme === "light" ? "vae-simple-choice-active" : ""}`}
              data-testid="simple-theme-day"
              onClick={() => setTheme("light")}
            >
              Day
            </button>
            <button
              type="button"
              className={`vae-simple-choice ${prefs.theme === "dark" ? "vae-simple-choice-active" : ""}`}
              data-testid="simple-theme-night"
              onClick={() => setTheme("dark")}
            >
              Night
            </button>
          </div>
        </section>

        <section className="vae-menu-section">
          <h3>Narrator voice</h3>
          <div className="vae-simple-choice-row">
            <button
              type="button"
              className={`vae-simple-choice ${prefs.narratorGender === "male" ? "vae-simple-choice-active" : ""}`}
              data-testid="simple-voice-man"
              onClick={() => setNarratorGender("male")}
            >
              Man's voice
            </button>
            <button
              type="button"
              className={`vae-simple-choice ${prefs.narratorGender === "female" ? "vae-simple-choice-active" : ""}`}
              data-testid="simple-voice-woman"
              onClick={() => setNarratorGender("female")}
            >
              Woman's voice
            </button>
          </div>
        </section>

        <section className="vae-menu-section">
          <h3>Reading speed</h3>
          <div className="vae-simple-choice-row">
            <button
              type="button"
              className={`vae-simple-choice ${prefs.speed === 0.85 ? "vae-simple-choice-active" : ""}`}
              data-testid="simple-speed-slower"
              onClick={() => setSpeed(0.85)}
            >
              Slower
            </button>
            <button
              type="button"
              className={`vae-simple-choice ${prefs.speed === 1 ? "vae-simple-choice-active" : ""}`}
              data-testid="simple-speed-normal"
              onClick={() => setSpeed(1)}
            >
              Normal
            </button>
            <button
              type="button"
              className={`vae-simple-choice ${prefs.speed === 1.15 ? "vae-simple-choice-active" : ""}`}
              data-testid="simple-speed-faster"
              onClick={() => setSpeed(1.15)}
            >
              Faster
            </button>
          </div>
        </section>

        <section className="vae-menu-section">
          <button type="button" className="vae-menu-link" data-testid="simple-show-advanced" onClick={showAdvanced}>
            Show advanced options
          </button>
          <p className="vae-sheet-hint">Turns on chapters, art, voices, and more.</p>
        </section>
      </div>
    </div>
  );
}
