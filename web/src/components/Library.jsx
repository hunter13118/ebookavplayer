import { useEffect, useRef, useState } from "react";
import BookCard from "./BookCard.jsx";
import Uploader from "./Uploader.jsx";
import BannerStack from "./BannerStack.jsx";
import { bannersFromCatalog } from "../banners.js";
import { fetchCatalog, backendConfigured } from "../api.js";

// Landing view: a grid library on top, the upload tray below. While anything
// is processing, it polls the catalog so progress/cover update live and a
// finished book swaps from spinner to thumbnail without a manual refresh.
export default function Library({ catalog, onOpen, onCatalog, offline }) {
  const [items, setItems] = useState(catalog || []);
  const pollRef = useRef(null);

  useEffect(() => { setItems(catalog || []); }, [catalog]);

  const anyProcessing = items.some(
    (b) => b.status === "processing" || (b.status !== "error" && b.progress < 1));

  useEffect(() => {
    if (offline || !backendConfigured() || !anyProcessing) return undefined;
    pollRef.current = setInterval(async () => {
      try {
        const list = await fetchCatalog();
        setItems(list);
        onCatalog?.(list);
      } catch { /* keep last good list */ }
    }, 1500);
    return () => clearInterval(pollRef.current);
  }, [offline, anyProcessing]);

  // Optimistically insert a processing placeholder the moment an upload starts.
  function handleStarted(res, file) {
    const id = res.book_id;
    setItems((prev) => prev.some((b) => b.book_id === id) ? prev : [
      { book_id: id, title: file.name.replace(/\.epub$/i, ""), author: "",
        status: "processing", stage: "queued", progress: 0, cover: null, scenes: 0 },
      ...prev,
    ]);
  }

  return (
    <div className="vae-library" data-testid="library">
      <BannerStack banners={bannersFromCatalog(items)} bookId="library" />
      <h2 className="vae-lib-heading">Your library</h2>
      {items.length === 0
        ? <div className="vae-lib-empty" data-testid="library-empty">
            No books yet. Add an EPUB below to get started.
          </div>
        : <div className="vae-grid" data-testid="book-grid">
            {items.map((b) => <BookCard key={b.book_id} entry={b} onOpen={onOpen} />)}
          </div>}

      <h2 className="vae-lib-heading" style={{ marginTop: "1.5rem" }}>Add to library</h2>
      <Uploader onStarted={handleStarted} />
    </div>
  );
}
