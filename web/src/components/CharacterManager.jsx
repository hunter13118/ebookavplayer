import { useEffect, useMemo, useRef, useState } from "react";

import {
  mergeCharacter, renameCharacter, setCharacterTemperament,
  setCharacterDescription, setCharacterIsHumanoid, uploadCharacterReferenceImage,
  removeCharacterReferenceImage, assignCharacterReferenceImage, getCharacterCrops,
} from "../api.js";
import { mediaImageSrc } from "../media.js";

const TEMPERAMENT_PRESETS = ["", "stoic", "excitable", "dry/sarcastic", "warm", "volatile"];

/** Portrait thumbnail — falls back to a plain initial when the sprite is
 * still a placeholder gradient token (pre-imaging) or the URL 404s. */
export function CharacterThumb({ url, name }) {
  const [broken, setBroken] = useState(false);
  const initial = (name || "?").trim().charAt(0).toUpperCase() || "?";
  if (!url || broken) {
    return (
      <div className="vae-char-thumb vae-char-thumb-fallback" aria-hidden>
        {initial}
      </div>
    );
  }
  return (
    <img
      src={mediaImageSrc(url)}
      alt=""
      className="vae-char-thumb"
      loading="lazy"
      onError={() => setBroken(true)}
    />
  );
}

/** Full-size preview of a reference/crop image — clicking any thumbnail in
 * the reference grid or the crop picker opens this instead of acting
 * immediately, since the whole point of these tiny 44-60px thumbnails is to
 * tell who's pictured, which they're too small to actually show. `action`
 * (optional) renders a confirm button below the image — used by the crop
 * picker to make "look first, then decide" the flow instead of assigning on
 * the first click. */
export function ImageLightbox({ url, caption, action, onClose }) {
  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="vae-modal-backdrop vae-lightbox-backdrop" onClick={onClose} data-testid="image-lightbox">
      <div className="vae-lightbox" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="vae-sheet-close vae-lightbox-close" onClick={onClose}>×</button>
        <img src={mediaImageSrc(url)} alt="" className="vae-lightbox-img" />
        {caption && <p className="vae-lightbox-caption">{caption}</p>}
        {action}
      </div>
    </div>
  );
}

/** Popover grid of every crop already stored in the book (from auto-match
 * or manual uploads on ANY character), tagged by current owner — lets a
 * mismatched or misassigned crop be picked and reattached to the right
 * character instead of re-uploading a file. Fetches lazily on first open.
 * Clicking a thumbnail previews it full-size first (ImageLightbox) rather
 * than assigning immediately — a 60px thumbnail isn't enough to tell who's
 * actually pictured, which was the whole reason to add this preview. */
