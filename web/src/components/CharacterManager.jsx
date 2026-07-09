import { useEffect, useMemo, useRef, useState } from "react";

import {
  mergeCharacter, renameCharacter, setCharacterTemperament,
  setCharacterDescription, uploadCharacterReferenceImage,
} from "../api.js";
import { mediaImageSrc } from "../media.js";

const TEMPERAMENT_PRESETS = ["", "stoic", "excitable", "dry/sarcastic", "warm", "volatile"];

/** Portrait thumbnail — falls back to a plain initial when the sprite is
 * still a placeholder gradient token (pre-imaging) or the URL 404s. */
function CharacterThumb({ url, name }) {
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
  const [mergeTarget, setMergeTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [refBusy, setRefBusy] = useState(false);
  const [err, setErr] = useState("");
  const fileInputRef = useRef(null);

  useEffect(() => {
    setName(character.name);
    setTemperament(character.temperament || "");
    setDescription(character.description || "");
  }, [character.id, character.name, character.temperament, character.description]);

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
            <img key={url} src={mediaImageSrc(url)} alt="" className="vae-char-ref-thumb" loading="lazy" />
          ))}
          <button
            type="button"
            className="vae-char-ref-add"
            disabled={disabled || refBusy}
            onClick={() => fileInputRef.current?.click()}
            data-testid={`character-ref-upload-${character.id}`}
          >
            {refBusy ? "…" : "+"}
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="vae-hidden-file-input"
          onChange={handleUploadReference}
        />
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
