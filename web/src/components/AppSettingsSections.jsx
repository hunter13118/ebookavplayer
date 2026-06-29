import { KEYS, setPref } from "../audio/voicePrefs.js";

/** Shared display + playback preference blocks (library + player menus). */
export function DisplaySettings({
  prefs, setPrefs, onToggleFullscreen, showFullscreen = true,
}) {
  function upd(key, prefKey, value) {
    setPref(prefKey, value);
    setPrefs((p) => ({ ...p, [key]: value }));
  }

  return (
    <section className="vae-menu-section">
      <h3>Display</h3>
      <label className="vae-sheet-field">
        Box style
        <select data-testid="select-style" value={prefs.displayStyle}
          onChange={(e) => upd("displayStyle", KEYS.displayStyle, e.target.value)}>
          <option value="smooth">Smooth (modern)</option>
          <option value="pixel">Pixel-art</option>
          <option value="subtitle">Subtitle</option>
        </select>
      </label>
      <label className="vae-sheet-field">
        Advance
        <select data-testid="select-advance" value={prefs.autoAdvance ? "auto" : "click"}
          onChange={(e) => upd("autoAdvance", KEYS.autoAdvance, e.target.value === "auto")}>
          <option value="auto">Auto</option>
          <option value="click">Click-through</option>
        </select>
      </label>
      <label className="vae-sheet-field">
        Theme
        <select data-testid="select-theme" value={prefs.theme}
          onChange={(e) => upd("theme", KEYS.theme, e.target.value)}>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </label>
      <label className="vae-check vae-sheet-field">
        <input type="checkbox" data-testid="sprite-borders-input" checked={prefs.spriteBorders}
          onChange={(e) => upd("spriteBorders", KEYS.spriteBorders, e.target.checked)} />
        Sprite borders
      </label>
      <label className="vae-check vae-sheet-field">
        <input type="checkbox" data-testid="portrait-layout-input" checked={prefs.portraitLayout}
          onChange={(e) => upd("portraitLayout", KEYS.portraitLayout, e.target.checked)} />
        Portrait stage layout
      </label>
      {showFullscreen && onToggleFullscreen && (
        <button type="button" className="vae-menu-link" data-testid="toggle-fullscreen"
          onClick={onToggleFullscreen}>
          {prefs.fullscreen ? "Exit full screen" : "Full screen"}
        </button>
      )}
    </section>
  );
}

export function PlaybackSettings({ prefs, setPrefs }) {
  function upd(key, prefKey, value) {
    setPref(prefKey, value);
    setPrefs((p) => ({ ...p, [key]: value }));
  }

  return (
    <section className="vae-menu-section">
      <h3>Playback steps</h3>
      <label className="vae-sheet-field">
        Rewind lines
        <input type="number" min={1} max={20} data-testid="rewind-steps-input"
          value={prefs.rewindSteps}
          onChange={(e) => upd("rewindSteps", KEYS.rewindSteps, parseInt(e.target.value, 10) || 3)} />
      </label>
      <label className="vae-sheet-field">
        Skip forward lines
        <input type="number" min={1} max={20} data-testid="next-steps-input"
          value={prefs.nextSteps}
          onChange={(e) => upd("nextSteps", KEYS.nextSteps, parseInt(e.target.value, 10) || 1)} />
      </label>
    </section>
  );
}