function CropPicker({ bookId, character, onAssign, onClose }) {
  const [crops, setCrops] = useState(null);
  const [err, setErr] = useState("");
  const [assigning, setAssigning] = useState("");
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getCharacterCrops(bookId)
      .then((data) => { if (!cancelled) setCrops(data.crops || []); })
      .catch(() => { if (!cancelled) setErr("Could not load crops."); });
    return () => { cancelled = true; };
  }, [bookId]);

  const already = new Set(character.reference_images || []);
  const candidates = (crops || []).filter((c) => !already.has(c.url));

  async function pick(crop) {
    setAssigning(crop.url);
    setErr("");
    try {
      await onAssign(crop.url);
      setPreview(null);
      onClose();
    } catch {
      setErr("Could not assign that crop.");
    } finally {
      setAssigning("");
    }
  }

  return (
    <div className="vae-crop-picker" data-testid={`character-crop-picker-${character.id}`}>
      <div className="vae-crop-picker-head">
        <span className="vae-sheet-hint">Pick an existing crop</span>
        <button type="button" className="vae-sheet-close" onClick={onClose}>×</button>
      </div>
      {crops === null && !err && <p className="vae-sheet-hint">Loading…</p>}
      {err && <p className="vae-sheet-err">{err}</p>}
      {crops !== null && !candidates.length && !err && (
        <p className="vae-sheet-hint">No other crops available yet.</p>
      )}
      {candidates.length > 0 && (
        <div className="vae-crop-picker-grid">
          {candidates.map((c) => (
            <button
              type="button"
              key={c.url}
              className="vae-crop-picker-item"
              disabled={Boolean(assigning)}
              onClick={() => setPreview(c)}
              data-testid={`character-crop-pick-${c.url}`}
              title={`Currently on ${c.owner_name || c.owner_id}`}
            >
              <img src={mediaImageSrc(c.url)} alt="" loading="lazy" />
              <span className="vae-crop-picker-owner">{c.owner_name || c.owner_id}</span>
              {assigning === c.url && <span className="vae-crop-picker-busy">…</span>}
            </button>
          ))}
        </div>
      )}
      {preview && (
        <ImageLightbox
          url={preview.url}
          caption={`Currently on ${preview.owner_name || preview.owner_id}`}
          onClose={() => setPreview(null)}
          action={(
            <button
              type="button"
              className="vae-lightbox-action"
              disabled={assigning === preview.url}
              onClick={() => pick(preview)}
              data-testid={`character-crop-use-${preview.url}`}
            >
              {assigning === preview.url ? "Assigning…" : `Use this for ${character.name}`}
            </button>
          )}
        />
      )}
    </div>
  );
}

/** One known character: editable display name + "merge into" to fold a
 * misidentified/duplicate character (e.g. "Unnamed male protagonist") into
 * an already-correct one, retroactively across the whole book. Also a
 * baseline temperament (Expression Sensitivity Plan Phase 1f) — context fed
 * into the expression re-pass, not something the reader ever sees directly.
 * Below that: the character profile viewer — portrait, editable description,
 * and user-uploaded reference pictures (docs/TODO_ILLUSTRATIONS_PROFILES_POLISH.md
 * item 3). Reference images aren't fed into image generation yet — that's
 * item 2's separate, not-yet-built follow-up. */
