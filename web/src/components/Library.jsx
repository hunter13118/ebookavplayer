import { useEffect, useMemo, useRef, useState } from "react";
import BookCard from "./BookCard.jsx";
import AddBookSheet from "./AddBookSheet.jsx";
import BannerStack from "./BannerStack.jsx";
import { bannersFromCatalog } from "../banners.js";
import { fetchCatalog, backendConfigured, subscribeJobEvents, jobEventToStatus } from "../api.js";
import {
  fetchCatalogMerged, importOfflinePackFiles, scanLinkedPackFolder, getLinkedFolderInfo,
  ensureBookCached, exportBookPackFile, removeLocalPack,
} from "../offline/bookSource.js";
import { isPackArchiveName } from "../offline/packIo.js";
import IngestActivity, { mergeCatalogEntries } from "./IngestActivity.jsx";
import {
  getShelves, getSortMode, setSortMode, filterByShelf, sortLibraryItems,
  ALL_SHELF_ID, SORT_TITLE, SORT_AUTHOR, SORT_RECENT, SORT_PROGRESS,
} from "../library/libraryShelves.js";

export default function Library({
  catalog, onOpen, onCatalog, offline, serverOnline, onOpenSettings, cacheBusy,
}) {
  const [items, setItems] = useState(catalog || []);
  const [dragOver, setDragOver] = useState(false);
  const [dropMsg, setDropMsg] = useState("");
  const [pendingJobs, setPendingJobs] = useState([]);
  const [addOpen, setAddOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [activeShelf, setActiveShelf] = useState(ALL_SHELF_ID);
  const [sortMode, setSortModeState] = useState(getSortMode);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState("");
  const folderScanRef = useRef(false);
  const shelves = useMemo(() => getShelves(), [items.length]);

  useEffect(() => {
    setItems(mergeCatalogEntries(catalog, pendingJobs));
  }, [catalog, pendingJobs]);

  const displayed = useMemo(() => {
    const filtered = filterByShelf(items, activeShelf);
    return sortLibraryItems(filtered, sortMode);
  }, [items, activeShelf, sortMode]);

  const jobWatchKey = useMemo(() => {
    return (catalog || [])
      .filter((b) => {
        const jobId = b.active_job_id || b.job_id;
        return jobId && b.status !== "ready" && b.status !== "error";
      })
      .map((b) => `${b.book_id}:${b.active_job_id || b.job_id}`)
      .sort()
      .join("|");
  }, [catalog]);

  useEffect(() => {
    if (offline || !backendConfigured() || !jobWatchKey) return undefined;
    const watches = jobWatchKey.split("|").map((pair) => {
      const [bookId, jobId] = pair.split(":");
      return { bookId, jobId };
    });
    const unsubs = watches.map(({ bookId, jobId }) => subscribeJobEvents(jobId, {
      onEvent: (ev) => {
        const st = jobEventToStatus(ev);
        const done = ev.type === "done" || ev.type === "error"
          || st.status === "done" || st.status === "error";
        setItems((prev) => prev.map((b) => {
          if (b.book_id !== bookId) return b;
          return {
            ...b,
            progress: st.progress ?? b.progress,
            stage: st.stage || b.stage,
            status: st.status || b.status,
            detail: st.detail || b.detail,
            phase: st.phase ?? b.phase,
            phase_label: st.phase_label || b.phase_label,
            step_index: st.step_index ?? b.step_index,
            step_total: st.step_total ?? b.step_total,
          };
        }));
        if (done) handleJobDone(bookId);
      },
    }));
    return () => { for (const u of unsubs) u(); };
  }, [offline, jobWatchKey]);

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
      const remote = await fetchCatalogMerged();
      setPendingJobs((prev) => {
        const nextPending = prev.filter((j) => {
          const hit = remote.find((b) => b.book_id === j.book_id);
          return !(hit && (hit.status === "ready" || hit.status === "error"));
        });
        const list = mergeCatalogEntries(remote, nextPending);
        setItems(list);
        onCatalog?.(list);
        return nextPending;
      });
    } catch {
      try {
        const remote = await fetchCatalog();
        setPendingJobs((prev) => {
          const nextPending = prev.filter((j) => {
            const hit = remote.find((b) => b.book_id === j.book_id);
            return !(hit && (hit.status === "ready" || hit.status === "error"));
          });
          const list = mergeCatalogEntries(remote, nextPending);
          setItems(list);
          onCatalog?.(list);
          return nextPending;
        });
      } catch { /* ignore */ }
    }
  }

  const needsCatalogPoll = useMemo(
    () => items.some((b) => b.status === "processing" || pendingJobs.some((j) => j.book_id === b.book_id)),
    [items, pendingJobs],
  );

  useEffect(() => {
    if (offline || !backendConfigured() || !needsCatalogPoll) return undefined;
    const id = setInterval(() => { refreshCatalog(); }, 2000);
    refreshCatalog();
    return () => clearInterval(id);
  }, [offline, needsCatalogPoll]);

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

  function toggleSelect(bookId) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(bookId)) next.delete(bookId);
      else next.add(bookId);
      return next;
    });
  }

  function exitSelectMode(clearMsg = true) {
    setSelectMode(false);
    setSelected(new Set());
    if (clearMsg) setBulkMsg("");
  }

  async function runBulk(action) {
    const ids = [...selected];
    if (!ids.length) return;
    setBulkBusy(true);
    setBulkMsg("");
    try {
      if (action === "download") {
        for (const id of ids) {
          await ensureBookCached(id);
          await exportBookPackFile(id);
        }
        setBulkMsg(`Downloaded ${ids.length} .vaepack file(s).`);
      } else if (action === "remove") {
        for (const id of ids) await removeLocalPack(id);
        await refreshCatalog();
        setBulkMsg(`Removed ${ids.length} from this device.`);
      } else if (action === "offload") {
        for (const id of ids) await removeLocalPack(id);
        await refreshCatalog();
        setBulkMsg(`Offloaded ${ids.length} to cloud-only (local copy removed).`);
      }
      exitSelectMode(false);
    } catch (e) {
      setBulkMsg(e.message || "Action failed.");
    } finally {
      setBulkBusy(false);
    }
  }

  function handleCardOpen(entry) {
    if (selectMode) {
      toggleSelect(entry.book_id);
      return;
    }
    onOpen(entry);
  }

  const banners = bannersFromCatalog(items);

  return (
    <div
      className={`vae-library vae-library-landing${dragOver ? " vae-drop-active" : ""}`}
      data-testid="library"
      onDragOver={(ev) => { ev.preventDefault(); setDragOver(true); }}
      onDragLeave={(ev) => {
        if (ev.currentTarget.contains(ev.relatedTarget)) return;
        setDragOver(false);
      }}
      onDrop={handleLibraryDrop}
    >
      <header className="vae-lib-toolbar" data-testid="library-toolbar">
        <button type="button" className="vae-lib-icon-btn" data-testid="library-select"
          aria-label={selectMode ? "Done selecting" : "Select books"}
          onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}>
          {selectMode ? "Done" : "⋯"}
        </button>
        <h1 className="vae-lib-title">Library</h1>
        <div className="vae-lib-toolbar-right">
          <button type="button" className="vae-lib-icon-btn vae-lib-add" data-testid="library-add"
            aria-label="Add book" onClick={() => setAddOpen(true)}>+</button>
          <button type="button" className="vae-lib-icon-btn" data-testid="open-settings"
            aria-label="Settings" onClick={onOpenSettings}>☰</button>
        </div>
      </header>

      <div className="vae-lib-shelf-bar" data-testid="library-shelves">
        {shelves.map((s) => (
          <button key={s.id} type="button"
            className={`vae-shelf-tab${activeShelf === s.id ? " vae-shelf-tab-active" : ""}`}
            data-shelf={s.id}
            onClick={() => setActiveShelf(s.id)}>
            {s.name}
          </button>
        ))}
        <label className="vae-lib-sort">
          <span className="vae-sr-only">Sort</span>
          <select data-testid="library-sort" value={sortMode}
            onChange={(e) => { setSortMode(e.target.value); setSortModeState(e.target.value); }}>
            <option value={SORT_TITLE}>Title</option>
            <option value={SORT_AUTHOR}>Author</option>
            <option value={SORT_RECENT}>Recent</option>
            <option value={SORT_PROGRESS}>Progress</option>
          </select>
        </label>
      </div>

      {selectMode && (
        <div className="vae-lib-select-bar" data-testid="library-select-bar">
          <span>{selected.size} selected</span>
          <button type="button" className="vae-btn vae-btn-sm" disabled={bulkBusy || !selected.size}
            data-testid="bulk-download" onClick={() => runBulk("download")}>
            Download
          </button>
          <button type="button" className="vae-btn vae-btn-sm vae-btn-muted" disabled={bulkBusy || !selected.size}
            data-testid="bulk-offload" onClick={() => runBulk("offload")}>
            Offload
          </button>
          <button type="button" className="vae-btn vae-btn-sm vae-btn-muted" disabled={bulkBusy || !selected.size}
            data-testid="bulk-remove" onClick={() => runBulk("remove")}>
            Remove local
          </button>
        </div>
      )}

      {(dropMsg || bulkMsg) && (
        <div className="vae-lib-toast" data-testid="library-toast">{bulkMsg || dropMsg}</div>
      )}

      {cacheBusy && (
        <div className="vae-lib-cache-banner" data-testid="cache-busy">
          Preparing book for offline…
        </div>
      )}

      {banners.length > 0 && <div className="vae-lib-banners"><BannerStack banners={banners} bookId="library" /></div>}
      <IngestActivity jobs={pendingJobs} onDone={handleJobDone} />

      {dragOver && (
        <div className="vae-drop-overlay vae-drop-overlay-library" data-testid="library-drop-overlay">
          Drop .vaepack files to add to your library
        </div>
      )}

      {displayed.length === 0
        ? (
          <div className="vae-lib-empty" data-testid="library-empty">
            <p>No books in this collection.</p>
            <button type="button" className="vae-btn" data-testid="library-empty-add"
              onClick={() => setAddOpen(true)}>Add a book</button>
          </div>
        )
        : (
          <div className="vae-grid vae-grid-ibooks" data-testid="book-grid">
            {displayed.map((b) => (
              <BookCard
                key={b.book_id}
                entry={b}
                onOpen={handleCardOpen}
                selectMode={selectMode}
                selected={selected.has(b.book_id)}
                caching={cacheBusy === b.book_id}
              />
            ))}
          </div>
        )}

      <AddBookSheet
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onStarted={handleStarted}
        onImportPack={async (files) => {
          const results = await importOfflinePackFiles(files);
          if (results.imported.length) await refreshCatalog();
          setDropMsg(results.imported.length
            ? `Imported ${results.imported.length} pack(s).`
            : "No packs imported.");
          setAddOpen(false);
        }}
      />

      <div className="vae-sr-only" aria-hidden data-testid="offline-pack-tray" />
    </div>
  );
}