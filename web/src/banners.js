/** Collect banners from catalog entries (processing books). */
export function bannersFromCatalog(items) {
  const out = [];
  (items || []).forEach((b) => {
    (b.banners || []).forEach((banner) => {
      out.push({ ...banner, book_id: b.book_id, book_title: b.title });
    });
  });
  return out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
}
