import { useEffect, useRef, useState } from "react";
import { mediaImageSrc } from "../media.js";

export const ILLUSTRATION_FLASH_MS = 5000;
export const ILLUSTRATION_FADE_MS = 500;

/** Full-stage EPUB insert — fade in, hold, fade out. dismissSignal bumps to exit early.
 *  autoDismiss=false keeps the image until tap or dismissSignal (gallery picks). */
export default function IllustrationFlash({
  url, lineKey, active, dismissSignal, onDone, onTap, autoDismiss = true,
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
      scheduleExit(ILLUSTRATION_FLASH_MS);
    }

    return () => {
      cancelAnimationFrame(enter);
      clearTimeout(exitTimer);
      clearTimeout(hideTimer);
    };
  }, [active, url, lineKey, autoDismiss]);

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

  return (
    <div
      className={`vae-illustration-flash${opaque ? " show" : ""}`}
      data-testid="illustration-flash"
      aria-hidden
      onClick={(e) => { e.stopPropagation(); onTap?.(); }}
    >
      <img src={mediaImageSrc(url)} alt="" draggable={false} />
    </div>
  );
}
