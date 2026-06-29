// Pinned to the very top of the player while a book is still being built.
export default function ProcessingBar({ stage, progress, label, source, providerWait }) {
  const pct = Math.round((progress || 0) * 100);
  const stageLabel = stage === "analyzing" ? "Analyzing text"
    : stage === "imaging" ? "Generating art"
    : stage === "parsing" ? "Reading EPUB"
    : stage === "queued" ? "Queued"
    : stage === "done" ? "Complete"
    : "Processing";
  const text = label || stageLabel;
  const finishing = /finaliz/i.test(String(label || ""));
  const indeterminate = providerWait || finishing || (pct <= 4 && stage !== "done");
  const displayPct = (providerWait || finishing) ? "…" : `${pct}%`;
  return (
    <div
      className={`vae-procbar${indeterminate ? " vae-procbar-indeterminate" : ""}`}
      data-testid="processing-bar"
      data-progress={providerWait ? "wait" : pct}
      data-stage={stage}
      data-source={source || "book"}
    >
      <div
        className="vae-procbar-fill"
        style={{ width: indeterminate ? "35%" : `${Math.max(pct, 2)}%` }}
      />
      <span className="vae-procbar-label">{text} · {displayPct}</span>
    </div>
  );
}
