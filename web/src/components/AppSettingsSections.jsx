import { useState } from "react";
import { KEYS, setPref } from "../audio/voicePrefs.js";
import { describeAlgorithms } from "../timing/registry.js";
import { listConnections } from "../backends/connections.js";

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
        <span className="vae-select-wrap">
          <select className="vae-select" data-testid="select-style" value={prefs.displayStyle}
            onChange={(e) => upd("displayStyle", KEYS.displayStyle, e.target.value)}>
            <option value="smooth">Smooth (modern)</option>
            <option value="pixel">Pixel-art</option>
            <option value="subtitle">Subtitle</option>
          </select>
        </span>
      </label>
      <label className="vae-sheet-field">
        Advance
        <span className="vae-select-wrap">
          <select className="vae-select" data-testid="select-advance" value={prefs.autoAdvance ? "auto" : "click"}
            onChange={(e) => upd("autoAdvance", KEYS.autoAdvance, e.target.value === "auto")}>
            <option value="auto">Auto</option>
            <option value="click">Click-through</option>
          </select>
        </span>
      </label>
      <label className="vae-sheet-field">
        Theme
        <span className="vae-select-wrap">
          <select className="vae-select" data-testid="select-theme" value={prefs.theme}
            onChange={(e) => upd("theme", KEYS.theme, e.target.value)}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </span>
      </label>
      <label className="vae-sheet-field">
        Performance mode
        <span className="vae-select-wrap">
          <select className="vae-select" data-testid="select-performance-mode" value={prefs.performanceMode}
            onChange={(e) => upd("performanceMode", KEYS.performanceMode, e.target.value)}>
            <option value="subtle">Subtle</option>
            <option value="balanced">Balanced</option>
            <option value="full">Full Drama</option>
          </select>
        </span>
      </label>
      <label className="vae-checkbox">
        <input type="checkbox" data-testid="sprite-borders-input" checked={prefs.spriteBorders}
          onChange={(e) => upd("spriteBorders", KEYS.spriteBorders, e.target.checked)} />
        <span className="vae-checkbox-box" aria-hidden />
        Sprite borders
      </label>
      <label className="vae-checkbox">
        <input type="checkbox" data-testid="portrait-layout-input" checked={prefs.portraitLayout}
          onChange={(e) => upd("portraitLayout", KEYS.portraitLayout, e.target.checked)} />
        <span className="vae-checkbox-box" aria-hidden />
        Portrait stage layout
      </label>
      <label className="vae-checkbox">
        <input type="checkbox" data-testid="directors-log-input" checked={prefs.directorsLog}
          onChange={(e) => upd("directorsLog", KEYS.directorsLog, e.target.checked)} />
        <span className="vae-checkbox-box" aria-hidden />
        Director&rsquo;s log
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
        <input type="number" min={1} max={20} className="vae-input" data-testid="rewind-steps-input"
          value={prefs.rewindSteps}
          onChange={(e) => upd("rewindSteps", KEYS.rewindSteps, parseInt(e.target.value, 10) || 3)} />
      </label>
      <label className="vae-sheet-field">
        Skip forward lines
        <input type="number" min={1} max={20} className="vae-input" data-testid="next-steps-input"
          value={prefs.nextSteps}
          onChange={(e) => upd("nextSteps", KEYS.nextSteps, parseInt(e.target.value, 10) || 1)} />
      </label>
      <label className="vae-sheet-field">
        Sleep timer
        <span className="vae-select-wrap">
          <select className="vae-select" data-testid="sleep-timer-select"
            value={prefs.sleepTimerMinutes}
            onChange={(e) => upd("sleepTimerMinutes", KEYS.sleepTimerMinutes, parseInt(e.target.value, 10) || 0)}>
            <option value={0}>Off</option>
            <option value={15}>15 minutes</option>
            <option value={30}>30 minutes</option>
            <option value={45}>45 minutes</option>
            <option value={60}>60 minutes</option>
          </select>
        </span>
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
        <span className="vae-select-wrap">
          <select className="vae-select" data-testid="select-timing-algorithm" value={prefs.timingAlgorithm}
            onChange={(e) => upd("timingAlgorithm", KEYS.timingAlgorithm, e.target.value)}>
            {TIMING_ALGORITHMS.map((a) => (
              <option key={a.id} value={a.id} title={a.blurb}>{a.label}</option>
            ))}
          </select>
        </span>
      </label>
      {prefs.timingAlgorithm === "whisperx" && (
        <label className="vae-sheet-field">
          Align server
          <span className="vae-select-wrap">
            <select className="vae-select" data-testid="select-align-connection" value={prefs.alignConnectionId}
              onChange={(e) => upd("alignConnectionId", KEYS.alignConnectionId, e.target.value)}>
              <option value="">Choose a connection…</option>
              {listConnections().filter((c) => c.baseUrl).map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
          </span>
        </label>
      )}
      {m4bStatus?.attached ? (
        <div className="vae-sheet-field">
          <span data-testid="m4b-attached-label">
            Attached: {m4bStatus.fileName || "audiobook.m4b"}
          </span>
          {m4bStatus.aligning && (
            <span className="vae-sheet-hint" data-testid="m4b-aligning-progress">
              {m4bStatus.progress
                ? `Refining sync in background — ${Math.round(m4bStatus.progress.chapter / 60000)}/${Math.round(m4bStatus.progress.total / 60000)} min transcribed. Playable now.`
                : "Refining sync in background. Playable now."}
            </span>
          )}
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
