import { useEffect, useState } from "react";
import { getCharacterCrops, assignCharacterReferenceImage, removeCharacterReferenceImage } from "../api.js";
import { mediaImageSrc } from "../media.js";
import { ImageLightbox } from "./CharacterManager.jsx";

/** One crop thumbnail — owner badge overlay, click opens the full-size
 * preview (ImageLightbox) instead of acting immediately. */
function CropThumb({ crop, onClick }) {
  return (
    <button
      type="button"
      className="vae-crop-catalog-item"
      onClick={onClick}
      data-testid={`crop-catalog-item-${crop.url}`}
      title={crop.owner_name ? `Assigned to ${crop.owner_name}` : "Unassigned"}
    >
      <img src={mediaImageSrc(crop.url)} alt="" loading="lazy" />
      <span className={`vae-crop-catalog-badge${crop.owner_name ? "" : " vae-crop-catalog-badge-unassigned"}`}>
        {crop.owner_name || "Unassigned"}
      </span>
    </button>
  );
}

/**
 * Book-wide catalog of EVERY recognized crop — mapped to a character or not
 * — replacing the old raw-EPUB-plate grid + manual per-character plate
 * dropdown mapping (docs/TODO_ILLUSTRATIONS_PROFILES_POLISH.md item 2's
 * follow-up: crops, not whole plates, are the right unit for "who is this").
 * Click any crop to preview it full-size, then assign it to a character (or
 * remove it from whoever currently has it) right from the preview.
 */
export default function CropCatalog({ bookId, characters, onRefresh }) {
  const [crops, setCrops] = useState(null);
  const [err, setErr] = useState("");
  const [preview, setPreview] = useState(null);
  const [assignTarget, setAssignTarget] = useState("");
  const [busy, setBusy] = useState(false);

  function reload() {
    setErr("");
    getCharacterCrops(bookId)
      .then((data) => setCrops(data.crops || []))
      .catch(() => setErr("Could not load the crop catalog."));
  }

  useEffect(reload, [bookId]);

  useEffect(() => {
    setAssignTarget(preview?.owner_id || "");
  }, [preview]);

  async function handleAssign() {
    if (!preview || !assignTarget) return;
    setBusy(true);
    setErr("");
    try {
      await assignCharacterReferenceImage(bookId, assignTarget, preview.url);
      await onRefresh?.();
      reload();
      setPreview(null);
    } catch {
      setErr("Could not assign this crop.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    if (!preview?.owner_id) return;
    setBusy(true);
    setErr("");
    try {
      await removeCharacterReferenceImage(bookId, preview.owner_id, preview.url);
      await onRefresh?.();
      reload();
      setPreview(null);
    } catch {
      setErr("Could not remove this crop.");
    } finally {
      setBusy(false);
    }
  }

  if (crops === null && !err) return <p className="vae-sheet-hint">Loading crops…</p>;
  if (err) return <p className="vae-sheet-err">{err}</p>;
  if (!crops.length) {
    return <p className="vae-sheet-hint">No crops yet — run "Auto-match plates to characters" to generate some.</p>;
  }

  return (
    <div className="vae-crop-catalog" data-testid="crop-catalog">
      <p className="vae-sheet-hint">
        {crops.length} crop{crops.length === 1 ? "" : "s"} found in this book — click one to preview it
        full-size and assign it to the right character.
      </p>
      <div className="vae-crop-catalog-grid">
        {crops.map((c) => (
          <CropThumb key={c.url} crop={c} onClick={() => setPreview(c)} />
        ))}
      </div>
      {preview && (
        <ImageLightbox
          url={preview.url}
          caption={preview.owner_name ? `Currently assigned to ${preview.owner_name}` : "Unassigned"}
          onClose={() => setPreview(null)}
          action={(
            <div className="vae-crop-catalog-lightbox-actions">
              <span className="vae-select-wrap">
                <select
                  className="vae-select"
                  value={assignTarget}
                  disabled={busy}
                  onChange={(e) => setAssignTarget(e.target.value)}
                  data-testid="crop-catalog-assign-select"
                >
                  <option value="">Assign to…</option>
                  {characters.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </span>
              <button
                type="button"
                className="vae-lightbox-action"
                disabled={busy || !assignTarget || assignTarget === preview.owner_id}
                onClick={handleAssign}
                data-testid="crop-catalog-assign-btn"
              >
                {busy ? "Assigning…" : "Assign"}
              </button>
              {preview.owner_id && (
                <button
                  type="button"
                  className="vae-lightbox-action vae-lightbox-action-danger"
                  disabled={busy}
                  onClick={handleRemove}
                  data-testid="crop-catalog-remove-btn"
                >
                  {busy ? "Removing…" : `Remove from ${preview.owner_name}`}
                </button>
              )}
            </div>
          )}
        />
      )}
    </div>
  );
}
