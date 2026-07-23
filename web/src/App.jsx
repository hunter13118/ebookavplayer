import { useEffect, useRef, useState } from "react";

import { AuthGate } from "./lib/portfolioAuth.jsx";

import Library from "./components/Library.jsx";
import SimpleLibrary from "./components/SimpleLibrary.jsx";
import SimpleDownloadsSheet from "./components/SimpleDownloadsSheet.jsx";
import AddBookSheet from "./components/AddBookSheet.jsx";
import SimpleSettingsSheet from "./components/SimpleSettingsSheet.jsx";

import Player from "./components/Player.jsx";

import PipelineSheet from "./components/PipelineSheet.jsx";

import GlobalSettingsSheet from "./components/GlobalSettingsSheet.jsx";
import DownloadRecommendModal from "./components/DownloadRecommendModal.jsx";
import { CompareModalProvider } from "./hooks/compareModalContext.jsx";

import { KEYS, getPrefs, setPref } from "./audio/voicePrefs.js";

import {
  backendConfigured, fetchCatalog, continueExtraction, ingestBookText, ingestBook, renameBook,
} from "./api.js";
import { getConnection, setActiveConnectionId } from "./backends/connections.js";
import { startHealthPolling } from "./backends/health.js";

import {
  fetchBook, fetchCatalogMerged, fetchLocalCatalog, mergeCatalog, ensureBookCached, exportBookPackFile,
  pickPackSaveHandle, needsOfflineCache, importOfflinePackFiles,
} from "./offline/bookSource.js";
import { shouldRecommendDownload, skipDownloadRecommend } from "./offline/downloadRecommend.js";
import {
  installM4bFirstBook, appendM4bFirstLines, markM4bFirstTranscriptComplete,
  bookIdFromFilename, titleFromFilename, checkpointM4bFirstProgress, resumeM4bFirstPoint,
  m4bFirstTranscriptText,
} from "./offline/m4bFirstBooks.js";
import { transcribeM4b } from "./timing/transcribeClient.js";
import { loadM4b, storeM4b } from "./offline/m4bStore.js";

import { sampleBook } from "./sampleBook.js";

function sampleCatalog() {
  const lines = (sampleBook.scenes || []).reduce((n, s) => n + s.lines.length, 0);
  return [{
    book_id: sampleBook.book_id, title: sampleBook.title, author: sampleBook.author,
    status: "ready", stage: "done", progress: 1, cover: null,
    scenes: sampleBook.scenes.length, lines,
    server_available: false,
  }];
}

