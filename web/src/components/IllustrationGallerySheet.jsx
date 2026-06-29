/** Sheet listing unlocked illustrations / visual inserts for the book. */

import { useState } from "react";
import { mediaUrl, mediaImageSrc, gradientFromSeed } from "../media.js";

function IllusThumb({ url, seed }) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) {
    const grad = gradientFromSeed(seed || url || "?").css;
    return <div className="vae-illus-thumb vae-illus-thumb-fallback" style={{ background: grad }} aria-hidden />;
  }
  return (
    <img
      src={mediaImageSrc(url)}
      alt=""
      className="vae-illus-thumb"
      loading="lazy"
      onError={() => setBroken(true)}
    />
  );
}

export default function IllustrationGallerySheet({

  open,

  onClose,

  items,

  onSelect,

  currentLineIdx,

  currentLine,

  onGenerateMoment,

  momentBusy,

  momentErr,

}) {

  if (!open) return null;



  const lineCaption = (currentLine?.text || "").slice(0, 72).trim()

    || `Slide ${currentLineIdx + 1}`;



  return (

    <div className="vae-sheet-backdrop" data-testid="illustration-gallery" onClick={onClose}>

      <div className="vae-sheet vae-illus-gallery" onClick={(e) => e.stopPropagation()}>

        <header className="vae-sheet-head">

          <h2>Illustrations</h2>

          <button type="button" className="vae-sheet-close" onClick={onClose}>×</button>

        </header>

        <p className="vae-sheet-hint">

          {items.length} unlocked visual moment{items.length === 1 ? "" : "s"}

        </p>

        {currentLineIdx != null && onGenerateMoment && (

          <div className="vae-illus-generate">

            <button

              type="button"

              className="vae-btn primary"

              data-testid="generate-moment"

              disabled={momentBusy}

              onClick={() => onGenerateMoment(currentLineIdx)}

            >

              {momentBusy ? "Generating…" : "Generate moment for current slide"}

            </button>

            <p className="vae-sheet-hint vae-illus-gen-hint">

              {lineCaption}

              {currentLine?.illustration_url ? " · replaces existing art" : ""}

            </p>

            {momentErr ? <p className="vae-sheet-err">{momentErr}</p> : null}

          </div>

        )}

        {items.length === 0 ? (

          <p className="vae-sheet-hint">No illustrations yet — generate one or keep reading.</p>

        ) : (

          <ul className="vae-illus-list">

            {items.map((it) => (

              <li key={it.id}>

                <button

                  type="button"

                  className={`vae-illus-row${it.lineIdx === currentLineIdx ? " current" : ""}`}

                  data-testid={`illus-item-${it.id}`}

                  onClick={() => onSelect(it)}

                >

                  <span className="vae-illus-thumb-wrap">
                    <IllusThumb url={it.url} seed={it.id} />
                  </span>

                  <span className="vae-illus-meta">

                    <span className="vae-illus-caption">{it.caption}</span>

                    <span className="vae-illus-sub">

                      {it.chapter != null ? `Ch. ${it.chapter}` : ""}

                      {it.isMoment ? `${it.chapter != null ? " · " : ""}moment` : ""}

                      {it.speaker ? ` · ${it.speaker}` : ""}

                      {it.lineIdx != null ? ` · slide ${it.lineIdx + 1}` : ""}

                    </span>

                  </span>

                </button>

              </li>

            ))}

          </ul>

        )}

      </div>

    </div>

  );

}


