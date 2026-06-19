import { useState } from "react";
import { setActiveStyle, generateArtStyle } from "../api.js";

const BADGE = { ready: "●", generating: "◐", empty: "○", filter: "▤" };

/** In-player art style switcher (ART_STYLES P2–P4). */
export default function ArtStyleSwitcher({ book, disabled, onRefresh, onJobStarted }) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [err, setErr] = useState("");

  const styles = book?.styles?.length
    ? book.styles
    : [{ id: "semi-real", label: "Semi-realistic", status: "ready" }];
  const active = book?.active_style || "semi-real";

  async function swapReady(styleId, { mode } = {}) {
    setBusy(true);
    setErr("");
    try {
      await setActiveStyle(book.book_id, styleId, { mode });
      await onRefresh?.();
    } catch {
      setErr("Could not switch art style.");
    } finally {
      setBusy(false);
    }
  }

  async function startGenerate(styleId) {
    setBusy(true);
    setErr("");
    try {
      const { job_id: jobId } = await generateArtStyle(book.book_id, styleId);
      setConfirm(null);
      onJobStarted?.(jobId);
      await onRefresh?.();
    } catch {
      setErr("Could not start art generation.");
    } finally {
      setBusy(false);
    }
  }

  function onPick(st) {
    if (disabled || busy) return;
    if (st.id === active && st.status !== "filter") return;
    if (st.status === "ready") return swapReady(st.id);
    if (st.status === "filter" && st.id === "pixel") return swapReady("pixel", { mode: "filter" });
    if (st.status === "generating") return;
    setConfirm(st);
  }

  return (
    <div className="vae-style-switcher" data-testid="art-style-switcher">
      <span className="vae-style-label">Art</span>
      <div className="vae-style-options" role="group" aria-label="Art style">
        {styles.map((st) => {
          const isActive = st.id === active || (st.id === "pixel" && book?.art_filter === "pixel");
          return (
            <button
              key={st.id}
              type="button"
              className={`vae-style-btn${isActive ? " active" : ""}`}
              data-testid="art-style-option"
              data-style={st.id}
              data-status={st.status}
              disabled={disabled || busy || st.status === "generating"}
              title={st.status === "filter" ? "Instant pixel filter" : st.label}
              onClick={() => onPick(st)}
            >
              <span className="vae-style-badge" aria-hidden>{BADGE[st.status] || "○"}</span>
              <span className="vae-style-name">{st.label}</span>
            </button>
          );
        })}
      </div>

      {confirm && (
        <div className="vae-style-confirm" data-testid="style-generate-dialog">
          <p>
            Generate <strong>{confirm.label}</strong> art? This runs in the background and may
            take several minutes.
          </p>
          <div className="vae-style-confirm-actions">
            <button type="button" onClick={() => setConfirm(null)}>Cancel</button>
            {confirm.id === "pixel" && styles.some((s) => s.status === "ready" && s.id !== "pixel") && (
              <button type="button" data-testid="style-pixel-filter"
                onClick={() => { setConfirm(null); swapReady("pixel", { mode: "filter" }); }}>
                Use filter instead
              </button>
            )}
            <button type="button" data-testid="style-generate-confirm"
              onClick={() => startGenerate(confirm.id)}>
              Generate
            </button>
          </div>
        </div>
      )}

      {err && <p className="vae-sheet-err">{err}</p>}
    </div>
  );
}
