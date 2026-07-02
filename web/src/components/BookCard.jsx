import CoverThumb from "./CoverThumb.jsx";
import { readingFraction } from "../library.js";
import { catalogSources } from "../offline/catalogSources.js";

export default function BookCard({
  entry, onOpen, onContinueExtraction, selectMode = false, selected = false, caching = false, connections,
}) {
  const pct = Math.min(100, Math.round((entry.progress || 0) * 100));
  const prog = Math.min(1, Math.max(0, entry.progress ?? 0));
  const partial = entry.status === "partial";
  const processing = !partial && (entry.status === "processing"
    || (entry.status !== "error" && entry.status !== "ready" && prog < 1));
  const errored = entry.status === "error";
  const reading = readingFraction(entry.book_id, entry.scenes ? entry.lines || 0 : 0, entry.resume);
  const ready = !processing && !errored && prog >= 1;
  const sources = catalogSources(entry, connections);

  return (
    <div className={`vae-card-wrap${selected ? " vae-card-selected" : ""}`}>
      <button
        className="vae-card"
        data-testid="book-card"
        data-book={entry.book_id}
        data-status={entry.status}
        onClick={() => onOpen(entry)}
      >
        {selectMode && (
          <span className={`vae-card-check${selected ? " vae-card-check-on" : ""}`}
            data-testid="card-select" aria-hidden />
        )}
        {caching && (
          <span className="vae-card-caching" data-testid="card-caching">Caching…</span>
        )}
        <div className="vae-cover" data-testid="cover">
          <CoverThumb
            token={entry.cover}
            title={entry.title}
            processing={processing}
            errored={errored}
          />
          {processing && (
            <div className="vae-cover-proc" data-testid="card-progress" data-progress={pct}>
              <div className="vae-cover-proc-bar" style={{ width: `${Math.min(100, pct)}%` }} />
              <span>
                {entry.phase_label || entry.stage || "processing"}
                {entry.step_index != null && entry.step_total != null
                  ? ` · ${entry.step_index}/${entry.step_total}`
                  : ""}
                {" · "}
                {pct}%
              </span>
            </div>
          )}
          {!processing && reading > 0 && (
            <div className="vae-cover-read" data-testid="reading-bar">
              <div style={{ width: `${Math.round(reading * 100)}%` }} />
            </div>
          )}
          {!processing && reading > 0 && (
            <span className="vae-resume-chip" data-testid="resume-chip">Resume</span>
          )}
          {partial && (
            <div className="vae-cover-partial" data-testid="card-partial-badge">
              {entry.chapters_ready ?? 0}/{entry.total_chapters ?? "?"} chapters ready
            </div>
          )}
        </div>
        <div className="vae-card-title" data-testid="card-title" title={entry.title}>
          {entry.title}
        </div>
        {entry.author && (
          <div className="vae-card-author" data-testid="card-author">{entry.author}</div>
        )}
        {sources.length > 0 && (
          <div className="vae-card-sources" data-testid="card-sources">
            {sources.map((s) => (
              <span key={s.id} className={`vae-source-chip vae-source-${s.id}`} title={s.title}>
                {s.label}
              </span>
            ))}
          </div>
        )}
      </button>
      {partial && onContinueExtraction && (
        <button
          type="button"
          className="vae-card-continue"
          data-testid="card-continue-extraction"
          onClick={(e) => { e.stopPropagation(); onContinueExtraction(entry); }}
        >
          Continue extraction ({entry.chapters_ready ?? 0}/{entry.total_chapters ?? "?"})
        </button>
      )}
    </div>
  );
}
