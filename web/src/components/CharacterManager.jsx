import { useEffect, useMemo, useState } from "react";

import { mergeCharacter, renameCharacter } from "../api.js";

/** One known character: editable display name + "merge into" to fold a
 * misidentified/duplicate character (e.g. "Unnamed male protagonist") into
 * an already-correct one, retroactively across the whole book. */
function CharacterRow({
  character, others, bookId, onRefresh, disabled,
}) {
  const [name, setName] = useState(character.name);
  const [mergeTarget, setMergeTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    setName(character.name);
  }, [character.id, character.name]);

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

/** Book-wide roster of known characters, with rename + merge-into-existing controls. */
export default function CharacterManager({ book, onRefresh, disabled }) {
  const characters = useMemo(() => {
    const map = book?.characters || {};
    return Object.entries(map)
      .filter(([id]) => id !== "narrator")
      .map(([id, c]) => ({ id, name: c.name, importance: c.importance }))
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
