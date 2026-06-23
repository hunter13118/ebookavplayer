import { useEffect, useState } from "react";

import { AuthGate } from "./lib/portfolioAuth.jsx";

import Library from "./components/Library.jsx";

import Player from "./components/Player.jsx";

import PipelineSheet from "./components/PipelineSheet.jsx";

import GlobalSettingsSheet from "./components/GlobalSettingsSheet.jsx";

import { getPrefs } from "./audio/voicePrefs.js";

import { backendConfigured } from "./api.js";

import { fetchBook, fetchCatalogMerged, fetchLocalCatalog } from "./offline/bookSource.js";

import { sampleBook } from "./sampleBook.js";



function sampleCatalog() {

  const lines = (sampleBook.scenes || []).reduce((n, s) => n + s.lines.length, 0);

  return [{

    book_id: sampleBook.book_id, title: sampleBook.title, author: sampleBook.author,

    status: "ready", stage: "done", progress: 1, cover: null,

    scenes: sampleBook.scenes.length, lines,

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



  useEffect(() => { document.documentElement.dataset.theme = prefs.theme; }, [prefs.theme]);



  useEffect(() => {

    let alive = true;

    (async () => {

      try {

        const list = await fetchCatalogMerged();

        if (!alive) return;

        setServerOnline(true);

        setNote("");

        setCatalog(list);

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

          setNote("No backend — embedded demo only. Install an offline pack or connect the server.");

          return;

        }

        setServerOnline(false);

        setCatalog(sampleCatalog());

        setNote("Backend unreachable — embedded demo. Import an offline pack for real books.");

      }

    })();

    return () => { alive = false; };

  }, []);



  async function openBook(entry) {

    try {

      const full = await fetchBook(entry.book_id);

      setBook(full); setView("player");

      window.location.hash = `#/book/${entry.book_id}`;

    } catch (e) {

      if (!serverOnline && entry.offline_pack) {

        setNote(`Couldn't load offline pack for ${entry.title}.`);

        return;

      }

      if (!serverOnline) {

        setBook(sampleBook); setView("player");

        return;

      }

      const processing = entry.status === "processing" || (entry.progress != null && entry.progress < 0.45);

      setNote(processing

        ? `Still processing "${entry.title}" — see Processing on the library (text ready ~45%).`

        : `Couldn't open ${entry.title}. ${e.message || ""}`.trim());

    }

  }



  async function backToLibrary() {

    setView("library");

    window.location.hash = "#/";

    try { setCatalog(await fetchCatalogMerged()); setServerOnline(true); setNote(""); }

    catch {

      const local = await fetchLocalCatalog().catch(() => []);

      setCatalog(local.length ? local : sampleCatalog());

      setServerOnline(false);

    }

  }



  const openPipeline = () => setPipelineOpen(true);

  const playerOffline = !serverOnline || Boolean(book?.offline_pack);



  return (

    <AuthGate title="Visual Audiobook Engine" tagline="EPUB to game-style voiced reading — sign in to explore the library.">

    <div className="vae-app">

      <header className="vae-header">

        {view === "player" && (

          <button className="vae-back" data-testid="back" onClick={backToLibrary}>‹ Library</button>

        )}

        <h1>{view === "player" ? (book?.title || "Visual Audiobook") : "Visual Audiobook Engine"}</h1>

        {view === "library" && (

          <button type="button" className="vae-settings-btn" data-testid="open-settings"

            onClick={() => setSettingsOpen(true)} aria-label="Settings">

            ⚙ Settings

          </button>

        )}

      </header>

      {note && <div className="vae-note" data-testid="note">{note}</div>}



      {view === "library"

        ? <Library catalog={catalog} offline={!serverOnline} serverOnline={serverOnline}

            onOpen={openBook} onCatalog={setCatalog} />

        : <Player book={book} prefs={prefs} setPrefs={setPrefs}

            offline={playerOffline}

            onOpenPipeline={serverOnline && backendConfigured() && !book?.offline_pack ? openPipeline : null} />}



      <PipelineSheet open={pipelineOpen} onClose={() => setPipelineOpen(false)} />

      <GlobalSettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)}

        prefs={prefs} setPrefs={setPrefs} offline={!serverOnline}

        onOpenPipeline={serverOnline && backendConfigured() ? openPipeline : null} />

    </div>

    </AuthGate>

  );

}
