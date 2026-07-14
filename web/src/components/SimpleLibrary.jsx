import { useState } from "react";
import { resumeIndex } from "../library.js";
import { setPref } from "../audio/voicePrefs.js";

/**
 * Simple Mode library: one clean vertical list of books, big tap targets,
 * plain words. Consumes the same catalog + onOpen the full Library uses.
 * Deliberately omits: shelves, sort, multi-select, bulk actions, connection
 * health, drag-and-drop. Those live in Full Mode only.
 */
function bookAction(entry) {
  if (entry.status === "error") {
    return { kind: "error", label: "Something went wrong. Tap to try again." };
  }
  // `status`/`progress` are overloaded: they also reflect unrelated
  // background jobs (art regen, expression backfill) on a book whose text
  // is already fully extracted and perfectly readable. Gate "still being
  // prepared" on chapters actually ready vs. total instead, so a live
  // background job never locks a finished book out of Simple Mode. Only
  // fall back to the progress heuristic when chapter counts aren't known
  // yet (very early in ingest).
  const totalChapters = entry.total_chapters ?? 0;
  const stillExtracting = totalChapters > 0
    ? (entry.chapters_ready ?? 0) < totalChapters
    : (entry.progress != null && entry.progress < 0.45);
  if (stillExtracting) {
    return { kind: "processing", label: "Getting your book ready…" };
  }
  const totalLines = entry.scenes ? entry.lines || 0 : 0;
  const resumed = resumeIndex(entry.book_id, totalLines, entry.resume);
  return resumed > 0
    ? { kind: "continue", label: "Continue" }
    : { kind: "play", label: "Play" };
}

export default function SimpleLibrary({ catalog = [], onOpen, onAdd, onOpenSettings }) {
  const books = catalog.filter(Boolean);
  const [hintSeen, setHintSeen] = useState(
    () => typeof localStorage !== "undefined" && localStorage.getItem("vae-simple-seen-hint") === "1",
  );
  const dismissHint = () => {
    setPref("vae-simple-seen-hint", "1");
    setHintSeen(true);
  };

  return (
    <div className="vae-simple-lib" data-testid="simple-library" onClick={hintSeen ? undefined : dismissHint}>
      <header className="vae-simple-lib-head">
        <h1>My books</h1>
        <button
          type="button"
          className="vae-simple-more"
          data-testid="simple-open-settings"
          onClick={onOpenSettings}
        >
          More
        </button>
      </header>

      {!hintSeen && books.length > 0 && (
        <p className="vae-simple-hint" data-testid="simple-hint">
          Tip: tap a book to start listening.
        </p>
      )}

      {books.length === 0 && (
        <p className="vae-simple-empty" data-testid="simple-empty">
          You don't have any books yet. Tap "Add a book" to begin.
        </p>
      )}

      <ul className="vae-simple-list">
        {books.map((b) => {
          const act = bookAction(b);
          const disabled = act.kind === "processing";
          return (
            <li key={b.book_id} className="vae-simple-row">
              <button
                type="button"
                className={`vae-simple-book vae-simple-book-${act.kind}`}
                data-testid="simple-book"
                disabled={disabled}
                onClick={() => onOpen(b)}
              >
                <span className="vae-simple-cover" aria-hidden>
                  {b.cover ? <img src={b.cover} alt="" /> : <span className="vae-simple-cover-blank" />}
                </span>
                <span className="vae-simple-book-text">
                  <span className="vae-simple-book-title">{b.title || "Untitled book"}</span>
                  <span className={`vae-simple-book-action vae-simple-action-${act.kind}`}>
                    {act.kind === "play" || act.kind === "continue" ? "▶ " : ""}{act.label}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        className="vae-simple-add"
        data-testid="simple-add-book"
        onClick={onAdd}
      >
        ＋ Add a book
      </button>
    </div>
  );
}
