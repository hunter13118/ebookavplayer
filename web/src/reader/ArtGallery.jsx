import { useEffect, useState } from "react";
import IllustrationFlash from "../components/IllustrationFlash.jsx";

// Reader-view art (front/back-matter galleries, and per-line illustrations —
// see ReaderView.jsx) holds each image for at least this long before
// auto-advancing, longer than cinematic's 5s default: front matter plays out
// while the m4b's leading gap narration ("This is Audible...") is read
// aloud, so it shouldn't race ahead of real audio just because a tap wasn't
// registered yet. Tap or scroll always skips immediately regardless.
export const READER_ART_HOLD_MS = 10000;

/** Advance to the next index in a fixed-length gallery, or -1 once the last
 *  image has been shown/skipped (a plain function so it's testable without
 *  rendering anything). */
export function nextGalleryIndex(index, length) {
  const next = index + 1;
  return next < length ? next : -1;
}

/**
 * Sequences a list of `{url}` images one at a time via IllustrationFlash —
 * front-matter (before the book's real text starts) and back-matter (after
 * it ends) galleries in ReaderView.jsx. Each image holds for
 * READER_ART_HOLD_MS, tap/scroll/onDone all advance immediately; calls
 * `onFinished` once every image has shown (or the whole gallery was skipped
 * through). Renders nothing once finished or if `images` is empty.
 */
export default function ArtGallery({ images, onFinished }) {
  const [index, setIndex] = useState(0);
  const [dismissSignal, setDismissSignal] = useState(0);

  // A fresh `images` list (different gallery — front vs back matter, or a
  // different book) always restarts from the top.
  useEffect(() => { setIndex(0); setDismissSignal(0); }, [images]);

  if (!images?.length || index < 0) return null;

  // onDone fires once the fade-out actually completes — whether triggered by
  // the auto-dismiss timer or by tap/scroll bumping dismissSignal (see
  // IllustrationFlash) — so a manual skip gets the same smooth fade as an
  // auto-advance, not an abrupt cut.
  const advance = () => {
    const next = nextGalleryIndex(index, images.length);
    if (next === -1) onFinished?.();
    else setIndex(next);
  };

  const current = images[index];
  if (!current?.url) return null;

  return (
    <IllustrationFlash
      url={current.url}
      lineKey={`gallery-${index}`}
      active
      dismissSignal={dismissSignal}
      holdMs={READER_ART_HOLD_MS}
      onDone={advance}
      onTap={() => setDismissSignal((n) => n + 1)}
    />
  );
}
