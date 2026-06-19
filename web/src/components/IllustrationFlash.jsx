import { useEffect, useState } from "react";
import { mediaUrl } from "../media.js";

const FLASH_MS = 4500;
const FADE_MS = 650;

/** Full-stage EPUB insert flash — fades to sprites + background underneath. */
export default function IllustrationFlash({ url, lineKey }) {
  const [show, setShow] = useState(false);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    if (!url) {
      setShow(false);
      setFading(false);
      return undefined;
    }
    setShow(true);
    setFading(false);
    const fadeTimer = setTimeout(() => setFading(true), FLASH_MS - FADE_MS);
    const hideTimer = setTimeout(() => {
      setShow(false);
      setFading(false);
    }, FLASH_MS);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(hideTimer);
    };
  }, [url, lineKey]);

  if (!show || !url) return null;

  return (
    <div
      className={`vae-illustration-flash${fading ? " fading" : ""}`}
      data-testid="illustration-flash"
      aria-hidden
    >
      <img src={mediaUrl(url)} alt="" draggable={false} />
    </div>
  );
}
