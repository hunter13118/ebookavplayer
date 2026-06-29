import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { revertMediaAsset, commitMediaAsset } from "../api.js";
import { backgroundStyle, spriteVisual, mediaImageSrc, resolveCompareArtStyle } from "../media.js";

function cacheBust(url) {
  if (!url) return url;
  if (url.includes("?v=") || url.includes("?t=")) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}t=${Date.now()}`;
}

function CompareThumb({ url, kind, label }) {
  if (!url) {
    return (
      <div className="vae-compare-thumb empty">
        <span>{label}</span>
      </div>
    );
  }
  if (kind === "backgrounds" || kind === "cover" || kind === "inserts") {
    if (kind === "inserts" && url && !url.startsWith("gradient:")) {
      return (
        <div className="vae-compare-thumb wide">
          <img src={mediaImageSrc(cacheBust(url))} alt={label} draggable={false} />
        </div>
      );
    }
    const style = backgroundStyle(url);
    return <div className="vae-compare-thumb wide" style={style} title={label} />;
  }
  const v = spriteVisual(url);
  if (v.type === "image") {
    return (
      <div className="vae-compare-thumb">
        <img src={mediaImageSrc(cacheBust(v.url))} alt={label} draggable={false} />
      </div>
    );
  }
  return (
    <div className="vae-compare-thumb" style={{ background: v.css || "#1a1d29" }}>
      {label.slice(0, 1)}
    </div>
  );
}

/** Before/after pick — dismisses ONLY via Keep previous / Keep new (not backdrop or ×). */
export default function ArtCompareSheet({
  book,
  comparison,
  queueRemaining = 0,
  open,
  onResolved,
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const style = resolveCompareArtStyle(book, comparison);

  useEffect(() => {
    if (open) setErr("");
  }, [open, comparison]);

  if (!open || !comparison) return null;

  async function keepPrevious() {
    setBusy(true);
    setErr("");
    try {
      await revertMediaAsset(book.book_id, comparison.kind, comparison.key, { style });
      onResolved?.("reverted");
    } catch (e) {
      setErr(e.message || "Revert failed.");
    } finally {
      setBusy(false);
    }
  }

  async function keepNew() {
    setBusy(true);
    setErr("");
    try {
      await commitMediaAsset(book.book_id, comparison.kind, comparison.key, { style });
      onResolved?.("kept");
    } catch (e) {
      setErr(e.message || "Could not keep new art.");
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="vae-sheet-backdrop vae-compare-backdrop" data-testid="compare-sheet">
      <div className="vae-sheet vae-compare-sheet" role="dialog" aria-modal="true">
        <header className="vae-sheet-head">
          <h2>Compare new art</h2>
        </header>
        <p className="vae-sheet-hint">
          {comparison.label || comparison.key} — pick which version to keep.
          {queueRemaining > 0 ? ` (${queueRemaining} more after this)` : ""}
        </p>
        {err && <p className="vae-sheet-err">{err}</p>}

        <div className="vae-compare-row" data-testid="compare-row">
          <div className="vae-compare-pair">
            <div className="vae-compare-side">
              <span className="vae-compare-tag">Before</span>
              <CompareThumb url={comparison.before_url} kind={comparison.kind} label={comparison.label} />
            </div>
            <div className="vae-compare-side">
              <span className="vae-compare-tag">After</span>
              <CompareThumb url={comparison.after_url} kind={comparison.kind} label={comparison.label} />
            </div>
          </div>
          <div className="vae-compare-actions">
            <button type="button" disabled={busy} onClick={keepPrevious}>
              Keep previous
            </button>
            <button type="button" className="primary" disabled={busy} onClick={keepNew}>
              Keep new
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
