import { backgroundStyle } from "../media.js";
import { readingFraction } from "../library.js";

// One library tile: cover thumbnail (or a spinner while processing / no cover),
// the REAL title always beneath for legibility, a processing %/spinner overlay
// when the book is still being built, and a reading-progress bar + Resume hint
// when the user is mid-book.
export default function BookCard({ entry, onOpen }) {
  const processing = entry.status === "processing" ||
    (entry.status !== "error" && entry.progress < 1);
  const errored = entry.status === "error";
  const reading = readingFraction(entry.book_id, entry.scenes ? entry.lines || 0 : 0, entry.resume);
  const pct = Math.round((entry.progress || 0) * 100);

  return (
    <button className="vae-card" data-testid="book-card" data-book={entry.book_id}
      data-status={entry.status} onClick={() => onOpen(entry)}>
      <div className="vae-cover" data-testid="cover">
        {entry.cover
          ? <div className="vae-cover-img" style={backgroundStyle(entry.cover)} />
          : <div className="vae-cover-fill">
              {processing
                ? <span className="vae-spinner" data-testid="spinner" aria-label="processing" />
                : errored
                  ? <span className="vae-cover-glyph">!</span>
                  : <span className="vae-cover-glyph">{(entry.title || "?").slice(0, 1)}</span>}
            </div>}

        {processing && (
          <div className="vae-cover-proc" data-testid="card-progress" data-progress={pct}>
            <div className="vae-cover-proc-bar" style={{ width: `${pct}%` }} />
            <span>{entry.stage || "processing"} · {pct}%</span>
          </div>
        )}
        {!processing && reading > 0 && (
          <div className="vae-cover-read" data-testid="reading-bar">
            <div style={{ width: `${Math.round(reading * 100)}%` }} />
          </div>
        )}
        {!processing && reading > 0 && <span className="vae-resume-chip" data-testid="resume-chip">Resume</span>}
      </div>
      <div className="vae-card-title" data-testid="card-title" title={entry.title}>
        {entry.title}
      </div>
    </button>
  );
}
