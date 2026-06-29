import { useState } from "react";
import { backgroundStyle, mediaUrl } from "../media.js";

/** Library cover tile — img with fallback when URL 404s or missing. */
export default function CoverThumb({ token, title, processing, errored }) {
  const [imgFailed, setImgFailed] = useState(false);

  if (token?.startsWith("gradient:")) {
    return <div className="vae-cover-img" style={backgroundStyle(token)} />;
  }

  const url = token && !imgFailed ? mediaUrl(token) : "";
  if (url) {
    return (
      <img
        className="vae-cover-img"
        src={url}
        alt=""
        decoding="async"
        onError={() => setImgFailed(true)}
      />
    );
  }

  return (
    <div className="vae-cover-fill">
      {processing
        ? <span className="vae-spinner" data-testid="spinner" aria-label="processing" />
        : errored
          ? <span className="vae-cover-glyph">!</span>
          : <span className="vae-cover-glyph">{(title || "?").slice(0, 1)}</span>}
    </div>
  );
}
