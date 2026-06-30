import { useState } from "react";
import { KEYS, setPref } from "../audio/voicePrefs.js";
import { describeAlgorithms } from "../timing/registry.js";

const TIMING_ALGORITHMS = describeAlgorithms();

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

/**
 * Audiobook→script sync: pick a timing strategy and (optionally) attach a
 * local .m4b so playback plays real segments of it instead of TTS. `onAttach`
 * does the heavy lifting (store the blob, scan it, compute the timeline, push
 * it into the orchestrator) and is awaited here only to drive busy/error UI.
 */
export function AudiobookSyncSettings({
  prefs, setPrefs, m4bStatus, onAttachM4b, onRemoveM4b,
}) {
  const [localBusy, setLocalBusy] = useState(false);
  const [localErr, setLocalErr] = useState("");

  function upd(key, prefKey, value) {
    setPref(prefKey, value);
    setPrefs((p) => ({ ...p, [key]: value }));
  }

  async function handleFile(ev) {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if (!file || !onAttachM4b) return;
    setLocalBusy(true);
    setLocalErr("");
    try {
      await onAttachM4b(file);
    } catch (e) {
      setLocalErr(e?.message || "Failed to attach audiobook");
    } finally {
      setLocalBusy(false);
    }
  }

  const busy = localBusy || Boolean(m4bStatus?.busy);
  const errMsg = localErr || m4bStatus?.error;

  return (
    <section className="vae-menu-section">
      <h3>Audiobook sync</h3>
      <label className="vae-sheet-field">
        Sync strategy
        <select data-testid="select-timing-algorithm" value={prefs.timingAlgorithm}
          onChange={(e) => upd("timingAlgorithm", KEYS.timingAlgorithm, e.target.value)}>
          {TIMING_ALGORITHMS.map((a) => (
            <option key={a.id} value={a.id} title={a.blurb}>{a.label}</option>
          ))}
        </select>
      </label>
      {m4bStatus?.attached ? (
        <div className="vae-sheet-field">
          <span data-testid="m4b-attached-label">
            Attached: {m4bStatus.fileName || "audiobook.m4b"}
          </span>
          <button type="button" className="vae-menu-link" data-testid="m4b-remove"
            onClick={onRemoveM4b} disabled={busy}>
            Remove
          </button>
        </div>
      ) : (
        <label className="vae-btn vae-btn-file">
          {busy ? "Syncing…" : "Attach .m4b"}
          <input type="file" accept=".m4b,audio/mp4,audio/x-m4a" hidden
            data-testid="m4b-attach" onChange={handleFile} disabled={busy} />
        </label>
      )}
      {errMsg && <div className="vae-note" data-testid="m4b-error">{errMsg}</div>}
    </section>
  );
}
