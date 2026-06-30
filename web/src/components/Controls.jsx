import { useCallback, useEffect, useState } from "react";
import { KEYS, setPref } from "../audio/voicePrefs.js";

const MIN_SPEED = 0.5;
const MAX_SPEED = 2;
const STEP = 0.05;

function clampSpeed(v) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, Math.round(n / STEP) * STEP));
}

/** Audible / Spotify–style playback dock. */
export default function Controls({
  prefs, setPrefs, status, index, lines, onPlay, onPause, onNext, onRewind, onRestart,
}) {
  const [speedOpen, setSpeedOpen] = useState(false);
  const rewindN = prefs.rewindSteps || 3;
  const nextN = prefs.nextSteps || 1;
  const playing = status === "playing";
  const atStart = index === 0;
  const finished = status === "done" && !atStart; // restart only if finished and not at start

  const setSpeed = useCallback((value) => {
    const next = clampSpeed(value);
    setPref(KEYS.speed, next);
    setPrefs((p) => ({ ...p, speed: next }));
  }, [setPrefs]);

  useEffect(() => {
    if (!speedOpen) return undefined;
    const close = () => setSpeedOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [speedOpen]);

  const speeds = [0.75, 1, 1.25, 1.5, 1.75, 2];

  return (
    <div className="vae-player-dock" data-testid="player-dock">
      <div className="vae-dock-transport">
        <button
          type="button"
          className="vae-dock-btn vae-dock-skip"
          data-testid="rewind"
          title={`Rewind ${rewindN} lines`}
          onClick={() => onRewind?.(rewindN)}
          aria-label={`Rewind ${rewindN} lines`}
        >
          <span className="vae-dock-icon" aria-hidden>⏮</span>
          {rewindN > 1 && <span className="vae-dock-skip-n">{rewindN}</span>}
        </button>

        {playing ? (
          <button
            type="button"
            className="vae-dock-btn vae-dock-play"
            data-testid="pause"
            onClick={onPause}
            aria-label="Pause"
          >
            <span className="vae-dock-icon vae-dock-icon-lg" aria-hidden>❚❚</span>
          </button>
        ) : finished ? (
          <button
            type="button"
            className="vae-dock-btn vae-dock-play"
            data-testid="restart"
            onClick={onRestart}
            aria-label="Restart"
          >
            <span className="vae-dock-icon vae-dock-icon-lg" aria-hidden>↻↻</span>
          </button>
        ) : (
          <button
            type="button"
            className="vae-dock-btn vae-dock-play"
            data-testid="play"
            onClick={onPlay}
            aria-label="Play"
          >
            <span className="vae-dock-icon vae-dock-icon-lg" aria-hidden>▶</span>
          </button>
        )}

        <button
          type="button"
          className="vae-dock-btn vae-dock-skip"
          data-testid="next"
          title={`Skip ${nextN} line(s)`}
          onClick={() => onNext?.(nextN)}
          aria-label={`Skip forward ${nextN} lines`}
        >
          <span className="vae-dock-icon" aria-hidden>↻</span>
          {nextN > 1 && <span className="vae-dock-skip-n">{nextN}</span>}
        </button>
      </div>

      <div className="vae-dock-speed-wrap">
        <button
          type="button"
          className="vae-dock-speed-pill"
          data-testid="speed-pill"
          onClick={(e) => { e.stopPropagation(); setSpeedOpen((o) => !o); }}
        >
          {prefs.speed.toFixed(2).replace(/\.?0+$/, "")}×
        </button>
        {speedOpen && (
          <div className="vae-dock-speed-menu" data-testid="speed-menu" onClick={(e) => e.stopPropagation()}>
            {speeds.map((s) => (
              <button
                key={s}
                type="button"
                className={Math.abs(prefs.speed - s) < 0.01 ? "active" : ""}
                onClick={() => { setSpeed(s); setSpeedOpen(false); }}
              >
                {s}×
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
