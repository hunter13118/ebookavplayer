import { useState } from "react";
import CoverThumb from "./CoverThumb.jsx";
import ProviderSelect from "./ProviderSelect.jsx";
import { readingFraction } from "../library.js";
import { catalogSources } from "../offline/catalogSources.js";
import { SERVER_ID } from "../backends/connections.js";

export default function BookCard({
  entry, onOpen, onContinueExtraction, onRename, selectMode = false, selected = false, caching = false, connections,
}) {
  // "Continue extraction" used to always resume with whatever provider the
  // ORIGINAL (stalled) job's checkpoint recorded (worker's
  // resolveResumeProvider falls back to checkpoint.provider_used when no
  // explicit preferProvider is passed) — so a book stuck because e.g. Gemini
  // has no API key configured would just keep retrying Gemini forever, with
  // no way for the user to redirect it to a working local model. Let the
  // user pick the provider this retry should use.
  const [continueProvider, setContinueProvider] = useState("auto");
  const connection = connections?.find((c) => c.id === (entry.connection_id || SERVER_ID)) || connections?.[0];
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
          <span className="vae-card-caching" data-testid="card-caching">Getting ready…</span>
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
      {partial && onContinueExtraction && !entry.active_job_id && (
        <div className="vae-card-continue-row" onClick={(e) => e.stopPropagation()}>
          <ProviderSelect lane="extract" connection={connection} value={continueProvider}
            onChange={setContinueProvider} testId="card-continue-provider" className="vae-select-sm" />
          <button
            type="button"
            className="vae-card-continue"
            data-testid="card-continue-extraction"
            onClick={() => onContinueExtraction(entry, continueProvider)}
          >
            Continue extraction ({entry.chapters_ready ?? 0}/{entry.total_chapters ?? "?"})
          </button>
        </div>
      )}
      {onRename && (
        <button type="button" className="vae-card-rename" data-testid="card-rename"
          onClick={(e) => { e.stopPropagation(); onRename(entry); }}>
          Rename
        </button>
      )}
    </div>
  );
}
