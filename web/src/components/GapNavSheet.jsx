import { chunkGap } from "../audio/lineAt.js";

const PREVIEW_CHARS = 140;

function preview(text) {
  const t = String(text || "").trim();
  if (t.length <= PREVIEW_CHARS) return t;
  return `${t.slice(0, PREVIEW_CHARS).trim()}…`;
}

/**
 * Lists WhisperX-detected "gaps" — audio-only narration with no book-line
 * counterpart (ad-libbed intros, publisher bumpers) — so they're reachable
 * even though they're deliberately not spliced into the real lines[] array.
 * Tapping one seeks straight to its first chunk and resumes playback there.
 */
export default function GapNavSheet({ open, onClose, gaps, firstLineStartMs, onSeekToGap }) {
  if (!open) return null;

  return (
    <div className="vae-sheet-backdrop" data-testid="gap-nav-sheet" onClick={onClose}>
      <div className="vae-sheet" onClick={(e) => e.stopPropagation()}>
        <header className="vae-sheet-head">
          <h2>Narration outside the book</h2>
          <button type="button" className="vae-sheet-close" onClick={onClose}>×</button>
        </header>

        <p className="vae-sheet-hint">
          The audiobook says these lines but they aren't in the ebook text — jump to one to hear it.
        </p>

        <section className="vae-menu-section">
          {(gaps || []).length === 0 ? (
            <p className="vae-sheet-hint">No narration outside the book was detected.</p>
          ) : (
            <ul className="vae-gap-list">
              {gaps.map((g, i) => {
                const leading = firstLineStartMs != null && g.endMs <= firstLineStartMs;
                const firstChunkId = chunkGap(g)[0].syntheticId;
                return (
                  <li key={g.id}>
                    <button
                      type="button"
                      className="vae-menu-link vae-gap-item"
                      data-testid={`gap-nav-item-${g.id}`}
                      onClick={() => onSeekToGap(firstChunkId)}
                    >
                      <span className="vae-gap-label">{leading ? "Before Chapter 1" : `Narration ${i + 1}`}</span>
                      <span className="vae-gap-preview">{preview(g.text)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
