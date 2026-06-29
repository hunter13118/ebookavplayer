import { useEffect, useState } from "react";
import { fetchEdgeVoices } from "../api.js";
import { KEYS, setPref } from "../audio/voicePrefs.js";
import {
  BRIDGE_CHANGE_EVENT,
  DEFAULT_LOCAL_EDGE,
  clearLocalApiBridge,
  getLocalApiBridge,
  setLocalApiBridge,
} from "../localApiBridge.js";
import { DisplaySettings, PlaybackSettings } from "./AppSettingsSections.jsx";
import VoiceField from "./VoiceField.jsx";

/** Library-level settings: display, playback, default narrator, AI pipeline. */
export default function GlobalSettingsSheet({
  open, onClose, prefs, setPrefs, offline, onOpenPipeline,
}) {
  const [voices, setVoices] = useState([]);
  const [err, setErr] = useState("");
  const [bridgeUrl, setBridgeUrl] = useState(() => getLocalApiBridge() || DEFAULT_LOCAL_EDGE);
  const [bridgeOn, setBridgeOn] = useState(() => Boolean(getLocalApiBridge()));

  useEffect(() => {
    const sync = () => {
      const active = getLocalApiBridge();
      setBridgeOn(Boolean(active));
      if (active) setBridgeUrl(active);
    };
    window.addEventListener(BRIDGE_CHANGE_EVENT, sync);
    return () => window.removeEventListener(BRIDGE_CHANGE_EVENT, sync);
  }, []);

  useEffect(() => {
    if (!open) return;
    setErr("");
    fetchEdgeVoices("en").then(setVoices).catch(() => setVoices([]));
  }, [open]);

  if (!open) return null;

  const narratorOverride = {
    source: "edge",
    voice: prefs.narratorVoice,
    pitch: prefs.narratorPitch,
    rate: prefs.narratorRate,
    volume: prefs.narratorVolume,
  };

  function setNarrator(ov) {
    setPrefs((p) => {
      const next = { ...p };
      if (ov.source === "edge" && ov.voice) {
        next.narratorVoice = ov.voice;
        setPref(KEYS.narratorVoice, ov.voice);
      }
      if (ov.pitch) {
        next.narratorPitch = ov.pitch;
        setPref(KEYS.narratorPitch, ov.pitch);
      }
      if (ov.rate) {
        next.narratorRate = ov.rate;
        setPref(KEYS.narratorRate, ov.rate);
      }
      if (ov.volume) {
        next.narratorVolume = ov.volume;
        setPref(KEYS.narratorVolume, ov.volume);
      }
      return next;
    });
  }

  return (
    <div className="vae-sheet-backdrop" data-testid="global-settings" onClick={onClose}>
      <div className="vae-sheet vae-player-menu-sheet" onClick={(e) => e.stopPropagation()}>
        <header className="vae-sheet-head">
          <h2>Settings</h2>
          <button type="button" className="vae-sheet-close" onClick={onClose}>×</button>
        </header>

        <DisplaySettings prefs={prefs} setPrefs={setPrefs} showFullscreen={false} />

        <PlaybackSettings prefs={prefs} setPrefs={setPrefs} />

        <section className="vae-menu-section">
          <h3>Default narrator</h3>
          <p className="vae-sheet-hint">Used for new uploads. ▶ previews the fox phrase.</p>
          <VoiceField
            label="Narrator"
            testId="global-voice-narrator"
            compiledVoice={prefs.narratorVoice}
            compiledPitch={prefs.narratorPitch}
            compiledRate={prefs.narratorRate}
            override={narratorOverride}
            voices={voices}
            onChange={setNarrator}
          />
        </section>

        {!offline && onOpenPipeline && (
          <section className="vae-menu-section">
            <h3>AI</h3>
            <button type="button" className="vae-menu-link" data-testid="open-pipeline-menu"
              onClick={() => { onClose(); onOpenPipeline(); }}>
              AI Pipeline…
            </button>
          </section>
        )}

        <section className="vae-menu-section" data-testid="local-api-bridge-settings">
          <h3>Developer</h3>
          <p className="vae-sheet-hint">
            Point API calls at a local wrangler edge worker while using the deployed page.
            Same machine: <code>http://127.0.0.1:8600/projects/ebookavplayer/api</code>.
            Or open with <code>?localApi=1</code>.
          </p>
          <label className="vae-sheet-field vae-bridge-toggle">
            <span>
              <input
                type="checkbox"
                checked={bridgeOn}
                data-testid="local-api-bridge-toggle"
                onChange={(e) => {
                  const on = e.target.checked;
                  setBridgeOn(on);
                  if (on) setLocalApiBridge(bridgeUrl || DEFAULT_LOCAL_EDGE);
                  else clearLocalApiBridge();
                }}
              />
              {" "}Local backend bridge
            </span>
          </label>
          {bridgeOn && (
            <label className="vae-sheet-field">
              API base URL
              <input
                type="url"
                data-testid="local-api-bridge-url"
                value={bridgeUrl}
                onChange={(e) => setBridgeUrl(e.target.value)}
                onBlur={() => {
                  if (bridgeOn && bridgeUrl.trim()) setLocalApiBridge(bridgeUrl.trim());
                }}
                placeholder={DEFAULT_LOCAL_EDGE}
              />
            </label>
          )}
          {bridgeOn && (
            <button
              type="button"
              className="vae-menu-link"
              data-testid="local-api-bridge-apply"
              onClick={() => {
                setLocalApiBridge(bridgeUrl.trim() || DEFAULT_LOCAL_EDGE);
                onClose();
                window.location.reload();
              }}
            >
              Apply &amp; reload
            </button>
          )}
        </section>

        {err && <p className="vae-sheet-err">{err}</p>}
      </div>
    </div>
  );
}
