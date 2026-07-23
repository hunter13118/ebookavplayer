import { useState } from "react";
import { getResume, resumeIndex } from "../library.js";
import { setPref } from "../audio/voicePrefs.js";

/**
 * Simple Mode library: one clean vertical list of books, big tap targets,
 * plain words. Consumes the same catalog + onOpen the full Library uses.
 * Deliberately omits: shelves, sort, multi-select, bulk actions, connection
 * health, drag-and-drop. Those live in Full Mode only — EXCEPT downloads:
 * the "⋯" button opens SimpleDownloadsSheet, a plain-words door to the one
 * Full-mode-only capability (save a book for offline) worth carrying over.
 */
function bookAction(entry, isCaching) {
  if (entry.status === "error") {
    return { kind: "error", label: "Something went wrong. Tap to try again." };
  }
  // openBook() (App.jsx) runs ensureBookCached() before a first-time cloud
  // book can open — there's real wait here (a pack build, not instant), and
  // until now nothing told the user why nothing happened after their tap.
  if (isCaching) {
    return { kind: "processing", label: "Getting things ready…" };
  }
  // `status`/`progress` are overloaded: they also reflect unrelated
  // background jobs (art regen, expression backfill) on a book whose text
  // is already fully extracted and perfectly readable. Gate "still being
  // prepared" on whether there's any readable content AT ALL instead of the
  // chapters_ready/total_chapters ratio — the mechanical-first pipeline
  // writes a complete, all-chapters baseline (and sets chapters_ready to the
  // full count) within seconds of ingest starting, well before any real
  // per-chapter enrichment (BookNLP/annotate/LLM) begins; chapters_ready
  // then tracks ENRICHED chapters specifically, dropping back down as
  // enrichment starts even though the book was already fully readable a
  // moment earlier. Gating on `lines` instead means this row only ever
  // locks during the genuine pre-mechanical-write window (a second or two),
  // never again once real content exists — and a live background job still
  // never locks an already-readable book out of Simple Mode. Only fall back
  // to the progress heuristic when chapter counts aren't known yet at all
  // (very early in ingest, before total_chapters itself is set).
  const totalChapters = entry.total_chapters ?? 0;
  const stillExtracting = totalChapters > 0
    ? (entry.lines || 0) === 0
    : (entry.progress != null && entry.progress < 0.45);
  // An m4b-first book's background formal extraction (scenes/characters) has
  // no chapter concept at all — `total_chapters`/`chapters_ready` never show
  // up for it, so the progress-heuristic fallback above sees the server's
  // near-zero `progress` and locks the row out indefinitely, even though the
  // local pack already has the full transcript and is perfectly readable
  // (minimal/reader view) right now. Let content already on-device win.
  const hasReadableOfflineContent = Boolean(entry.offline_pack) && (entry.lines || 0) > 0;
  if (stillExtracting && !hasReadableOfflineContent) {
    return { kind: "processing", label: "Getting your book ready…" };
  }
  const totalLines = entry.scenes ? entry.lines || 0 : 0;
  const resumed = resumeIndex(entry.book_id, totalLines, entry.resume);
  return resumed > 0
    ? { kind: "continue", label: "Continue" }
    : { kind: "play", label: "Play" };
}

/** The one book to feature as "Continue reading" — most recently updated,
 *  in-progress, non-error resume across the whole library. */
function mostRecentInProgress(books) {
  const candidates = books
    .filter((b) => b.status !== "error")
    .map((b) => ({ book: b, resume: b.resume || getResume(b.book_id) }))
    .filter(({ resume }) => resume && !resume.completed && (resume.line | 0) > 0);
  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.resume.updated || 0) - (a.resume.updated || 0));
  return candidates[0];
}

export default function SimpleLibrary({
  catalog = [], onOpen, onAdd, onOpenSettings, onOpenDownloads, cacheBusy = null,
}) {
  const books = catalog.filter(Boolean);
  const recent = mostRecentInProgress(books);
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
        <div className="vae-simple-lib-head-left">
          {onOpenDownloads && (
            <button
              type="button"
              className="vae-simple-downloads-btn"
              data-testid="simple-open-downloads"
              aria-label="Downloads"
              onClick={(e) => { e.stopPropagation(); onOpenDownloads(); }}
            >
              ⋯
            </button>
          )}
          <h1>My books</h1>
        </div>
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

      {recent && (
        <button
          type="button"
          className="vae-simple-continue"
          data-testid="simple-continue-card"
          disabled={cacheBusy === recent.book.book_id}
          onClick={() => onOpen(recent.book)}
        >
          <span className="vae-simple-continue-cover" aria-hidden>
            {recent.book.cover ? <img src={recent.book.cover} alt="" /> : <span className="vae-simple-cover-blank" />}
          </span>
          <span className="vae-simple-continue-text">
            <span className="vae-simple-continue-eyebrow">
              {cacheBusy === recent.book.book_id ? "Getting things ready…" : "Continue reading"}
            </span>
            <span className="vae-simple-continue-title">{recent.book.title || "Untitled book"}</span>
            <span className="vae-simple-continue-chapter">Chapter {recent.resume.chapter || 1}</span>
          </span>
        </button>
      )}

      <ul className="vae-simple-list">
        {books.map((b) => {
          const act = bookAction(b, cacheBusy === b.book_id);
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
