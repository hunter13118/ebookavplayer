/** Track which art slots have user/generated /media/ assets vs placeholders. */

export function artSlotHasMedia(preview) {
  const t = String(preview || "");
  if (!t) return false;
  if (t.startsWith("/media/")) return true;
  if (/^https?:\/\//i.test(t) && t.includes("/media/")) return true;
  return false;
}

/** @returns {{ filled: number, total: number, items: Array<{ key: string, filled: boolean }> }} */
export function summarizeArtChecklist(items) {
  const rows = (items || []).map((it) => ({
    key: it.key,
    filled: artSlotHasMedia(it.preview),
  }));
  const filled = rows.filter((r) => r.filled).length;
  return { filled, total: rows.length, items: rows };
}

export function artChecklistByKey(checklist) {
  return Object.fromEntries((checklist?.items || []).map((r) => [r.key, r.filled]));
}
