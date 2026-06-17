// Pinned to the very top of the player while a book is still being built.
// Reflects the Gemini pipeline progress; the book stays usable as lines/assets
// become available beneath it.
export default function ProcessingBar({ stage, progress }) {
  const pct = Math.round((progress || 0) * 100);
  const label = stage === "analyzing" ? "Analyzing text"
    : stage === "imaging" ? "Generating art"
    : stage === "parsing" ? "Reading EPUB"
    : stage === "queued" ? "Queued" : "Processing";
  return (
    <div className="vae-procbar" data-testid="processing-bar" data-progress={pct} data-stage={stage}>
      <div className="vae-procbar-fill" style={{ width: `${pct}%` }} />
      <span className="vae-procbar-label">{label} · {pct}%</span>
    </div>
  );
}
