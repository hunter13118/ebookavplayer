import { useEffect, useRef, useState } from "react";
import { mediaImageSrc } from "../media.js";

export const ILLUSTRATION_FLASH_MS = 5000;
export const ILLUSTRATION_FADE_MS = 500;

/** Full-stage EPUB insert — fade in, hold, fade out. dismissSignal bumps to exit early.
 *  autoDismiss=false keeps the image until tap or dismissSignal (gallery picks).
 *  holdMs overrides how long the image holds before auto-dismissing (default
 *  ILLUSTRATION_FLASH_MS) — the reader view's gallery/inline illustrations use
 *  a longer hold (10s) than cinematic's default 5s, tap/scroll still skips
 *  early regardless of holdMs. */
export default function IllustrationFlash({
  url, lineKey, active, dismissSignal, onDone, onTap, autoDismiss = true, holdMs = ILLUSTRATION_FLASH_MS,
}) {
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const [shown, setShown] = useState(false);
  const [opaque, setOpaque] = useState(false);

  useEffect(() => {
    if (!active || !url) {
      setShown(false);
      setOpaque(false);
      return undefined;
    }

    setShown(true);
    setOpaque(false);
    const enter = requestAnimationFrame(() => {
      requestAnimationFrame(() => setOpaque(true));
    });

    let exitTimer;
    let hideTimer;
    const scheduleExit = (delay) => {
      exitTimer = setTimeout(() => {
        setOpaque(false);
        hideTimer = setTimeout(() => {
          setShown(false);
          doneRef.current?.();
        }, ILLUSTRATION_FADE_MS);
      }, delay);
    };
    if (autoDismiss) {
      scheduleExit(holdMs);
    }

    return () => {
      cancelAnimationFrame(enter);
      clearTimeout(exitTimer);
      clearTimeout(hideTimer);
    };
  }, [active, url, lineKey, autoDismiss, holdMs]);

  useEffect(() => {
    if (!dismissSignal || !shown) return undefined;
    setOpaque(false);
    const hideTimer = setTimeout(() => {
      setShown(false);
      doneRef.current?.();
    }, ILLUSTRATION_FADE_MS);
    return () => clearTimeout(hideTimer);
  }, [dismissSignal, shown]);

  if (!shown || !url) return null;

  // Scroll/swipe dismisses just like a tap — "get back to the text sooner"
  // shouldn't require a precise tap target. Guarded on `opaque` so a fully
  // faded-out image (already dismissing) doesn't keep re-firing onTap for
  // every wheel/touch event in the same gesture.
  const dismissByGesture = (e) => {
    e.stopPropagation();
    if (opaque) onTap?.();
  };

  return (
    <div
      className={`vae-illustration-flash${opaque ? " show" : ""}`}
      data-testid="illustration-flash"
      aria-hidden
      onClick={(e) => { e.stopPropagation(); onTap?.(); }}
      onWheel={dismissByGesture}
      onTouchMove={dismissByGesture}
    >
      <img src={mediaImageSrc(url)} alt="" draggable={false} />
    </div>
  );
}
