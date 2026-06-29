import { useEffect, useMemo, useState } from "react";
import { fetchEdgeVoices, saveVoiceOverrides } from "../api.js";
import VoiceField from "./VoiceField.jsx";

/** Hamburger sheet: narrator + per-character Edge TTS overrides. */
export default function ReaderMenu({ book, open, onClose, onSaved }) {
  const [voices, setVoices] = useState([]);
  const [overrides, setOverrides] = useState(book?.voice_overrides || {});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!open) return;
    setOverrides(book?.voice_overrides || {});
    setErr("");
    fetchEdgeVoices("en").then(setVoices).catch(() => setVoices([]));
  }, [open, book?.book_id, book?.voice_overrides]);

  const characters = useMemo(() => {
    const map = book?.characters || {};
    return Object.entries(map)
      .filter(([id]) => id !== "narrator")
      .map(([id, c]) => ({
        id, name: c.name, voice: c.voice, pitch: c.pitch, rate: c.rate,
      }));
  }, [book]);

  const narratorCompiled = book?.characters?.narrator?.voice || "";

  function setNarrator(ov) {
    setOverrides((o) => ({ ...o, narrator: ov }));
  }

  function setCharacter(cid, ov) {
    setOverrides((o) => ({
      ...o,
      characters: { ...(o.characters || {}), [cid]: ov },
    }));
  }

  async function save() {
    setBusy(true); setErr("");
    try {
      const saved = await saveVoiceOverrides(book.book_id, overrides);
      onSaved?.(saved);
      onClose?.();
    } catch {
      setErr("Could not save voice settings.");
    } finally { setBusy(false); }
  }

  if (!open) return null;

  return (
    <div className="vae-sheet-backdrop" data-testid="reader-menu" onClick={onClose}>
      <div className="vae-sheet" onClick={(e) => e.stopPropagation()}>
        <header className="vae-sheet-head">
          <h2>Voices</h2>
          <button type="button" className="vae-sheet-close" onClick={onClose}>×</button>
        </header>

        <p className="vae-sheet-hint">Active shows what plays now. ▶ previews the fox phrase.</p>

        <VoiceField
          label="Narrator"
          testId="voice-narrator"
          compiledVoice={narratorCompiled}
          compiledPitch={book?.characters?.narrator?.pitch}
          compiledRate={book?.characters?.narrator?.rate}
          override={overrides.narrator}
          voices={voices}
          onChange={setNarrator}
        />

        {characters.map((c) => (
          <VoiceField
            key={c.id}
            label={c.name}
            testId={`voice-char-${c.id}`}
            compiledVoice={c.voice}
            compiledPitch={c.pitch}
            compiledRate={c.rate}
            override={overrides.characters?.[c.id]}
            voices={voices}
            onChange={(ov) => setCharacter(c.id, ov)}
          />
        ))}

        {err && <p className="vae-sheet-err">{err}</p>}

        <footer className="vae-sheet-foot">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" data-testid="voice-save" disabled={busy} onClick={save}>
            {busy ? "Saving…" : "Save voices"}
          </button>
        </footer>
      </div>
    </div>
  );
}
