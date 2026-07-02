/**
 * Named backend connections — generalizes the old single-URL localApiBridge
 * override into a list: "This device" (offline/IndexedDB), "Cloud" (the
 * deployed Worker), and any number of user-added "remote" connections
 * (typically a Cloudflare Tunnel into a locally-run wrangler dev instance).
 *
 * Built-ins are fixed and non-removable; remotes are user-managed and
 * persisted to localStorage. See web/src/backends/health.js for the
 * connectivity/availability layer that sits on top of this list.
 */
import { getLocalApiBridge, clearLocalApiBridge } from "../localApiBridge.js";

const STORAGE_KEY = "vae-backend-connections";
const ACTIVE_KEY = "vae-active-connection";

export const CONNECTION_CHANGE_EVENT = "vae-connections-change";

export const OFFLINE_ID = "offline";
export const SERVER_ID = "server";

function coHostedApiBase() {
  if (typeof window === "undefined") return "";
  const p = window.location.pathname;
  if (p.startsWith("/projects/ebookavplayer/") || p === "/projects/ebookavplayer") {
    return "/projects/ebookavplayer/api";
  }
  return "";
}

/** Mirrors api.js's apiBase() legacy chain exactly, so "Cloud" resolves the same URL. */
function serverBaseUrl() {
  const envBase = (import.meta && import.meta.env && import.meta.env.VITE_API_BASE) || "";
  const stored = getLocalApiBridge() || envBase || coHostedApiBase() || "";
  return String(stored).replace(/\/$/, "");
}

function builtins() {
  return [
    { id: OFFLINE_ID, label: "This device", kind: "offline", baseUrl: null, createdAt: 0 },
    { id: SERVER_ID, label: "Cloud", kind: "server", baseUrl: serverBaseUrl(), createdAt: 0 },
  ];
}

function readRemotes() {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeRemotes(remotes) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(remotes));
  window.dispatchEvent(new CustomEvent(CONNECTION_CHANGE_EVENT));
}

/** One-time: fold a pre-existing ?localApi=/Settings bridge override into a real connection. */
function migrateLegacyBridge() {
  if (typeof localStorage === "undefined") return;
  if (localStorage.getItem(STORAGE_KEY) != null) return; // already migrated (or created fresh)
  const legacy = getLocalApiBridge();
  if (!legacy) {
    localStorage.setItem(STORAGE_KEY, "[]");
    return;
  }
  const remotes = [{
    id: `remote-${Date.now().toString(36)}`,
    label: "Migrated local bridge",
    kind: "remote",
    baseUrl: legacy,
    createdAt: Date.now(),
  }];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(remotes));
  clearLocalApiBridge();
}

let migrated = false;
function ensureMigrated() {
  if (migrated) return;
  migrated = true;
  migrateLegacyBridge();
}

export function listConnections() {
  ensureMigrated();
  return [...builtins(), ...readRemotes()];
}

export function getConnection(id) {
  if (!id) return null;
  return listConnections().find((c) => c.id === id) || null;
}

export function addConnection({ label, baseUrl } = {}) {
  ensureMigrated();
  const trimmedUrl = String(baseUrl || "").trim().replace(/\/$/, "");
  if (!trimmedUrl) throw new Error("baseUrl is required");
  const trimmedLabel = String(label || "").trim() || trimmedUrl;
  const remotes = readRemotes();
  const conn = {
    id: `remote-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    label: trimmedLabel,
    kind: "remote",
    baseUrl: trimmedUrl,
    createdAt: Date.now(),
  };
  writeRemotes([...remotes, conn]);
  return conn;
}

export function removeConnection(id) {
  if (id === OFFLINE_ID || id === SERVER_ID) {
    throw new Error("cannot remove a built-in connection");
  }
  const remotes = readRemotes();
  const next = remotes.filter((c) => c.id !== id);
  if (next.length !== remotes.length) writeRemotes(next);
  return next.length !== remotes.length;
}

export function updateConnection(id, patch = {}) {
  if (id === OFFLINE_ID || id === SERVER_ID) {
    throw new Error("cannot edit a built-in connection");
  }
  const remotes = readRemotes();
  let changed = false;
  const next = remotes.map((c) => {
    if (c.id !== id) return c;
    const merged = { ...c };
    if (patch.label != null) {
      const trimmed = String(patch.label).trim();
      if (trimmed) { merged.label = trimmed; changed = true; }
    }
    if (patch.baseUrl != null) {
      const trimmed = String(patch.baseUrl).trim().replace(/\/$/, "");
      if (trimmed) { merged.baseUrl = trimmed; changed = true; }
    }
    return merged;
  });
  if (changed) writeRemotes(next);
  return changed;
}

// ---- Active connection — which backend "owns" the book currently open in the Player ----

let activeId = (() => {
  if (typeof sessionStorage === "undefined") return null;
  try {
    return sessionStorage.getItem(ACTIVE_KEY) || null;
  } catch {
    return null;
  }
})();

export function getActiveConnectionId() {
  return activeId;
}

export function setActiveConnectionId(id) {
  activeId = id || null;
  if (typeof sessionStorage === "undefined") return;
  try {
    if (activeId) sessionStorage.setItem(ACTIVE_KEY, activeId);
    else sessionStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* ignore */
  }
}

// Falls back to "server" when nothing's been explicitly set (e.g. a book
// opened from a catalog entry fetched before Library's own connection-tagged
// refresh ran) — mirrors apiBase()'s own legacy-chain default, so callers
// like ProviderSelect always get a real connection to resolve against.
export function getActiveConnection() {
  return getConnection(activeId) || getConnection(SERVER_ID);
}
