import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  revertMediaAsset, commitMediaAsset, replaceMedia, generateMomentIllustration,
} from "../api.js";
import { backgroundStyle, spriteVisual, mediaImageSrc, resolveCompareArtStyle } from "../media.js";
import { patchOfflineMediaAsset } from "../offline/packBridge.js";

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
    // v.url is already fully resolved (spriteVisual -> mediaUrl already
    // prepends the API base / checks the offline-pack cache) — do NOT run
    // it through mediaImageSrc again, that double-prepends the API base
    // (e.g. "/projects/x/api/projects/x/api/media/...") and 503s. Every
    // other spriteVisual() caller (Sprite.jsx, ReplaceArtSheet.jsx) already
    // uses v.url directly for exactly this reason.
    return (
      <div className="vae-compare-thumb">
        <img src={cacheBust(v.url)} alt={label} draggable={false} />
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
  onRetry,
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
      const { url } = await revertMediaAsset(book.book_id, comparison.kind, comparison.key, {
        style,
        jobId: comparison.jobId,
      });
      // Best-effort — an install-less/never-installed book has nothing to
      // patch, and a failure here must not block the revert itself (the
      // live URL is already correct either way; worst case is the old
      // full-pack-resync path is still available as a fallback).
      patchOfflineMediaAsset(book.book_id, url).catch(() => {});
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
      const { url } = await commitMediaAsset(book.book_id, comparison.kind, comparison.key, {
        style,
        jobId: comparison.jobId,
      });
      patchOfflineMediaAsset(book.book_id, url).catch(() => {});
      onResolved?.("kept");
    } catch (e) {
      setErr(e.message || "Could not keep new art.");
    } finally {
      setBusy(false);
    }
  }

  // Fires a brand-new generation for just this one item, without leaving the
  // sheet or reselecting anything in ReplaceArtSheet — avoids re-paying the
  // reopen/reselect UI cost on every retry. The local image server's model
  // stays warm between requests either way (see docs/LOCAL_IMAGE_GEN.md), so
  // this doesn't skip any real setup cost, just the UI friction of getting
  // back to "regenerate this one" after a bad result. The never-committed
  // "after" from this attempt is simply superseded; nothing was kept live, so
  // there's nothing to revert first — the new job reads the same live
  // "before" this sheet is already showing.
  async function retry() {
    setBusy(true);
    setErr("");
    try {
      let jobId;
      if (comparison.kind === "inserts") {
        const lineIdx = parseInt(comparison.key, 10);
        ({ job_id: jobId } = await generateMomentIllustration(book.book_id, { lineIdx, diversify: true }));
      } else {
        const body = {
          scope: "selected",
          force_all: false,
          include_cover: comparison.kind === "cover",
          character_ids: comparison.kind === "characters" ? [comparison.key] : null,
          scene_ids: comparison.kind === "backgrounds" ? [comparison.key] : null,
          ignore_pins: true,
          compare: true,
          diversify: true,
          art_style: style,
        };
        ({ job_id: jobId } = await replaceMedia(book.book_id, body));
      }
      onRetry?.(jobId);
    } catch (e) {
      setErr(e.message || "Retry failed.");
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
            {onRetry && (
              <button type="button" disabled={busy} onClick={retry} title="Generate this one again">
                {busy ? "…" : "Try again"}
              </button>
            )}
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
