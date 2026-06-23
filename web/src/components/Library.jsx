import { useEffect, useRef, useState } from "react";
import BookCard from "./BookCard.jsx";
import Uploader from "./Uploader.jsx";
import BannerStack from "./BannerStack.jsx";
import OfflinePackTray from "./OfflinePackTray.jsx";
import { bannersFromCatalog } from "../banners.js";
import { fetchCatalog, backendConfigured } from "../api.js";
import {
  fetchCatalogMerged, importOfflinePackFiles, scanLinkedPackFolder, getLinkedFolderInfo,
} from "../offline/bookSource.js";
import { isPackArchiveName } from "../offline/packIo.js";
import { getInstalledPackForBook } from "../offline/packStore.js";
import IngestActivity, { mergeCatalogEntries } from "./IngestActivity.jsx";

export default function Library({ catalog, onOpen, onCatalog, offline, serverOnline }) {
  const [items, setItems] = useState(catalog || []);
  const [packBook, setPackBook] = useState(null);
  const [installedPack, setInstalledPack] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [dropMsg, setDropMsg] = useState("");
  const [pendingJobs, setPendingJobs] = useState([]);
  const pollRef = useRef(null);
  const folderScanRef = useRef(false);

  useEffect(() => {
    setItems(mergeCatalogEntries(catalog, pendingJobs));
  }, [catalog, pendingJobs]);

  const anyProcessing = items.some(
    (b) => b.status === "processing" || (b.status !== "error" && b.progress < 1));

  useEffect(() => {
    if (offline || !backendConfigured() || !anyProcessing) return undefined;
    pollRef.current = setInterval(async () => {
      try {
        const list = mergeCatalogEntries(await fetchCatalogMerged(), pendingJobs);
        setItems(list);
        onCatalog?.(list);
      } catch { /* keep last good list */ }
    }, 1500);
    return () => clearInterval(pollRef.current);
  }, [offline, anyProcessing, pendingJobs, onCatalog]);

  useEffect(() => {
    if (!packBook?.book_id) { setInstalledPack(null); return undefined; }
    let alive = true;
    (async () => {
      const p = await getInstalledPackForBook(packBook.book_id);
      if (alive) setInstalledPack(p);
    })();
    return () => { alive = false; };
  }, [packBook?.book_id]);

  function handleStarted(res, file) {
    const id = res.book_id;
    const entry = {
      book_id: id,
      job_id: res.job_id,
      title: file.name.replace(/\.epub$/i, ""),
      author: "",
      status: "processing",
      stage: "queued",
      progress: 0,
      cover: null,
      scenes: 0,
    };
    setPendingJobs((prev) => prev.some((j) => j.job_id === res.job_id)
      ? prev
      : [...prev, entry]);
    setItems((prev) => mergeCatalogEntries(prev, [entry]));
  }

  function handleJobDone(bookId) {
    setPendingJobs((prev) => prev.filter((j) => j.book_id !== bookId));
    refreshCatalog();
  }

  async function refreshCatalog() {
    try {
      const list = mergeCatalogEntries(await fetchCatalogMerged(), pendingJobs);
      setItems(list);
      onCatalog?.(list);
    } catch {
      try {
        const list = mergeCatalogEntries(await fetchCatalog(), pendingJobs);
        setItems(list);
        onCatalog?.(list);
      } catch { /* ignore */ }
    }
  }

  useEffect(() => {
    if (folderScanRef.current) return undefined;
    folderScanRef.current = true;
    let alive = true;
    (async () => {
      const linked = await getLinkedFolderInfo();
      if (!linked || !alive) return;
      try {
        const results = await scanLinkedPackFolder({ force: false });
        if (results.imported.length && alive) {
          await refreshCatalog();
          setDropMsg(`Imported ${results.imported.length} pack(s) from "${results.folderName}".`);
        }
      } catch { /* folder permission or unavailable */ }
    })();
    return () => { alive = false; };
  }, []);

  async function handleLibraryDrop(ev) {
    ev.preventDefault();
    setDragOver(false);
    const files = [...(ev.dataTransfer?.files || [])].filter((f) => isPackArchiveName(f.name));
    if (!files.length) {
      setDropMsg("Drop .vaepack or .zip files to import.");
      return;
    }
    try {
      const results = await importOfflinePackFiles(files);
      if (results.imported.length) await refreshCatalog();
      setDropMsg(results.imported.length
        ? `Imported ${results.imported.length} offline pack(s).`
        : "No packs imported.");
    } catch (e) {
      setDropMsg(e.message || "Import failed.");
    }
  }

  return (
    <div
      className={`vae-library${dragOver ? " vae-drop-active" : ""}`}
      data-testid="library"
      onDragOver={(ev) => { ev.preventDefault(); setDragOver(true); }}
      onDragLeave={(ev) => {
        if (ev.currentTarget.contains(ev.relatedTarget)) return;
        setDragOver(false);
      }}
      onDrop={handleLibraryDrop}
    >
      <BannerStack banners={bannersFromCatalog(items)} bookId="library" />
      <IngestActivity jobs={pendingJobs} onDone={handleJobDone} />
      <h2 className="vae-lib-heading">Your library</h2>
      {dropMsg && <div className="vae-offline-msg" data-testid="library-drop-msg">{dropMsg}</div>}
      {dragOver && (
        <div className="vae-drop-overlay vae-drop-overlay-library" data-testid="library-drop-overlay">
          Drop .vaepack files to add to your library
        </div>
      )}
      {items.length === 0
        ? <div className="vae-lib-empty" data-testid="library-empty">
            No books yet. Add an EPUB below or import an offline pack.
          </div>
        : <div className="vae-grid" data-testid="book-grid">
            {items.map((b) => (
              <BookCard key={b.book_id} entry={b} onOpen={onOpen}
                onOffline={(entry) => setPackBook(entry)} />
            ))}
          </div>}

      <OfflinePackTray
        bookId={packBook?.book_id}
        title={packBook?.title}
        installedPack={installedPack}
        onCatalogRefresh={refreshCatalog}
        onInstalled={async () => {
          await refreshCatalog();
          if (packBook?.book_id) {
            setInstalledPack(await getInstalledPackForBook(packBook.book_id));
          }
        }}
      />

      {serverOnline !== false && (
        <>
          <h2 className="vae-lib-heading" style={{ marginTop: "1.5rem" }}>Add to library</h2>
          <Uploader onStarted={handleStarted} />
        </>
      )}
    </div>
  );
}
