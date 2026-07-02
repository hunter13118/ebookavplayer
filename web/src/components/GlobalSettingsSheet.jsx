import { useEffect, useState } from "react";
import { fetchEdgeVoices } from "../api.js";
import { KEYS, setPref } from "../audio/voicePrefs.js";
import {
  CONNECTION_CHANGE_EVENT,
  OFFLINE_ID,
  SERVER_ID,
  addConnection,
  listConnections,
  removeConnection,
} from "../backends/connections.js";
import { HEALTH_CHANGE_EVENT, getHealthSnapshot, retryConnection } from "../backends/health.js";
import { DisplaySettings, PlaybackSettings } from "./AppSettingsSections.jsx";
import VoiceField from "./VoiceField.jsx";

const STATUS_LABEL = {
  unknown: "checking…",
  checking: "checking…",
  online: "online",
  offline: "unreachable",
};

/** Library-level settings: display, playback, default narrator, AI pipeline, backends. */
export default function GlobalSettingsSheet({
  open, onClose, prefs, setPrefs, offline, onOpenPipeline,
}) {
  const [voices, setVoices] = useState([]);
  const [err, setErr] = useState("");
  const [connections, setConnections] = useState(() => listConnections());
  const [, setHealthTick] = useState(0);
  const [newLabel, setNewLabel] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [addErr, setAddErr] = useState("");

  useEffect(() => {
    const syncConnections = () => setConnections(listConnections());
    const syncHealth = () => setHealthTick((n) => n + 1);
    window.addEventListener(CONNECTION_CHANGE_EVENT, syncConnections);
    window.addEventListener(HEALTH_CHANGE_EVENT, syncHealth);
    return () => {
      window.removeEventListener(CONNECTION_CHANGE_EVENT, syncConnections);
      window.removeEventListener(HEALTH_CHANGE_EVENT, syncHealth);
    };
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

        <section className="vae-menu-section" data-testid="backend-connections-settings">
          <h3>Backends</h3>
          <p className="vae-sheet-hint">
            This device and Cloud are always available. Add a remote backend to reach a
            locally-run wrangler edge (e.g. via a Cloudflare Tunnel) — its library section
            only appears once it responds to a health check.
          </p>
          <ul className="vae-connection-list" data-testid="connection-list">
            {connections.map((conn) => {
              const snap = getHealthSnapshot(conn.id);
              const isBuiltin = conn.id === OFFLINE_ID || conn.id === SERVER_ID;
              return (
                <li key={conn.id} className="vae-connection-row" data-testid={`connection-row-${conn.id}`}>
                  <span
                    className={`vae-connection-dot vae-connection-dot-${snap.status}`}
                    title={STATUS_LABEL[snap.status] || snap.status}
                  />
                  <span className="vae-connection-label">
                    {conn.label}
                    {conn.baseUrl ? <span className="vae-connection-url"> — {conn.baseUrl}</span> : null}
                  </span>
                  {!isBuiltin && snap.status !== "online" && (
                    <button
                      type="button"
                      className="vae-menu-link"
                      data-testid={`connection-retry-${conn.id}`}
                      onClick={() => retryConnection(conn)}
                    >
                      Retry
                    </button>
                  )}
                  {!isBuiltin && (
                    <button
                      type="button"
                      className="vae-menu-link"
                      data-testid={`connection-remove-${conn.id}`}
                      onClick={() => removeConnection(conn.id)}
                    >
                      Remove
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          <label className="vae-sheet-field">
            Label
            <input
              type="text"
              className="vae-input"
              data-testid="connection-new-label"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="M4 Pro (tunnel)"
            />
          </label>
          <label className="vae-sheet-field">
            API base URL
            <input
              type="url"
              className="vae-input"
              data-testid="connection-new-url"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              placeholder="https://your-tunnel.trycloudflare.com/projects/ebookavplayer/api"
            />
          </label>
          {addErr && <p className="vae-sheet-err">{addErr}</p>}
          <button
            type="button"
            className="vae-menu-link"
            data-testid="connection-add"
            onClick={() => {
              try {
                addConnection({ label: newLabel, baseUrl: newUrl });
                setNewLabel("");
                setNewUrl("");
                setAddErr("");
              } catch (e) {
                setAddErr(e.message || "Could not add backend");
              }
            }}
          >
            Add remote backend
          </button>
        </section>

        {err && <p className="vae-sheet-err">{err}</p>}
      </div>
    </div>
  );
}
