/** Human label for a regen job (banner copy). */
export function summarizeRegenTarget({ count, label, labels } = {}) {
  if (count === 1 && label) return label;
  if (count > 1) return `${count} images`;
  if (labels?.length === 1) return labels[0];
  if (labels?.length > 1) return `${labels.length} images`;
  return "images";
}

/** Build regen meta from replace-art picker selection. */
export function summarizeArtSelection(selectedKeys, items) {
  const keys = new Set(selectedKeys);
  const picked = items.filter((it) => keys.has(it.key));
  return {
    count: picked.length,
    label: picked.length === 1 ? picked[0].label : null,
    labels: picked.map((p) => p.label),
  };
}
