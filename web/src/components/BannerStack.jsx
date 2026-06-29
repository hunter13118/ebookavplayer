import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const DISMISS_KEY = "vae-dismissed-banners";
const DEFAULT_AUTO_DISMISS_MS = 5000;

function testDismissMs() {
  if (typeof window === "undefined") return null;
  const n = Number(window.__VAE_TEST_BANNER_MS);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function loadDismissed(bookId) {
  try {
    const raw = sessionStorage.getItem(`${DISMISS_KEY}:${bookId || "global"}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveDismissed(bookId, ids) {
  try {
    sessionStorage.setItem(`${DISMISS_KEY}:${bookId || "global"}`, JSON.stringify(ids));
  } catch { /* ignore */ }
}

/** Dismissible banner — at most one visible; auto-fades after 5s. */
export default function BannerStack({ banners, bookId, className = "", autoDismissMs }) {
  const [dismissed, setDismissed] = useState(() => loadDismissed(bookId));
  const [exiting, setExiting] = useState(() => new Set());
  const timersRef = useRef(new Map());
  const fadeMs = typeof autoDismissMs === "number" ? autoDismissMs : (testDismissMs() ?? DEFAULT_AUTO_DISMISS_MS);

  useEffect(() => {
    setDismissed(loadDismissed(bookId));
    setExiting(new Set());
  }, [bookId]);

  const dismiss = useCallback((id) => {
    setExiting((prev) => new Set(prev).add(id));
    window.setTimeout(() => {
      setDismissed((prev) => {
        if (prev.includes(id)) return prev;
        const next = [...prev, id];
        saveDismissed(bookId, next);
        return next;
      });
      setExiting((prev) => {
        const n = new Set(prev);
        n.delete(id);
        return n;
      });
    }, 280);
  }, [bookId]);

  const pending = useMemo(
    () => (banners || []).filter((b) => b?.id && !dismissed.includes(b.id)),
    [banners, dismissed],
  );

  const visible = useMemo(() => pending, [pending]);

  useEffect(() => {
    visible.forEach((b) => {
      if (timersRef.current.has(b.id)) return;
      const t = window.setTimeout(() => dismiss(b.id), fadeMs);
      timersRef.current.set(b.id, t);
    });
    const live = new Set(visible.map((b) => b.id));
    timersRef.current.forEach((t, id) => {
      if (!live.has(id)) {
        clearTimeout(t);
        timersRef.current.delete(id);
      }
    });
  }, [visible, dismiss, fadeMs]);

  useEffect(() => () => {
    timersRef.current.forEach((t) => clearTimeout(t));
    timersRef.current.clear();
  }, []);

  if (!visible.length) return null;

  return (
    <div
      className={`vae-banners ${className}`.trim()}
      data-testid="banner-stack"
      data-auto-dismiss-ms={fadeMs}
    >
      {visible.map((b) => (
        <div
          key={b.id}
          className={`vae-banner vae-banner-${b.level || "info"}${exiting.has(b.id) ? " vae-banner-exiting" : ""}`}
          data-testid="banner"
          data-level={b.level}
          data-code={b.code}
          role="status"
        >
          <span className="vae-banner-msg">{b.message}</span>
          <button
            type="button"
            className="vae-banner-dismiss"
            aria-label="Dismiss"
            onClick={() => dismiss(b.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