function CharacterRow({
  character, others, bookId, onRefresh, disabled,
}) {
  const [name, setName] = useState(character.name);
  const [temperament, setTemperament] = useState(character.temperament || "");
  const [description, setDescription] = useState(character.description || "");
  const [isHumanoid, setIsHumanoid] = useState(character.is_humanoid !== false);
  const [mergeTarget, setMergeTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [refBusy, setRefBusy] = useState(false);
  const [removingRef, setRemovingRef] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [refPreview, setRefPreview] = useState(null);
  const [err, setErr] = useState("");
  const fileInputRef = useRef(null);

  useEffect(() => {
    setName(character.name);
    setTemperament(character.temperament || "");
    setDescription(character.description || "");
    setIsHumanoid(character.is_humanoid !== false);
  }, [character.id, character.name, character.temperament, character.description, character.is_humanoid]);

  async function saveName() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === character.name) return;
    setBusy(true);
    setErr("");
    try {
      await renameCharacter(bookId, { id: character.id, name: trimmed });
      await onRefresh?.();
    } catch {
      setErr("Could not rename.");
    } finally {
      setBusy(false);
    }
  }

  async function saveTemperament(next) {
    const trimmed = next.trim();
    setTemperament(next);
    if (trimmed === (character.temperament || "")) return;
    setBusy(true);
    setErr("");
    try {
      await setCharacterTemperament(bookId, { id: character.id, temperament: trimmed });
      await onRefresh?.();
    } catch {
      setErr("Could not save temperament.");
    } finally {
      setBusy(false);
    }
  }

  async function saveIsHumanoid(next) {
    setIsHumanoid(next);
    setBusy(true);
    setErr("");
    try {
      await setCharacterIsHumanoid(bookId, { id: character.id, is_humanoid: next });
      await onRefresh?.();
    } catch {
      setIsHumanoid(!next);
      setErr("Could not save.");
    } finally {
      setBusy(false);
    }
  }

  async function saveDescription() {
    const trimmed = description.trim();
    if (trimmed === (character.description || "")) return;
    setBusy(true);
    setErr("");
    try {
      await setCharacterDescription(bookId, { id: character.id, description: trimmed });
      await onRefresh?.();
    } catch {
      setErr("Could not save description.");
    } finally {
      setBusy(false);
    }
  }

  async function handleUploadReference(e) {
    const file = e.target.files?.[0];
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!file) return;
    setRefBusy(true);
    setErr("");
    try {
      await uploadCharacterReferenceImage(bookId, character.id, file);
      await onRefresh?.();
    } catch {
      setErr("Could not upload reference image.");
    } finally {
      setRefBusy(false);
    }
  }

  async function handleRemoveReference(url) {
    setRemovingRef(url);
    setErr("");
    try {
      await removeCharacterReferenceImage(bookId, character.id, url);
      await onRefresh?.();
    } catch {
      setErr("Could not remove reference image.");
    } finally {
      setRemovingRef("");
    }
  }

  async function handleAssignReference(url) {
    await assignCharacterReferenceImage(bookId, character.id, url);
    await onRefresh?.();
  }

  async function doMerge() {
    if (!mergeTarget) return;
    setBusy(true);
    setErr("");
    try {
      await mergeCharacter(bookId, { from: character.id, to: mergeTarget });
      await onRefresh?.();
    } catch {
      setErr("Could not merge — try again.");
    } finally {
      setBusy(false);
      setMergeTarget("");
    }
  }

  return (
    <div className="vae-character-row" data-testid={`character-row-${character.id}`}>
      <div className="vae-character-row-head">
        <CharacterThumb url={character.sprite} name={character.name} />
        <div className="vae-character-row-head-fields">
          <input
            className="vae-character-name"
            value={name}
            disabled={disabled || busy}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            data-testid={`character-name-${character.id}`}
          />
          <span className="vae-sheet-hint">{character.id} · {character.importance || "secondary"}</span>
        </div>
      </div>
      <div className="vae-character-temperament">
        <label className="vae-sheet-hint" htmlFor={`character-temperament-${character.id}`}>Temperament</label>
        <input
          id={`character-temperament-${character.id}`}
          className="vae-character-temperament-input"
          list={`temperament-presets-${character.id}`}
          value={temperament}
          placeholder="stoic, excitable, dry/sarcastic…"
          disabled={disabled || busy}
          onChange={(e) => setTemperament(e.target.value)}
          onBlur={(e) => saveTemperament(e.target.value)}
          data-testid={`character-temperament-${character.id}`}
        />
        <datalist id={`temperament-presets-${character.id}`}>
          {TEMPERAMENT_PRESETS.filter(Boolean).map((t) => <option key={t} value={t} />)}
        </datalist>
      </div>
      <label className="vae-character-humanoid" htmlFor={`character-humanoid-${character.id}`}>
        <input
          id={`character-humanoid-${character.id}`}
          type="checkbox"
          checked={isHumanoid}
          disabled={disabled || busy}
          onChange={(e) => saveIsHumanoid(e.target.checked)}
          data-testid={`character-humanoid-${character.id}`}
        />
        Humanoid
        <span className="vae-sheet-hint"> — uncheck for animals/creatures (e.g. Lucy, Krul) so image
          generation skips "beautiful anime girl"/"handsome anime man" styling</span>
      </label>
      <div className="vae-character-description">
        <label className="vae-sheet-hint" htmlFor={`character-description-${character.id}`}>Description</label>
        <textarea
          id={`character-description-${character.id}`}
          className="vae-character-description-input"
          rows={2}
          value={description}
          placeholder="What this character looks like, their manner…"
          disabled={disabled || busy}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={saveDescription}
          data-testid={`character-description-${character.id}`}
        />
      </div>
      <div className="vae-character-refs">
        <span className="vae-sheet-hint">Reference pictures</span>
        <div className="vae-character-refs-grid" data-testid={`character-refs-${character.id}`}>
          {(character.reference_images || []).map((url) => (
            <div key={url} className="vae-char-ref-item">
              <button
                type="button"
                className="vae-char-ref-thumb-btn"
                onClick={() => setRefPreview(url)}
                data-testid={`character-ref-preview-${url}`}
                title="Preview full-size"
              >
                <img src={mediaImageSrc(url)} alt="" className="vae-char-ref-thumb" loading="lazy" />
              </button>
              <button
                type="button"
                className="vae-char-ref-remove"
                disabled={disabled || removingRef === url}
                onClick={() => handleRemoveReference(url)}
                data-testid={`character-ref-remove-${url}`}
                title="Remove this reference picture"
              >
                {removingRef === url ? "…" : "×"}
              </button>
            </div>
          ))}
          <button
            type="button"
            className="vae-char-ref-add"
            disabled={disabled || refBusy}
            onClick={() => fileInputRef.current?.click()}
            data-testid={`character-ref-upload-${character.id}`}
            title="Upload a new reference picture"
          >
            {refBusy ? "…" : "+"}
          </button>
          <button
            type="button"
            className="vae-char-ref-pick"
            disabled={disabled}
            onClick={() => setPickerOpen((v) => !v)}
            data-testid={`character-ref-pick-${character.id}`}
            title="Pick from existing crops"
          >
            ⌸
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="vae-hidden-file-input"
          onChange={handleUploadReference}
        />
        {pickerOpen && (
          <CropPicker
            bookId={bookId}
            character={character}
            onAssign={handleAssignReference}
            onClose={() => setPickerOpen(false)}
          />
        )}
        {refPreview && (
          <ImageLightbox
            url={refPreview}
            onClose={() => setRefPreview(null)}
            action={(
              <button
                type="button"
                className="vae-lightbox-action vae-lightbox-action-danger"
                disabled={removingRef === refPreview}
                onClick={async () => { await handleRemoveReference(refPreview); setRefPreview(null); }}
                data-testid={`character-ref-remove-from-preview-${refPreview}`}
              >
                {removingRef === refPreview ? "Removing…" : "Remove this reference"}
              </button>
            )}
          />
        )}
      </div>
      <div className="vae-character-merge">
        <select
          value={mergeTarget}
          disabled={disabled || busy || !others.length}
          onChange={(e) => setMergeTarget(e.target.value)}
          data-testid={`character-merge-target-${character.id}`}
        >
          <option value="">Merge into…</option>
          {others.map((o) => (
            <option key={o.id} value={o.id}>{o.name} ({o.id})</option>
          ))}
        </select>
        <button
          type="button"
          className="vae-menu-link"
          disabled={disabled || busy || !mergeTarget}
          onClick={doMerge}
          data-testid={`character-merge-btn-${character.id}`}
        >
          {busy ? "Merging…" : "Merge"}
        </button>
      </div>
      {err && <p className="vae-sheet-err">{err}</p>}
    </div>
  );
}

/** Book-wide roster of known characters, with rename + merge-into-existing
 * controls, plus each character's profile viewer (portrait, description,
 * reference pictures). */
export default function CharacterManager({ book, onRefresh, disabled }) {
  const characters = useMemo(() => {
    const map = book?.characters || {};
    return Object.entries(map)
      .filter(([id]) => id !== "narrator")
      .map(([id, c]) => ({
        id,
        name: c.name,
        importance: c.importance,
        temperament: c.temperament,
        description: c.description,
        sprite: c.sprite,
        reference_images: c.reference_images,
        is_humanoid: c.is_humanoid,
      }))
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }, [book]);

  if (!characters.length) {
    return <p className="vae-sheet-hint">No characters extracted yet.</p>;
  }

  return (
    <div className="vae-character-list">
      {characters.map((c) => (
        <CharacterRow
          key={c.id}
          character={c}
          others={characters.filter((o) => o.id !== c.id)}
          bookId={book.book_id}
          onRefresh={onRefresh}
          disabled={disabled}
        />
      ))}
    </div>
  );
}
