import { useEffect, useMemo, useRef, useState } from "react";
import BookCard from "./BookCard.jsx";
import AddBookSheet from "./AddBookSheet.jsx";
import BannerStack from "./BannerStack.jsx";
import CollapsibleSection from "./CollapsibleSection.jsx";
import { bannersFromCatalog } from "../banners.js";
import {
  fetchCatalog, backendConfigured, subscribeJobEvents, jobEventToStatus, cancelProcessing,
} from "../api.js";
import {
  fetchCatalogMerged, importOfflinePackFiles, scanLinkedPackFolder, getLinkedFolderInfo,
  ensureBookCached, exportBookPackFile, removeLocalPack,
} from "../offline/bookSource.js";
import { isPackArchiveName } from "../offline/packIo.js";
import IngestActivity from "./IngestActivity.jsx";
import { mergeCatalogEntries, mergeCatalogsBySource } from "../library/mergeCatalogs.js";
import {
  CONNECTION_CHANGE_EVENT, SERVER_ID, listConnections,
} from "../backends/connections.js";
import { HEALTH_CHANGE_EVENT, getHealthSnapshot } from "../backends/health.js";
import { defaultCollapsed } from "../library/librarySections.js";
import {
  getShelves, getSortMode, setSortMode, filterByShelf, sortLibraryItems,
  ALL_SHELF_ID, SORT_TITLE, SORT_AUTHOR, SORT_RECENT, SORT_PROGRESS,
} from "../library/libraryShelves.js";