export default function App() {
  const [prefs, setPrefs] = useState(getPrefs());
  const [view, setView] = useState("library");
  const [catalog, setCatalog] = useState([]);
  const [book, setBook] = useState(null);
  const [serverOnline, setServerOnline] = useState(true);
  const [note, setNote] = useState("");
  const [pipelineOpen, setPipelineOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [simpleSettingsOpen, setSimpleSettingsOpen] = useState(false);
  const [simpleAddOpen, setSimpleAddOpen] = useState(false);
  const [simpleDownloadsOpen, setSimpleDownloadsOpen] = useState(false);
  const [cacheBusy, setCacheBusy] = useState(null);
  const [downloadModal, setDownloadModal] = useState(null);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [m4bUpload, setM4bUpload] = useState({ busy: false, detail: "", error: "" });
  const [epubUpload, setEpubUpload] = useState({ busy: false, fileName: "", error: "" });
  // Tracks which book is actually on screen right now, readable from inside
  // the long-lived async upload flow below without capturing a stale
  // closure over `book` — a plain useEffect-synced ref, not state, since
  // nothing needs to re-render when it changes.
  const openBookIdRef = useRef(null);
  useEffect(() => {
    openBookIdRef.current = view === "player" ? book?.book_id || null : null;
  }, [view, book?.book_id]);

  useEffect(() => { document.documentElement.dataset.theme = prefs.theme; }, [prefs.theme]);
  useEffect(() => { document.documentElement.dataset.ui = prefs.uiMode; }, [prefs.uiMode]);
  // Standalone (home-screen-installed) PWA detection. The safe-area padding
  // itself (styles.css's --safe-* vars) is self-adjusting via env() and
  // needs no JS — this attribute is for anything that genuinely needs to
  // branch on standalone vs. browser-tab (currently unused, but cheap and
  // matches this file's existing dataset-flag convention). iOS reports it
  // via the non-standard navigator.standalone; everything else (incl.
  // Android's installed-PWA mode) via the Display Mode Web API media query.
  useEffect(() => {
    const mq = window.matchMedia("(display-mode: standalone)");
    const update = () => {
      document.documentElement.dataset.standalone = String(mq.matches || window.navigator.standalone === true);
    };
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    document.documentElement.style.setProperty("--simple-font-scale", String(prefs.simpleFontScale || 1));
  }, [prefs.simpleFontScale]);

  useEffect(() => startHealthPolling(), []);

  useEffect(() => {
    const m = window.location.hash.match(/^#\/book\/([^/?]+)/);
    if (!m) return undefined;
    let alive = true;
    (async () => {
      try {
        const bookId = decodeURIComponent(m[1]);
        const full = await fetchBook(bookId);
        if (!alive) return;
        setBook(full);
        setView("player");
        // A page refresh lands here, NOT in enterPlayer() — without this, a
        // still-"transcribing" M4B-first book restored from the URL hash
        // would just sit stalled forever instead of picking back up (see
        // the identical check in enterPlayer).
        if (full.m4b_first_status === "transcribing") {
          resumeM4bFirstTranscription(bookId, full.title).catch(() => {});
        }
      } catch {
        /* hash restore optional — user can open from library */
      }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const server = await fetchCatalog();
        if (!alive) return;
        setServerOnline(true);
        setNote("");
        setCatalog(await mergeCatalog(server));
      } catch {
        if (!alive) return;
        const local = await fetchLocalCatalog().catch(() => []);
        if (local.length) {
          setServerOnline(false);
          setCatalog(local);
          setNote(prefs.uiMode === "simple"
            ? "You're offline right now. You can still open books you've already added."
            : "Server unreachable — showing locally installed offline packs.");
          return;
        }
        if (!backendConfigured()) {
          setServerOnline(false);
          setCatalog(sampleCatalog());
          setNote(prefs.uiMode === "simple"
            ? "You're offline right now. You can still open books you've already added."
            : "No backend — embedded demo only. Import an offline pack or connect the server.");
          return;
        }
        setServerOnline(false);
        setCatalog(sampleCatalog());
        setNote(prefs.uiMode === "simple"
          ? "Can't reach your books right now. Check your internet and try again."
          : "Backend unreachable — embedded demo. Import an offline pack for real books.");
      }
    })();
    return () => { alive = false; };
  }, []);

  // Owns the actual ingestBook() POST + its busy/error state for Simple
  // Mode's "Add a book" sheet, so closing the sheet mid-upload (AddBookSheet
  // unmounts Uploader.jsx) can't silently swallow an error or hide progress
  // — same lifted-state pattern as m4bUpload above.
  // POST /ingest returns as soon as the job is QUEUED — the mechanical
  // baseline (what actually makes books/{id}.json exist) writes a moment
  // later, asynchronously, inside the queue consumer. Bounded retry instead
  // of a single immediate fetchBook, so "land in the reader almost
  // instantly" doesn't race a book that technically doesn't exist yet.
  async function waitForBookReady(bookId, { attempts = 8, delayMs = 500 } = {}) {
    for (let i = 0; i < attempts; i += 1) {
      try {
        await fetchBook(bookId);
        return true;
      } catch {
        if (i === attempts - 1) return false;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => { setTimeout(r, delayMs); });
      }
    }
    return false;
  }

  async function handleEpubUpload(file, opts) {
    setEpubUpload({ busy: true, fileName: file.name, error: "" });
    try {
      const { book_id: bookId } = await ingestBook(file, opts);
      setEpubUpload({ busy: false, fileName: "", error: "" });
      setSimpleAddOpen(false);
      setCatalog(await fetchCatalogMerged().catch(() => catalog));

      // Persist the m4b (if picked alongside the epub) to durable storage
      // RIGHT NOW, keyed by the freshly-minted book_id — not held as a raw
      // in-memory File reference waiting for Player to mount. That used to
      // be a real bug: if this book's queue message sat behind another
      // book's still-running extraction (local dev's "vae-jobs" queue is
      // serialized — see wrangler.toml), waitForBookReady below could time
      // out well before the book was ready, and a plain-React-state handoff
      // to Player either never fired or was silently wiped by any reload in
      // between — the m4b just vanished with no error anywhere. Storing it
      // now means Player's own loadM4b-on-mount effect (see Player.jsx,
      // keyed on bk.book_id) picks it up and computes the timeline itself
      // the moment this book is next opened, however long that takes and
      // regardless of reloads in between.
      if (opts?.m4bFile) await storeM4b(bookId, opts.m4bFile, opts.m4bFile.name).catch(() => {});

      // Land in the reader almost instantly — the mechanical baseline makes
      // a fresh ingest readable within seconds, well before any real
      // enrichment (BookNLP/annotate/LLM) runs. Fall back to just leaving
      // the user in the library (still able to tap in once ready) if the
      // book genuinely never appears within the retry window.
      const ready = await waitForBookReady(bookId);
      if (ready) {
        await enterPlayer({ book_id: bookId, connection_id: opts?.connection?.id });
      } else {
        setNote(opts?.m4bFile
          ? `"${file.name}" is queued — open it from the library once it's ready; the audiobook you added will attach automatically.`
          : `"${file.name}" is queued — open it from the library once it's ready.`);
      }
    } catch (e) {
      setEpubUpload({ busy: false, fileName: "", error: e.message || "Upload failed — is the backend running?" });
    }
  }

  async function enterPlayer(entry) {
    // Point every subsequent single-book API call (voices, media, pipeline…)
    // at the backend this entry actually came from, before fetching it.
    setActiveConnectionId(entry.connection_id || null);
    const full = await fetchBook(entry.book_id);
    // The compiled playback doesn't carry extract_provider/connection_id —
    // only the catalog entry does — so carry them forward for pin-mismatch
    // checks and source-chip display inside the player.
    setBook({ ...full, extract_provider: entry.extract_provider, connection_id: entry.connection_id });
    setView("player");
    window.location.hash = `#/book/${entry.book_id}`;

    // A refresh/crash mid-transcription leaves the local pack stuck at
    // m4b_first_status "transcribing" forever otherwise — pick it back up
    // from its checkpoint the moment the book is reopened.
    if (full.m4b_first_status === "transcribing") {
      resumeM4bFirstTranscription(entry.book_id, full.title).catch(() => {});
    }
  }

  // M4B-first flow (docs/M4B_FIRST_FLOW.md): upload an audiobook directly —
  // no EPUB required. Speech-to-text via the local align server builds a
  // minimal, fully-local book (installM4bFirstBook — a local pack, exactly
  // like an installed .vaepack, just with no server book behind it yet);
  // mergeCatalog() already lists a local-only pack with server_available:
  // false with zero changes needed there, so the book appears in the
  // library and opens through the SAME openBook/enterPlayer path as any
  // other book the instant the first chunk of narration is transcribed —
  // "minimal first." Once the whole transcript is in hand, POST
  // /books/:id/ingest-text kicks off the SAME scenes/characters extraction
  // the EPUB path uses, in the background — "formal extraction after." That
  // job upgrades the SAME book_id server-side; fetchBook() already prefers
  // a matching remote book over the local-pack fallback the moment one
  // exists, so the book graduates to cinematic/spotlight-capable on its own,
  // no merge step needed here.
  // Shared by a fresh upload and a resumed one (after a refresh/crash
  // interrupted transcription) — streams the m4b through the align server,
  // checkpointing both the transcribed lines (appendM4bFirstLines, per
  // chunk that produced lines) AND the raw ASR offset (checkpointM4bFirstProgress,
  // on EVERY chunk including silent ones) so a resume can skip straight past
  // already-transcribed audio instead of re-running WhisperX from 0ms.
  async function runM4bFirstTranscription({ bookId, title, blob, connection, resumeMs = 0, resumeIdx = 0 }) {
    let opened = openBookIdRef.current === bookId;
    const openOnceReady = async () => {
      if (opened) return;
      opened = true;
      setPref(KEYS.viewMode, "reader");
      setPrefs((p) => ({ ...p, viewMode: "reader" }));
      await enterPlayer({ book_id: bookId, server_available: false });
    };

    const result = await transcribeM4b({
      blob, connection, bookId, title, resumeMs, resumeIdx,
      onLinesReady: async (newLines, processedMs, totalMs) => {
        await appendM4bFirstLines(bookId, newLines);
        setM4bUpload({
          busy: true,
          detail: totalMs
            ? `Transcribing… ${Math.round(processedMs / 60000)}/${Math.round(totalMs / 60000)} min`
            : "Transcribing…",
          error: "",
        });
        await openOnceReady();
        // The player for THIS book is already open — push the newly
        // transcribed lines into it live instead of waiting for the user
        // to leave and reopen the book.
        if (openBookIdRef.current === bookId) {
          fetchBook(bookId).then(setBook).catch(() => {});
        }
      },
      // Must RETURN the promise (not fire-and-forget) — transcribeM4b now
      // awaits this before moving to the next streamed row, specifically so
      // this write can't race appendM4bFirstLines's write to the same local
      // pack record (see transcribeClient.js's readNdjson doc comment).
      onProgress: (processedMs) => checkpointM4bFirstProgress(bookId, processedMs).catch(() => {}),
    });

    await markM4bFirstTranscriptComplete(bookId, { durationMs: result.durationMs });
    setM4bUpload({ busy: false, detail: "", error: "" });

    // Formal extraction, in the background — no UI blocking. A failure here
    // is non-fatal: the book stays fully usable as a local M4B-first pack
    // (transcript + real audio), just without scenes/characters yet. Read
    // the FULL saved transcript rather than result.lines — on a resumed run
    // result.lines only covers the tail transcribed THIS call.
    const bodyText = await m4bFirstTranscriptText(bookId);
    try {
      await ingestBookText(bookId, { title, bodyText, artStyle: prefs.artStyle });
    } catch {
      /* the book remains usable; formal extraction can be retried later */
    }
  }

  async function startM4bFirstUpload(file) {
    setM4bUpload({ busy: true, detail: "Preparing…", error: "" });
    try {
      const connection = getConnection(prefs.alignConnectionId);
      if (!connection?.baseUrl) {
        throw new Error(
          "Pick a local align server first — Settings → Backends (the same server WhisperX audiobook sync uses).",
        );
      }

      const bookId = bookIdFromFilename(file.name);
      const title = titleFromFilename(file.name);
      // Don't clobber a partial transcript from an earlier, interrupted run
      // of THIS same file — resume it instead of wiping and starting over.
      const resume = await resumeM4bFirstPoint(bookId);
      if (!resume) await installM4bFirstBook({ bookId, title, blob: file, fileName: file.name });
      setCatalog(await fetchCatalogMerged().catch(() => catalog));

      await runM4bFirstTranscription({
        bookId, title, blob: file, connection,
        resumeMs: resume?.resumeMs || 0, resumeIdx: resume?.resumeIdx || 0,
      });
    } catch (e) {
      setM4bUpload({ busy: false, detail: "", error: e?.message || "Couldn't transcribe that audiobook." });
    }
  }

  // Continue a transcription left mid-way by a page reload/crash — no
  // re-upload needed, the .m4b blob is already in local storage
  // (installM4bFirstBook stored it up front). Fired automatically when a
  // still-"transcribing" M4B-first book is opened (see enterPlayer).
  async function resumeM4bFirstTranscription(bookId, title) {
    if (m4bUpload.busy) return;
    try {
      const resume = await resumeM4bFirstPoint(bookId);
      if (!resume) return;
      const connection = getConnection(prefs.alignConnectionId);
      if (!connection?.baseUrl) return;
      const blob = await loadM4b(bookId);
      if (!blob) return;
      setM4bUpload({ busy: true, detail: "Resuming transcription…", error: "" });
      await runM4bFirstTranscription({
        bookId, title, blob, connection, resumeMs: resume.resumeMs, resumeIdx: resume.resumeIdx,
      });
    } catch (e) {
      setM4bUpload({ busy: false, detail: "", error: e?.message || "Couldn't resume transcription." });
    }
  }

  async function openBook(entry) {
    try {
      if (entry.status === "error") {
        setNote(prefs.uiMode === "simple"
          ? "Something went wrong. Tap to try again."
          : `Ingest failed for "${entry.title || entry.book_id}": ${entry.error || "unknown error"}. Upload the EPUB again.`);
        return;
      }

      const fromCloud = entry.server_available !== false;
      const e2eNoCache = typeof localStorage !== "undefined"
        && localStorage.getItem("vae-e2e") === "1"
        && localStorage.getItem("vae-e2e-cache") !== "1";
      const needsCache = needsOfflineCache(entry, { e2eNoCache });
      let cached = Boolean(entry.offline_pack);

      if (needsCache) {
        setCacheBusy(entry.book_id);
        try {
          await ensureBookCached(entry.book_id);
          cached = true;
          const list = await fetchCatalogMerged();
          setCatalog(list);
        } catch (e) {
          setNote(prefs.uiMode === "simple"
            ? "Something went wrong. Tap to try again."
            : `Couldn't cache "${entry.title}": ${e.message || "unknown error"}`);
          setCacheBusy(null);
          return;
        }
        setCacheBusy(null);
      }

      if (fromCloud && cached && shouldRecommendDownload(entry.book_id)) {
        setDownloadModal(entry);
        return;
      }

      await enterPlayer(entry);
    } catch (e) {
      if (!serverOnline && entry.offline_pack) {
        setNote(prefs.uiMode === "simple"
          ? "Something went wrong. Tap to try again."
          : `Couldn't load offline pack for ${entry.title}.`);
        return;
      }
      if (!serverOnline) {
        setBook(sampleBook);
        setView("player");
        return;
      }
      const processing = entry.status === "processing" || (entry.progress != null && entry.progress < 0.45);
      if (prefs.uiMode === "simple") {
        setNote(processing
          ? "This book is still being prepared. It'll be ready in a few minutes."
          : "Something went wrong. Tap to try again.");
        return;
      }
      setNote(processing
        ? `Still processing "${entry.title}" — see Processing on the library (text ready ~45%).`
        : `Couldn't open ${entry.title}. ${e.message || ""}`.trim());
    }
  }

  async function handleDownloadRecommendSave() {
    if (!downloadModal) return;
    setDownloadBusy(true);
    try {
      let saveHandle = null;
      try {
        saveHandle = await pickPackSaveHandle(downloadModal.book_id);
      } catch (e) {
        if (e?.name === "AbortError") return;
      }
      await exportBookPackFile(downloadModal.book_id, { saveHandle });
      skipDownloadRecommend(downloadModal.book_id);
      const entry = downloadModal;
      setDownloadModal(null);
      await enterPlayer(entry);
    } catch (e) {
      setNote(e.message || "Download failed.");
    } finally {
      setDownloadBusy(false);
    }
  }

  async function handleDownloadRecommendSkip() {
    if (!downloadModal) return;
    skipDownloadRecommend(downloadModal.book_id);
    const entry = downloadModal;
    setDownloadModal(null);
    await enterPlayer(entry);
  }

  async function handleContinueExtraction(entry, preferProvider = "auto") {
    try {
      await continueExtraction(entry.book_id, { preferProvider });
      setNote(`Resuming "${entry.title || entry.book_id}" — extraction will continue in the background.`);
      setCatalog(await fetchCatalogMerged());
    } catch (e) {
      setNote(`Couldn't resume "${entry.title || entry.book_id}": ${e.message || "unknown error"}`);
    }
  }

  // Lightweight library-grid convenience — the full rename UI lives in
  // PlayerMenu.jsx (inline field); this is a quick prompt() for renaming
  // without opening the book at all (e.g. retiring an old book before a
  // fresh re-upload). Note: if that book's extraction is still ACTIVELY
  // running, the pipeline's own periodic writes will overwrite this rename
  // the next time a chapter completes (it re-writes title from the value it
  // captured at job start, unaware of a concurrent rename) — safest once
  // the job has settled or been cancelled.
  async function handleRenameBook(entry) {
    const title = window.prompt("Rename book", entry.title || "");
    if (!title || !title.trim() || title.trim() === entry.title) return;
    try {
      await renameBook(entry.book_id, title.trim());
      setCatalog(await fetchCatalogMerged());
    } catch (e) {
      setNote(`Couldn't rename "${entry.title || entry.book_id}": ${e.message || "unknown error"}`);
    }
  }

  async function backToLibrary() {
    setView("library");
    window.location.hash = "#/";
    try {
      setCatalog(await fetchCatalogMerged());
      setServerOnline(true);
      setNote("");
    } catch {
      const local = await fetchLocalCatalog().catch(() => []);
      setCatalog(local.length ? local : sampleCatalog());
      setServerOnline(false);
    }
  }

  const openPipeline = () => setPipelineOpen(true);
  // Local pack cache is for playback fallback — not "offline mode" while the server is reachable.
  const playerOffline = !serverOnline || !backendConfigured();

  return (
    <AuthGate title="Visual Audiobook Engine" tagline="EPUB to game-style voiced reading — sign in to explore the library.">
      <div className="vae-app">
        {view === "player" && (
          <header className="vae-header vae-header-player">
            <button className="vae-back" data-testid="back" onClick={backToLibrary}>‹ Library</button>
            <h1>{book?.title || "Visual Audiobook"}</h1>
          </header>
        )}

        {note && (
          <div className="vae-note vae-note-float" data-testid="note">{note}</div>
        )}

        {epubUpload.busy && (
          <div className="vae-note vae-note-float" data-testid="epub-upload-busy">
            Uploading {epubUpload.fileName || "book"}…
          </div>
        )}
        {epubUpload.error && (
          <div className="vae-note vae-note-float vae-note-err" data-testid="epub-upload-err">
            {epubUpload.error}
          </div>
        )}

        {view === "library"
          ? (
            prefs.uiMode === "simple" ? (
              <SimpleLibrary
                catalog={catalog}
                onOpen={openBook}
                onAdd={() => setSimpleAddOpen(true)}
                onOpenSettings={() => setSimpleSettingsOpen(true)}
                onOpenDownloads={() => setSimpleDownloadsOpen(true)}
                cacheBusy={cacheBusy}
              />
            ) : (
              <Library
                catalog={catalog}
                offline={!serverOnline}
                serverOnline={serverOnline}
                onOpen={openBook}
                onCatalog={setCatalog}
                onOpenSettings={() => setSettingsOpen(true)}
                cacheBusy={cacheBusy}
                onContinueExtraction={handleContinueExtraction}
                onRenameBook={handleRenameBook}
                onUploadM4b={startM4bFirstUpload}
                m4bUpload={m4bUpload}
              />
            )
          )
          : (
            <CompareModalProvider bookId={book?.book_id} book={book}>
              <Player book={book} prefs={prefs} setPrefs={setPrefs}
                offline={playerOffline}
                onOpenPipeline={serverOnline && backendConfigured() ? openPipeline : null}
                onOpenSimpleSettings={() => setSimpleSettingsOpen(true)} />
            </CompareModalProvider>
          )}

        <DownloadRecommendModal
          open={Boolean(downloadModal)}
          title={downloadModal?.title}
          busy={downloadBusy}
          onDownload={handleDownloadRecommendSave}
          onSkip={handleDownloadRecommendSkip}
        />

        <PipelineSheet open={pipelineOpen} onClose={() => setPipelineOpen(false)} />

        <GlobalSettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)}
          prefs={prefs} setPrefs={setPrefs} offline={!serverOnline}
          onOpenPipeline={serverOnline && backendConfigured() ? openPipeline : null} />

        <SimpleSettingsSheet open={simpleSettingsOpen} onClose={() => setSimpleSettingsOpen(false)}
          prefs={prefs} setPrefs={setPrefs} />

        <SimpleDownloadsSheet open={simpleDownloadsOpen} onClose={() => setSimpleDownloadsOpen(false)}
          catalog={catalog}
          onRefreshCatalog={async () => setCatalog(await fetchCatalogMerged().catch(() => catalog))} />

        <AddBookSheet
          open={simpleAddOpen}
          simple
          onClose={() => setSimpleAddOpen(false)}
          onUploadEpub={handleEpubUpload}
          epubUpload={epubUpload}
          onUploadM4b={startM4bFirstUpload}
          m4bUpload={m4bUpload}
          onImportPack={async (files) => {
            const results = await importOfflinePackFiles(files);
            if (results.imported.length) setCatalog(await fetchCatalogMerged().catch(() => catalog));
            setSimpleAddOpen(false);
          }}
        />
      </div>
    </AuthGate>
  );
}
