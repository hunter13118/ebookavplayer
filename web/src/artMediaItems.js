/** Build selectable art targets from a compiled playback book. */
export function listArtMediaItems(book) {
  const items = [];
  if (!book) return items;

  items.push({
    key: "cover",
    kind: "cover",
    id: "cover",
    label: "Cover",
    preview: book.cover || null,
  });

  Object.entries(book.characters || {})
    .filter(([id]) => id !== "narrator")
    .forEach(([id, c]) => {
      items.push({
        key: `char:${id}`,
        kind: "characters",
        id,
        label: c.name || id,
        preview: c.sprite || null,
      });
    });

  (book.scenes || []).forEach((s) => {
    items.push({
      key: `bg:${s.id}`,
      kind: "backgrounds",
      id: s.id,
      label: s.title || s.location || s.id,
      preview: s.background || null,
    });
  });

  return items;
}

/** Map UI selection keys → generate-media request body. */
export function selectionToGenerateBody(selectedKeys, items) {
  const keys = new Set(selectedKeys);
  const picked = items.filter((it) => keys.has(it.key));
  if (!picked.length) throw new Error("Select at least one image to replace.");

  const all = picked.length === items.length;
  if (all) return { scope: "all", force_all: true };

  const includeCover = picked.some((it) => it.kind === "cover");
  const characterIds = picked.filter((it) => it.kind === "characters").map((it) => it.id);
  const sceneIds = picked.filter((it) => it.kind === "backgrounds").map((it) => it.id);

  return {
    scope: "selected",
    force_all: true,
    include_cover: includeCover,
    character_ids: characterIds.length ? characterIds : null,
    scene_ids: sceneIds.length ? sceneIds : null,
  };
}
