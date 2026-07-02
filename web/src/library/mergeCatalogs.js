/** Merging catalog entries — both within one backend connection (server list + optimistic
 * pending jobs) and across multiple backend connections (offline/server/remote sections). */

/**
 * Overlay a pending (locally known, in-flight) list onto a server-fetched list, keyed by
 * book_id. Used within a single connection's list so a just-started upload/regen shows up
 * immediately, before the server confirms it on the next poll.
 */
export function mergeCatalogEntries(serverList, pending = []) {
  const byId = new Map((serverList || []).map((b) => [b.book_id, { ...b }]));
  for (const p of pending) {
    const prev = byId.get(p.book_id);
    if (!prev) {
      byId.set(p.book_id, { ...p });
      continue;
    }
    byId.set(p.book_id, {
      ...p,
      ...prev,
      title: prev.title || p.title,
      progress: Math.max(prev.progress || 0, p.progress || 0),
      phase_label: prev.phase_label || p.phase_label,
      detail: prev.detail || prev.detail,
    });
  }
  return [...byId.values()].sort((a, b) => (a.title || "").localeCompare(b.title || ""));
}

/**
 * Combine catalogs fetched from N distinct backend connections into one flat, sorted list.
 * Each entry is tagged with connection_id/connection_kind so downstream UI (source chips,
 * active-connection routing when a card is opened) knows which backend it came from.
 * Dedup happens *within* a connection's own entries only — the same book_id independently
 * existing on two backends is two distinct cards, not one merged row.
 * @param {{connection: {id: string, kind: string, label: string}, entries: object[]}[]} sources
 */
export function mergeCatalogsBySource(sources) {
  const out = [];
  for (const { connection, entries } of sources || []) {
    if (!connection) continue;
    const byId = new Map();
    for (const e of entries || []) {
      byId.set(e.book_id, {
        ...e,
        connection_id: connection.id,
        connection_kind: connection.kind,
      });
    }
    out.push(...byId.values());
  }
  return out.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
}