export default function Library({
  catalog, onOpen, onCatalog, offline, serverOnline, onOpenSettings, cacheBusy, onContinueExtraction,
}) {
  const [items, setItems] = useState(catalog || []);
  const [connections, setConnections] = useState(() => listConnections());
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
  const pendingJobsRef = useRef(pendingJobs);
  useEffect(() => { pendingJobsRef.current = pendingJobs; }, [pendingJobs]);
  const shelves = useMemo(() => getShelves(), [items.length]);

  useEffect(() => {
    const syncConnections = () => setConnections(listConnections());
    window.addEventListener(CONNECTION_CHANGE_EVENT, syncConnections);
    window.addEventListener(HEALTH_CHANGE_EVENT, syncConnections);
    return () => {
      window.removeEventListener(CONNECTION_CHANGE_EVENT, syncConnections);
      window.removeEventListener(HEALTH_CHANGE_EVENT, syncConnections);
    };
  }, []);

  // Remote backends only ever join the library after their own successful health
  // handshake — an untunneled/asleep remote simply has no section, not a broken one.
  const reachableRemotes = useMemo(
    () => connections.filter((c) => c.kind === "remote" && getHealthSnapshot(c.id).status === "online"),
    [connections],
  );

  useEffect(() => {
    setItems(mergeCatalogEntries(catalog, pendingJobs));
  }, [catalog, pendingJobs]);

  const displayed = useMemo(() => {
    const filtered = filterByShelf(items, activeShelf);
    return sortLibraryItems(filtered, sortMode);
  }, [items, activeShelf, sortMode]);

  // Group into one section per backend connection — only rendered as separate,
  // collapsible sections when 2+ backends actually contributed books; a single
  // reachable backend (the common case) renders as today's flat grid.
  const sectionGroups = useMemo(() => {
    const byConn = new Map();
    for (const b of displayed) {
      const cid = b.connection_id || SERVER_ID;
      if (!byConn.has(cid)) byConn.set(cid, []);
      byConn.get(cid).push(b);
    }
    const order = [SERVER_ID, ...connections.filter((c) => c.kind === "remote").map((c) => c.id)];
    const groups = [];
    for (const cid of order) {
      if (byConn.has(cid)) { groups.push({ id: cid, entries: byConn.get(cid) }); byConn.delete(cid); }
    }
    for (const [cid, entries] of byConn) groups.push({ id: cid, entries });
    return groups;
  }, [displayed, connections]);

  const showSections = activeShelf === ALL_SHELF_ID && sectionGroups.length > 1;

  // Any book with an active job (imaging, re-extract, continue-extract —
  // not just this session's own uploads) so the library-wide processing
  // panel reflects work happening from any source, not only pendingJobs.
  const catalogActiveJobs = useMemo(() => (catalog || [])
    .filter((b) => b.active_job_id && b.status !== "ready" && b.status !== "error")
    .map((b) => ({
      book_id: b.book_id,
      job_id: b.active_job_id,
      title: b.title || b.book_id,
      author: b.author || "",
      status: b.status || "processing",
      stage: b.stage || "processing",
      progress: b.progress ?? 0,
      cover: b.cover || null,
      scenes: b.scenes || 0,
    })), [catalog]);

  const ingestActivityJobs = useMemo(() => {
    const byJobId = new Map();
    for (const j of catalogActiveJobs) byJobId.set(j.job_id, j);
    for (const j of pendingJobs) byJobId.set(j.job_id, j);
    return [...byJobId.values()];
  }, [catalogActiveJobs, pendingJobs]);

  const jobWatchKey = useMemo(() => {
    return (catalog || [])
      .filter((b) => {
        const jobId = b.active_job_id || b.job_id;
        return jobId && b.status !== "ready" && b.status !== "error" && b.active_job_id;
      })
      .map((b) => `${b.book_id}:${b.active_job_id}`)
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

  function handleStarted(res, file, connectionId) {
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
      connection_id: connectionId || SERVER_ID,
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

  // One catalog fetch per reachable backend (server always attempted; a remote only
  // once its own health handshake is online) — combined via mergeCatalogsBySource so
  // each entry carries which connection it came from.
  //
  // nextPending/list are derived from pendingJobsRef (a plain snapshot), then each
  // setState is called independently at the top level — NOT nested inside another
  // setState's functional updater. Nesting setItems/onCatalog (which updates the
  // parent App's state) inside setPendingJobs's updater is what previously triggered
  // React's "Cannot update a component while rendering a different component"
  // warning (React treats updater-function execution as happening during render).
  async function refreshCatalog() {
    const serverConn = connections.find((c) => c.id === SERVER_ID) || { id: SERVER_ID, kind: "server" };
    const results = await Promise.allSettled([
      fetchCatalogMerged().then((entries) => ({ connection: serverConn, entries })),
      ...reachableRemotes.map((c) => fetchCatalog(c).then((entries) => ({ connection: c, entries }))),
    ]);
    const sources = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
    if (!sources.length) return;
    const combined = mergeCatalogsBySource(sources);
    const nextPending = pendingJobsRef.current.filter((j) => {
      const hit = combined.find((b) => b.book_id === j.book_id);
      return !(hit && (hit.status === "ready" || hit.status === "error"));
    });
    const list = mergeCatalogEntries(combined, nextPending);
    setPendingJobs(nextPending);
    setItems(list);
    onCatalog?.(list);
  }

  const needsCatalogPoll = useMemo(
    () => items.some((b) => b.status === "processing" || pendingJobs.some((j) => j.book_id === b.book_id)),
    [items, pendingJobs],
  );

  useEffect(() => {
    if (offline || !backendConfigured() || !needsCatalogPoll || jobWatchKey) return undefined;
    const id = setInterval(() => { refreshCatalog(); }, 2000);
    refreshCatalog();
    return () => clearInterval(id);
  }, [offline, needsCatalogPoll, jobWatchKey]);

  // A remote backend joining the reachable set (tunnel woke up) changes which
  // sections should exist — re-fetch to pick that up. Gated on reachableRemotes
  // actually being non-empty (not a "have we mounted before" ref — that pattern
  // is fragile under React StrictMode's intentional double-effect-invoke: the
  // ref flips true on the throwaway first pass, so the real pass sees it
  // already true and fires anyway, adding a stray extra /books fetch). The
  // common zero-remotes case now costs nothing, on any render count.
  const remoteIdsKey = useMemo(() => reachableRemotes.map((c) => c.id).sort().join("|"), [reachableRemotes]);
  useEffect(() => {
    if (!reachableRemotes.length) return;
    if (offline || !backendConfigured()) return;
    refreshCatalog();
  }, [offline, remoteIdsKey]);

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
      } else if (action === "cancel") {
        for (const id of ids) await cancelProcessing(id);
        await refreshCatalog();
        setBulkMsg(`Cancelled processing for ${ids.length} book(s).`);
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

  function renderCard(b) {
    return (
      <BookCard
        key={b.book_id}
        entry={b}
        onOpen={handleCardOpen}
        onContinueExtraction={onContinueExtraction}
        selectMode={selectMode}
        selected={selected.has(b.book_id)}
        caching={cacheBusy === b.book_id}
        connections={connections}
      />
    );
  }

  const banners = bannersFromCatalog(items);
  // Not just status === "processing": an offline-pack merge (bookSource.js's
  // mergeCatalog) overwrites status to "ready" for any book with a locally
  // cached copy, even while the cloud side is still mid-extraction.
  // active_job_id survives that merge untouched and (unlike job_id, which is
  // set once at job creation and never cleared) is nulled out on completion
  // by the pipeline — so it's the reliable "still actually active" tell.
  const selectedProcessingCount = items.filter(
    (b) => selected.has(b.book_id) && (b.status === "processing" || b.active_job_id),
  ).length;

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
        <label className="vae-lib-sort vae-select-wrap">
          <span className="vae-sr-only">Sort</span>
          <select className="vae-select" data-testid="library-sort" value={sortMode}
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
          <button type="button" className="vae-btn vae-btn-sm vae-btn-muted"
            disabled={bulkBusy || !selectedProcessingCount}
            data-testid="bulk-cancel-processing"
            title={selectedProcessingCount
              ? "Stop treating stuck/in-progress extraction as active — resumable if any chapters finished"
              : "Select a book that's currently processing to cancel it"}
            onClick={() => {
              if (!confirm(`Cancel processing for ${selectedProcessingCount} book(s)? Any chapters already extracted are kept — you can resume later.`)) return;
              runBulk("cancel");
            }}>
            Cancel processing{selectedProcessingCount ? ` (${selectedProcessingCount})` : ""}
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
      <IngestActivity jobs={ingestActivityJobs} onDone={handleJobDone} />

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
        : showSections
          ? sectionGroups.map((g) => {
            const conn = connections.find((c) => c.id === g.id);
            return (
              <CollapsibleSection
                key={g.id}
                id={g.id}
                title={conn?.label || g.id}
                count={g.entries.length}
                defaultCollapsed={defaultCollapsed(sectionGroups.length, g.entries.length)}
              >
                <div className="vae-grid vae-grid-ibooks" data-testid="book-grid">
                  {g.entries.map(renderCard)}
                </div>
              </CollapsibleSection>
            );
          })
          : (
            <div className="vae-grid vae-grid-ibooks" data-testid="book-grid">
              {displayed.map(renderCard)}
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