import Uploader from "./Uploader.jsx";

/** + menu: add EPUB or import packs. */
export default function AddBookSheet({ open, onClose, onStarted, onImportPack }) {
  if (!open) return null;
  return (
    <div className="vae-sheet-backdrop" data-testid="add-book-sheet" onClick={onClose}>
      <div className="vae-sheet vae-sheet-tall" onClick={(e) => e.stopPropagation()}>
        <header className="vae-sheet-head">
          <h2>Add to library</h2>
          <button type="button" className="vae-sheet-close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <Uploader onStarted={(res, file) => { onStarted?.(res, file); onClose?.(); }} compact />
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
      </div>
    </div>
  );
}
