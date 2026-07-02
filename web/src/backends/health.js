/**
 * Connectivity + capability probing for backend connections (connections.js).
 * GET /health confirms a backend is alive; GET /pipeline (only once alive)
 * reports which providers — including local ones like ollama-7b/local_sd —
 * are actually available there. Both endpoints already exist server-side;
 * this module only polls and caches them, no new backend surface.
 *
 * Cache is in-memory only (not localStorage): health is inherently
 * transient, and persisting a stale "online" across a reload would recreate
 * the exact broken-UI-for-a-dead-backend problem this is meant to avoid.
 */
import { fetchHealth, fetchPipeline } from "../api.js";
import { listConnections } from "./connections.js";

export const HEALTH_CHANGE_EVENT = "vae-health-change";

const REPOLL_INTERVAL_MS = 30_000;

const EMPTY_SNAPSHOT = { status: "unknown", health: null, pipeline: null, lastCheckedAt: 0 };

// connectionId -> { status: "unknown"|"checking"|"online"|"offline", health, pipeline, lastCheckedAt }
const snapshots = new Map();

function emit() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(HEALTH_CHANGE_EVENT));
}

function setSnapshot(id, patch) {
  const prev = snapshots.get(id) || EMPTY_SNAPSHOT;
  snapshots.set(id, { ...prev, ...patch });
  emit();
}

export function getHealthSnapshot(id) {
  return snapshots.get(id) || EMPTY_SNAPSHOT;
}

export function subscribeHealth(callback) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(HEALTH_CHANGE_EVENT, callback);
  return () => window.removeEventListener(HEALTH_CHANGE_EVENT, callback);
}

export async function checkHealth(connection) {
  if (!connection) return null;
  if (connection.kind === "offline") {
    setSnapshot(connection.id, { status: "online", health: { ok: true, offline: true }, lastCheckedAt: Date.now() });
    return getHealthSnapshot(connection.id);
  }
  setSnapshot(connection.id, { status: "checking" });
  try {
    const health = await fetchHealth(connection);
    setSnapshot(connection.id, {
      status: health?.ok ? "online" : "offline",
      health: health || null,
      lastCheckedAt: Date.now(),
    });
  } catch {
    setSnapshot(connection.id, { status: "offline", health: null, lastCheckedAt: Date.now() });
  }
  return getHealthSnapshot(connection.id);
}

/** Only meaningful once a connection is confirmed online — never probes a dead backend. */
export async function checkPipeline(connection) {
  if (!connection) return null;
  if (getHealthSnapshot(connection.id).status !== "online") return null;
  try {
    const pipeline = await fetchPipeline(connection);
    setSnapshot(connection.id, { pipeline });
    return pipeline;
  } catch {
    return null;
  }
}

let pollTimer = null;

async function pollOnce({ includeUnchecked = false } = {}) {
  const conns = listConnections();
  const targets = conns.filter((c) => {
    if (c.kind === "offline") return true;
    if (includeUnchecked) return true;
    const status = getHealthSnapshot(c.id).status;
    return status === "online" || status === "checking";
  });
  await Promise.allSettled(targets.map((c) => checkHealth(c)));
  await Promise.allSettled(
    targets
      .filter((c) => getHealthSnapshot(c.id).status === "online")
      .map((c) => checkPipeline(c)),
  );
}

/** Call once on app mount. Checks everything immediately, then only re-checks
 *  already-online connections on a slow interval (never hammers a dead one). */
export function startHealthPolling() {
  if (pollTimer) return stopHealthPolling;
  pollOnce({ includeUnchecked: true });
  pollTimer = setInterval(() => pollOnce({ includeUnchecked: false }), REPOLL_INTERVAL_MS);
  return stopHealthPolling;
}

export function stopHealthPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

/** Explicit re-check — a "Retry" button, or navigating to a book known to live on this connection. */
export async function retryConnection(connection) {
  await checkHealth(connection);
  await checkPipeline(connection);
  return getHealthSnapshot(connection.id);
}
