/** Read-focused character roster — browse the cast and each character's
 * generated alt-expression sprites (happy/sad/angry/surprised etc.), with a
 * click-to-enlarge preview. Distinct from EpubPlatesSheet/CharacterManager
 * (the heavier rename/merge/description/reference-picture EDITING sheet,
 * reached from the settings menu) — this is a lighter browse view, opened
 * from its own toolbar button next to "Illustrations". */
import { useEffect, useMemo, useRef, useState } from "react";
import { CharacterThumb, ImageLightbox } from "./CharacterManager.jsx";
import { mediaImageSrc } from "../media.js";
import { regenExpressionSprite, subscribeJobEvents, jobEventToStatus } from "../api.js";

// Mirrors worker/_shared/edge-imaging.js's DEFAULT_EXPRESSIVE_BUCKETS — the
// only buckets ever generated (cost control: 4, not the full 16-bucket
// vocabulary). Keep these two lists in sync if that ever changes.
const REGENERATABLE_BUCKETS = ["happy", "angry", "sad", "surprised"];

const BUCKET_LABELS = {
  happy: "Happy",
  sad: "Sad",
  angry: "Angry",
  surprised: "Surprised",
  whisper: "Whisper",
  yell: "Yell",
  scared: "Scared",
  excited: "Excited",
  embarrassed: "Embarrassed",
  smug: "Smug",
  tender: "Tender",
  nervous: "Nervous",
  sarcastic: "Sarcastic",
  determined: "Determined",
  desperate: "Desperate",
};

function bucketLabel(bucket) {
  return BUCKET_LABELS[bucket] || bucket;
}

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

/** Collapsible "redo one expression" control — separate from the read-only
 * "Expressions" browse section above it. Only meaningful for primary
 * characters (the only ones expression art ever generates for) with a base
 * portrait already committed. There's no "regenerate all" here by design —
 * pick one bucket at a time, same cost-gate as everywhere else in this
 * feature. */
function ExpressionRegenSection({ bookId, character, onRegenerated }) {
  const [expanded, setExpanded] = useState(false);
  const [bucket, setBucket] = useState(REGENERATABLE_BUCKETS[0]);
  const [state, setState] = useState({ phase: "idle", detail: "" }); // idle | queued | working | done | error
  const unsubRef = useRef(null);

  useEffect(() => () => unsubRef.current?.(), []);

  async function startRegen() {
    unsubRef.current?.();
    setState({ phase: "queued", detail: "" });
    try {
      const { job_id } = await regenExpressionSprite(bookId, character.id, bucket);
      unsubRef.current = subscribeJobEvents(job_id, {
        onEvent: (ev) => {
          const st = jobEventToStatus(ev);
          if (st.status === "error") {
            setState({ phase: "error", detail: st.detail || st.error || "Regen failed." });
            unsubRef.current?.();
            unsubRef.current = null;
            return;
          }
          if (st.status === "done") {
            setState({ phase: "done", detail: "" });
            unsubRef.current?.();
            unsubRef.current = null;
            onRegenerated?.();
            return;
          }
          setState({ phase: "working", detail: st.detail || "" });
        },
      });
    } catch (e) {
      setState({ phase: "error", detail: e.message || "Could not start regen." });
    }
  }

  const busy = state.phase === "queued" || state.phase === "working";

  return (
    <div className="vae-roster-regen">
      <button
        type="button"
        className="vae-roster-expr-toggle"
        onClick={() => setExpanded((v) => !v)}
        data-testid={`roster-regen-toggle-${character.id}`}
        aria-expanded={expanded}
      >
        {expanded ? "▾" : "▸"} Regenerate expression
      </button>
      {expanded && (
        <div className="vae-roster-regen-body" data-testid={`roster-regen-body-${character.id}`}>
          <select
            className="vae-roster-regen-select"
            value={bucket}
            onChange={(e) => setBucket(e.target.value)}
            disabled={busy}
            data-testid={`roster-regen-select-${character.id}`}
          >
            {REGENERATABLE_BUCKETS.map((b) => (
              <option key={b} value={b}>{bucketLabel(b)}</option>
            ))}
          </select>
          <button
            type="button"
            className="vae-btn-xs"
            onClick={startRegen}
            disabled={busy}
            data-testid={`roster-regen-btn-${character.id}`}
          >
            {busy ? "Generating…" : "Regenerate"}
          </button>
          {state.phase === "working" && state.detail && (
            <p className="vae-sheet-hint vae-roster-regen-status">{state.detail}</p>
          )}
          {state.phase === "done" && (
            <p className="vae-sheet-hint vae-roster-regen-status">
              {bucketLabel(bucket)} regenerated.
            </p>
          )}
          {state.phase === "error" && (
            <p className="vae-sheet-hint vae-roster-regen-status vae-roster-regen-error">
              {state.detail}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function CharacterRosterRow({ bookId, character, onRegenerated }) {
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState(null);

  const buckets = Object.entries(character.expressionSprites || {}).filter(([, url]) => url);
  const canRegen = character.importance === "primary" && Boolean(character.sprite);

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
      {canRegen && (
        <ExpressionRegenSection bookId={bookId} character={character} onRegenerated={onRegenerated} />
      )}
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
