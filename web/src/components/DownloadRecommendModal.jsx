/** After implicit cache, offer a durable .vaepack download (iOS Files). */
export default function DownloadRecommendModal({
  open, title, busy, onDownload, onSkip,
}) {
  if (!open) return null;
  return (
    <div className="vae-modal-backdrop" data-testid="download-recommend-modal">
      <div className="vae-modal" role="dialog" aria-labelledby="dl-rec-title">
        <h2 id="dl-rec-title" className="vae-modal-title">Save to your device?</h2>
        <p className="vae-modal-body">
          <strong>{title || "This book"}</strong> is now cached in this browser for offline reading.
          We recommend also saving a <strong>.vaepack</strong> file to iOS Files or your computer —
          home-screen apps can clear browser storage without warning.
          On iPhone/iPad you may see the Share sheet to save to Files.
        </p>
        <div className="vae-modal-actions">
          <button type="button" className="vae-btn" data-testid="download-recommend-save"
            disabled={busy} onClick={onDownload}>
            {busy ? "Preparing…" : "Save .vaepack"}
          </button>
          <button type="button" className="vae-btn vae-btn-muted" data-testid="download-recommend-skip"
            disabled={busy} onClick={onSkip}>
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}
