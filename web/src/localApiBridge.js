/** Deployed CF SPA → local wrangler edge (same routes as production). */

const STORAGE_KEY = "vae-api-base";
export const DEFAULT_LOCAL_EDGE = "http://127.0.0.1:8600/projects/ebookavplayer/api";
export const BRIDGE_CHANGE_EVENT = "vae-api-bridge-change";

export function normalizeApiBase(url) {
  return String(url || "").replace(/\/$/, "");
}

/** Read active bridge override (localStorage). */
export function getLocalApiBridge() {
  if (typeof localStorage === "undefined") return null;
  const v = localStorage.getItem(STORAGE_KEY);
  return v ? normalizeApiBase(v) : null;
}

export function setLocalApiBridge(url) {
  if (typeof localStorage === "undefined") return;
  if (url) localStorage.setItem(STORAGE_KEY, normalizeApiBase(url));
  else localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new CustomEvent(BRIDGE_CHANGE_EVENT));
}

export function clearLocalApiBridge() {
  setLocalApiBridge(null);
}

export function isLocalBridgeActive() {
  return Boolean(getLocalApiBridge());
}

/** Short label for banner, e.g. 127.0.0.1:8600 */
export function localBridgeLabel() {
  const base = getLocalApiBridge();
  if (!base) return "";
  try {
    const u = new URL(base);
    return `${u.hostname}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return base.replace(/^https?:\/\//, "");
  }
}

/**
 * Apply ?localApi= on first load.
 * - ?localApi=1 or ?localApi=true → default 127.0.0.1:8600
 * - ?localApi=http://127.0.0.1:8600/projects/ebookavplayer/api → explicit URL
 * - ?localApi=0 or ?localApi=off → clear bridge
 */
export function initLocalApiBridgeFromUrl() {
  if (typeof window === "undefined") return getLocalApiBridge();
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("localApi");
  if (raw == null) return getLocalApiBridge();

  if (raw === "0" || raw === "off" || raw === "false") {
    clearLocalApiBridge();
  } else if (raw === "" || raw === "1" || raw === "true") {
    setLocalApiBridge(DEFAULT_LOCAL_EDGE);
  } else {
    setLocalApiBridge(raw);
  }

  params.delete("localApi");
  const qs = params.toString();
  const next = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
  window.history.replaceState(null, "", next);
  return getLocalApiBridge();
}
