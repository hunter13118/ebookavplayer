/** Confirm sheet — re-extracting with a provider other than the one this book is pinned to. */
export default function PinMismatchConfirm({ open, current, requested, onCancel, onConfirm, busy }) {
  if (!open) return null;
  return (
    <div className="vae-sheet-backdrop" data-testid="pin-mismatch-confirm" onClick={onCancel}>
      <div className="vae-sheet" onClick={(e) => e.stopPropagation()}>
        <header className="vae-sheet-head">
          <h2>Switch extraction provider?</h2>
          <button type="button" className="vae-sheet-close" onClick={onCancel}>×</button>
        </header>
        <p className="vae-sheet-hint">
          Last extracted with <strong>{current}</strong>. Switching to <strong>{requested}</strong> will
          re-pin this book — future re-extractions default to {requested} until changed again.
        </p>
        <footer className="vae-sheet-foot">
          <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" data-testid="pin-mismatch-confirm-btn" disabled={busy} onClick={onConfirm}>
            {busy ? "Re-extracting…" : "Switch and re-extract"}
          </button>
        </footer>
      </div>
    </div>
  );
}
