import { useEffect, useState } from "react";

import { AuthGate } from "./lib/portfolioAuth.jsx";

import Library from "./components/Library.jsx";

import Player from "./components/Player.jsx";

import PipelineSheet from "./components/PipelineSheet.jsx";

import GlobalSettingsSheet from "./components/GlobalSettingsSheet.jsx";
import DownloadRecommendModal from "./components/DownloadRecommendModal.jsx";
import { CompareModalProvider } from "./hooks/compareModalContext.jsx";

import { getPrefs } from "./audio/voicePrefs.js";

import { backendConfigured, fetchCatalog, continueExtraction } from "./api.js";
import { setActiveConnectionId } from "./backends/connections.js";
import { startHealthPolling } from "./backends/health.js";

import {
  fetchBook, fetchCatalogMerged, fetchLocalCatalog, mergeCatalog, ensureBookCached, exportBookPackFile,
  pickPackSaveHandle,
} from "./offline/bookSource.js";
import { shouldRecommendDownload, skipDownloadRecommend } from "./offline/downloadRecommend.js";

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
  const [cacheBusy, setCacheBusy] = useState(null);
  const [downloadModal, setDownloadModal] = useState(null);
  const [downloadBusy, setDownloadBusy] = useState(false);

  useEffect(() => { document.documentElement.dataset.theme = prefs.theme; }, [prefs.theme]);

  useEffect(() => startHealthPolling(), []);

  useEffect(() => {
    const m = window.location.hash.match(/^#\/book\/([^/?]+)/);
    if (!m) return undefined;
    let alive = true;
    (async () => {
      try {
        const full = await fetchBook(decodeURIComponent(m[1]));
        if (!alive) return;
        setBook(full);
        setView("player");
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
          setNote("Server unreachable — showing locally installed offline packs.");
          return;
        }
        if (!backendConfigured()) {
          setServerOnline(false);
          setCatalog(sampleCatalog());
          setNote("No backend — embedded demo only. Import an offline pack or connect the server.");
          return;
        }
        setServerOnline(false);
        setCatalog(sampleCatalog());
        setNote("Backend unreachable — embedded demo. Import an offline pack for real books.");
      }
    })();
    return () => { alive = false; };
  }, []);

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
  }

  async function openBook(entry) {
    try {
      if (entry.status === "error") {
        setNote(
          `Ingest failed for "${entry.title || entry.book_id}": ${entry.error || "unknown error"}. Upload the EPUB again.`,
        );
        return;
      }

      const fromCloud = entry.server_available !== false;
      const e2eNoCache = typeof localStorage !== "undefined"
        && localStorage.getItem("vae-e2e") === "1"
        && localStorage.getItem("vae-e2e-cache") !== "1";
      const needsCache = fromCloud && !entry.offline_pack && !e2eNoCache;
      let cached = Boolean(entry.offline_pack);

      if (needsCache) {
        setCacheBusy(entry.book_id);
        try {
          await ensureBookCached(entry.book_id);
          cached = true;
          const list = await fetchCatalogMerged();
          setCatalog(list);
        } catch (e) {
          setNote(`Couldn't cache "${entry.title}": ${e.message || "unknown error"}`);
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
        setNote(`Couldn't load offline pack for ${entry.title}.`);
        return;
      }
      if (!serverOnline) {
        setBook(sampleBook);
        setView("player");
        return;
      }
      const processing = entry.status === "processing" || (entry.progress != null && entry.progress < 0.45);
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

  async function handleContinueExtraction(entry) {
    try {
      await continueExtraction(entry.book_id, { preferProvider: "auto" });
      setNote(`Resuming "${entry.title || entry.book_id}" — extraction will continue in the background.`);
      setCatalog(await fetchCatalogMerged());
    } catch (e) {
      setNote(`Couldn't resume "${entry.title || entry.book_id}": ${e.message || "unknown error"}`);
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

        {view === "library"
          ? (
            <Library
              catalog={catalog}
              offline={!serverOnline}
              serverOnline={serverOnline}
              onOpen={openBook}
              onCatalog={setCatalog}
              onOpenSettings={() => setSettingsOpen(true)}
              cacheBusy={cacheBusy}
              onContinueExtraction={handleContinueExtraction}
            />
          )
          : (
            <CompareModalProvider bookId={book?.book_id} book={book}>
              <Player book={book} prefs={prefs} setPrefs={setPrefs}
                offline={playerOffline}
                onOpenPipeline={serverOnline && backendConfigured() ? openPipeline : null} />
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
      </div>
    </AuthGate>
  );
}
