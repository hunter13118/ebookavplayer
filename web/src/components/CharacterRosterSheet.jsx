/** Read-focused character roster — browse the cast and each character's
 * generated alt-expression sprites (happy/sad/angry/surprised etc.), with a
 * click-to-enlarge preview. Distinct from EpubPlatesSheet/CharacterManager
 * (the heavier rename/merge/description/reference-picture EDITING sheet,
 * reached from the settings menu) — this is a lighter browse view, opened
 * from its own toolbar button next to "Illustrations". */
import { useMemo, useState } from "react";
import { CharacterThumb, ImageLightbox } from "./CharacterManager.jsx";
import { mediaImageSrc } from "../media.js";
import ExpressionRegenControl, { bucketLabel } from "./ExpressionRegenControl.jsx";

function ExpressionThumb({ url, label, onOpen }) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) {
    return (
      <div className="vae-expr-thumb vae-expr-thumb-fallback" aria-hidden>
        <span>{label.slice(0, 1)}</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      className="vae-expr-thumb-btn"
      onClick={onOpen}
      data-testid={`expression-thumb-${label}`}
      title={`${label} — click to enlarge`}
    >
      <img
        src={mediaImageSrc(url)}
        alt={label}
        className="vae-expr-thumb"
        loading="lazy"
        onError={() => setBroken(true)}
      />
      <span className="vae-expr-thumb-label">{label}</span>
    </button>
  );
}

function CharacterRosterRow({ bookId, character, onRegenerated }) {
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState(null);

  const buckets = Object.entries(character.expressionSprites || {}).filter(([, url]) => url);

  return (
    <div className="vae-roster-row" data-testid={`roster-row-${character.id}`}>
      <div className="vae-roster-row-head">
        <CharacterThumb url={character.sprite} name={character.name} />
        <div className="vae-roster-row-head-fields">
          <span className="vae-roster-name">{character.name}</span>
          <span className="vae-sheet-hint">{character.id} · {character.importance || "secondary"}</span>
        </div>
      </div>
      <button
        type="button"
        className="vae-roster-expr-toggle"
        onClick={() => setExpanded((v) => !v)}
        data-testid={`roster-expr-toggle-${character.id}`}
        aria-expanded={expanded}
      >
        {expanded ? "▾" : "▸"} Expressions{buckets.length > 0 ? ` (${buckets.length})` : ""}
      </button>
      {expanded && (
        buckets.length > 0 ? (
          <div className="vae-roster-expr-grid" data-testid={`roster-expr-grid-${character.id}`}>
            {buckets.map(([bucket, url]) => (
              <ExpressionThumb
                key={bucket}
                url={url}
                label={bucketLabel(bucket)}
                onOpen={() => setPreview({ url, label: bucketLabel(bucket) })}
              />
            ))}
          </div>
        ) : (
          <p className="vae-sheet-hint vae-roster-expr-empty">
            No expression art yet — generated automatically for primary characters during imaging
            ("Expressive character art" at upload, on by default).
          </p>
        )
      )}
      <ExpressionRegenControl bookId={bookId} character={character} onRegenerated={onRegenerated} />
      {preview && (
        <ImageLightbox
          url={preview.url}
          caption={`${character.name} — ${preview.label}`}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}

export default function CharacterRosterSheet({ book, open, onClose, onRefresh }) {
  const characters = useMemo(() => {
    const map = book?.characters || {};
    return Object.entries(map)
      .filter(([id]) => id !== "narrator")
      .map(([id, c]) => ({
        id,
        name: c.name || id,
        importance: c.importance,
        sprite: c.sprite,
        expressionSprites: c.expressionSprites,
        wants_expressions: c.wants_expressions,
      }))
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }, [book]);

  if (!open) return null;

  return (
    <div className="vae-sheet-backdrop" data-testid="character-roster" onClick={onClose}>
      <div className="vae-sheet vae-character-roster" onClick={(e) => e.stopPropagation()}>
        <header className="vae-sheet-head">
          <h2>Characters</h2>
          <button type="button" className="vae-sheet-close" onClick={onClose}>×</button>
        </header>
        <p className="vae-sheet-hint">
          {characters.length} character{characters.length === 1 ? "" : "s"} — expand a character to
          browse their expression art.
        </p>
        {characters.length === 0 ? (
          <p className="vae-sheet-hint">No characters extracted yet.</p>
        ) : (
          <div className="vae-roster-list">
            {characters.map((c) => (
              <CharacterRosterRow
                key={c.id}
                bookId={book?.book_id}
                character={c}
                onRegenerated={onRefresh}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
