import { KEYS, setPref } from "../audio/voicePrefs.js";

export default function Controls({
  prefs, setPrefs, status, onPlay, onPause, onNext, onRestart,
}) {
  const upd = (key, prefKey, value) => {
    setPref(prefKey, value);
    setPrefs((p) => ({ ...p, [key]: value }));
  };
  return (
    <div className="vae-controls">
      <div className="vae-ctl-row">
        {status === "playing"
          ? <button data-testid="pause" onClick={onPause}>⏸ Pause</button>
          : <button data-testid="play" onClick={onPlay}>▶ Play</button>}
        <button data-testid="next" onClick={onNext}>⏭ Next</button>
        <button data-testid="restart" onClick={onRestart}>⟲ Restart</button>
      </div>

      <label>Speed
        <select data-testid="select-speed" value={prefs.speed}
          onChange={(e) => upd("speed", KEYS.speed, parseFloat(e.target.value))}>
          {[0.75, 1, 1.25, 1.5, 1.75, 2].map((s) => <option key={s} value={s}>{s}×</option>)}
        </select>
      </label>

      <label>Advance
        <select data-testid="select-advance" value={prefs.autoAdvance ? "auto" : "click"}
          onChange={(e) => upd("autoAdvance", KEYS.autoAdvance, e.target.value === "auto")}>
          <option value="auto">Auto</option>
          <option value="click">Click-through</option>
        </select>
      </label>

      <label>Box style
        <select data-testid="select-style" value={prefs.displayStyle}
          onChange={(e) => upd("displayStyle", KEYS.displayStyle, e.target.value)}>
          <option value="pixel">Pixel-art</option>
          <option value="smooth">Smooth (modern)</option>
          <option value="subtitle">Subtitle</option>
        </select>
      </label>

      <label>Theme
        <select data-testid="select-theme" value={prefs.theme}
          onChange={(e) => upd("theme", KEYS.theme, e.target.value)}>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </label>

      <label className="vae-check">
        <input type="checkbox" data-testid="sprite-borders-input" checked={prefs.spriteBorders}
          onChange={(e) => upd("spriteBorders", KEYS.spriteBorders, e.target.checked)} />
        Sprite borders
      </label>
    </div>
  );
}
