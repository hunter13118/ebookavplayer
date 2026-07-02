/** Where a library entry can be played from — cloud, browser cache, linked folder file, or a remote tunneled backend. */

export const SOURCE_CLOUD = "cloud";
export const SOURCE_BROWSER = "browser";
export const SOURCE_FOLDER = "folder";
export const SOURCE_REMOTE = "remote";

const SOURCE_META = {
  [SOURCE_CLOUD]: {
    label: "Cloud",
    title: "Streaming from the server — needs network unless also installed on this device",
  },
  [SOURCE_BROWSER]: {
    label: "This device",
    title: "Installed in this browser — plays offline here; iOS may clear this storage",
  },
  [SOURCE_FOLDER]: {
    label: "Folder",
    title: "A .vaepack copy is in your linked folder on disk",
  },
};

/**
 * @param {object} entry
 * @param {{id: string, kind: string, label: string}[]} [connections] resolves entry.connection_id
 * @returns {{ id: string, label: string, title: string }[]}
 */
export function catalogSources(entry, connections) {
  const out = [];
  if (!entry) return out;
  if (entry.connection_id) {
    const conn = (connections || []).find((c) => c.id === entry.connection_id);
    if (conn && conn.kind === "remote") {
      out.push({
        id: SOURCE_REMOTE,
        label: conn.label,
        title: `Streaming from ${conn.label} (tunneled local server)`,
      });
      return out;
    }
  }
  if (entry.server_available !== false) {
    out.push({ id: SOURCE_CLOUD, ...SOURCE_META[SOURCE_CLOUD] });
  }
  if (entry.offline_pack) {
    out.push({ id: SOURCE_BROWSER, ...SOURCE_META[SOURCE_BROWSER] });
  }
  if (entry.pack_origin === "folder") {
    out.push({ id: SOURCE_FOLDER, ...SOURCE_META[SOURCE_FOLDER] });
  }
  return out;
}

/** One-line hint for the offline tray. */
export function offlineWorkflowHint() {
  return [
    "Cloud = server library after EPUB upload.",
    "Install for offline = copy into this browser for fast offline play.",
    "Export .vaepack = durable file (save to iOS Files); Import restores after an app data wipe.",
  ].join(" ");
}
