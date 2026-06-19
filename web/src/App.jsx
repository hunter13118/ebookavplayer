import { useEffect, useState } from "react";
import { AuthGate } from "./lib/portfolioAuth.jsx";
import Library from "./components/Library.jsx";
import Player from "./components/Player.jsx";
import { getPrefs } from "./audio/voicePrefs.js";
import { fetchCatalog, fetchBook, backendConfigured } from "./api.js";
import { sampleBook } from "./sampleBook.js";

// Two views: the library landing and the player. Backend-less mode synthesizes
// a one-book catalog from the embedded demo so the landing still works.
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
  const [view, setView] = useState("library");      // library | player
  const [catalog, setCatalog] = useState([]);
  const [book, setBook] = useState(null);
  const [offline, setOffline] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => { document.documentElement.dataset.theme = prefs.theme; }, [prefs.theme]);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!backendConfigured()) {
        if (!alive) return;
        setOffline(true); setCatalog(sampleCatalog());
        setNote("No backend detected — showing the embedded demo (text + sprites; connect the server for voices, uploads, and your real library).");
        return;
      }
      try {
        const list = await fetchCatalog();
        if (!alive) return;
        setOffline(false);
        setNote("");
        setCatalog(list);
      } catch {
        if (!alive) return;
        setOffline(true); setCatalog(sampleCatalog());
        setNote("Backend unreachable — showing the embedded demo.");
      }
    })();
    return () => { alive = false; };
  }, []);

  async function openBook(entry) {
    if (offline) { setBook(sampleBook); setView("player"); return; }
    try {
      const full = await fetchBook(entry.book_id);
      setBook(full); setView("player");
      window.location.hash = `#/book/${entry.book_id}`;
    } catch {
      setNote(`Couldn't open ${entry.title}.`);
    }
  }

  async function backToLibrary() {
    setView("library");
    window.location.hash = "#/";
    if (!offline) { try { setCatalog(await fetchCatalog()); } catch {} }
  }

  return (
    <AuthGate title="Visual Audiobook Engine" tagline="EPUB to game-style voiced reading — sign in to explore the library.">
    <div className="vae-app">
      <header className="vae-header">
        {view === "player" && (
          <button className="vae-back" data-testid="back" onClick={backToLibrary}>‹ Library</button>
        )}
        <h1>{view === "player" ? (book?.title || "Visual Audiobook") : "Visual Audiobook Engine"}</h1>
      </header>
      {note && <div className="vae-note" data-testid="note">{note}</div>}

      {view === "library"
        ? <Library catalog={catalog} offline={offline} onOpen={openBook}
            onCatalog={setCatalog} />
        : <Player book={book} prefs={prefs} setPrefs={setPrefs}
            offline={offline} onBack={backToLibrary} />}
    </div>
    </AuthGate>
  );
}
