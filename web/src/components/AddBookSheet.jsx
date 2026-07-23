import Uploader from "./Uploader.jsx";

/** + menu: add EPUB, upload an M4B audiobook directly, or import packs. */
export default function AddBookSheet({
  open, onClose, onUploadEpub, epubUpload, onImportPack, onUploadM4b, m4bUpload, simple = false,
}) {
  if (!open) return null;
  const uploadingM4b = Boolean(m4bUpload?.busy);
  return (
    <div className="vae-sheet-backdrop" data-testid="add-book-sheet" onClick={onClose}>
      <div className="vae-sheet vae-sheet-tall" onClick={(e) => e.stopPropagation()}>
        <header className="vae-sheet-head">
          <h2>{simple ? "Add a book" : "Add to library"}</h2>
          <button type="button" className="vae-sheet-close" onClick={onClose} aria-label="Close">×</button>
        </header>
        {simple && <p className="vae-sheet-hint">Choose an ebook file (it ends in .epub).</p>}
        <Uploader onUpload={onUploadEpub} upload={epubUpload} compact />

        {onUploadM4b && (
          <>
            <div className="vae-sheet-divider" />
            <label className={`vae-btn vae-btn-file vae-btn-block${uploadingM4b ? " vae-btn-disabled" : ""}`}
              data-testid="upload-m4b-label">
              {uploadingM4b ? (m4bUpload.detail || "Transcribing…") : "Upload an audiobook (.m4b)"}
              <input type="file" accept=".m4b" hidden data-testid="upload-m4b-input"
                disabled={uploadingM4b}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) onUploadM4b?.(file);
                }} />
            </label>
            <p className="vae-sheet-hint">
              Speech-to-text on this device turns the audiobook straight into a readable, listenable
              book — no ebook file needed. Scenes and characters fill in automatically afterward.
            </p>
            {m4bUpload?.error && <p className="vae-sheet-err" data-testid="upload-m4b-err">{m4bUpload.error}</p>}
          </>
        )}

        {!simple && (
          <>
            <div className="vae-sheet-divider" />
            <label className="vae-btn vae-btn-file vae-btn-block" data-testid="import-pack-label">
              Import .vaepack
              <input type="file" accept=".vaepack,.zip,application/zip" multiple hidden
                data-testid="offline-import"
                onChange={(e) => {
                  const files = [...(e.target.files || [])];
                  e.target.value = "";
                  if (files.length) onImportPack?.(files);
                }} />
            </label>
          </>
        )}
      </div>
    </div>
  );
}
