import { useState } from "react";
import { ensureBookCached, exportBookPackFile, removeLocalPack } from "../offline/bookSource.js";

/**
 * Simple Mode's door to offline downloads. Full Mode has this via
 * "⋯ Select books" → multi-select → bulk Download/Offload
 * (Library.jsx's runBulk) — SimpleLibrary.jsx deliberately omits multi-select
 * and bulk actions to stay plain-words/one-list, so that capability was
 * unreachable from Simple Mode. This is the same underlying action
 * (ensureBookCached + exportBookPackFile / removeLocalPack), just presented
 * as one plain per-book button instead of a select-then-bulk flow.
 */
export default function SimpleDownloadsSheet({ open, onClose, catalog, onRefreshCatalog }) {
  const [busyId, setBusyId] = useState(null);
  const [msg, setMsg] = useState("");

  if (!open) return null;
  const books = (catalog || []).filter(Boolean);

  async function handleDownload(id) {
    setBusyId(id);
    setMsg("");
    try {
      await ensureBookCached(id);
      await exportBookPackFile(id);
      setMsg("Saved to your device.");
      await onRefreshCatalog?.();
    } catch (e) {
      setMsg(e.message || "Couldn't download that book.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleRemove(id) {
    setBusyId(id);
    setMsg("");
    try {
      await removeLocalPack(id);
      await onRefreshCatalog?.();
    } catch (e) {
      setMsg(e.message || "Couldn't remove that book.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="vae-sheet-backdrop" data-testid="simple-downloads" onClick={onClose}>
      <div className="vae-sheet" onClick={(e) => e.stopPropagation()}>
        <header className="vae-sheet-head">
          <h2>Downloads</h2>
          <button type="button" className="vae-sheet-close" onClick={onClose} aria-label="Close">×</button>
        </header>

        <p className="vae-sheet-hint">Save a book to this device so it plays without the internet.</p>

        {books.length === 0 && <p className="vae-simple-empty">You don't have any books yet.</p>}

        <ul className="vae-simple-downloads-list">
          {books.map((b) => {
            const downloaded = Boolean(b.offline_pack);
            const busy = busyId === b.book_id;
            return (
              <li key={b.book_id} className="vae-simple-downloads-row" data-testid="simple-downloads-row">
                <span className="vae-simple-downloads-title">{b.title || "Untitled book"}</span>
                {downloaded ? (
                  <button type="button" className="vae-btn vae-btn-sm vae-btn-muted" disabled={busy}
                    data-testid="simple-downloads-remove" onClick={() => handleRemove(b.book_id)}>
                    {busy ? "…" : "Downloaded ✓ · Remove"}
                  </button>
                ) : (
                  <button type="button" className="vae-btn vae-btn-sm" disabled={busy}
                    data-testid="simple-downloads-save" onClick={() => handleDownload(b.book_id)}>
                    {busy ? "Saving…" : "Download"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>

        {msg && <p className="vae-sheet-hint" data-testid="simple-downloads-msg">{msg}</p>}
      </div>
    </div>
  );
}
