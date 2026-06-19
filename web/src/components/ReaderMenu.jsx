import { useEffect, useMemo, useState } from "react";
import { fetchEdgeVoices, saveVoiceOverrides } from "../api.js";
import { parseVoiceSelect, voiceSelectValue } from "../audio/voiceOverrides.js";

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
      .map(([id, c]) => ({ id, name: c.name, voice: c.voice }));
  }, [book]);

  const narratorCompiled = book?.characters?.narrator?.voice || "";

  function setNarrator(value) {
    setOverrides((o) => ({ ...o, narrator: parseVoiceSelect(value) }));
  }

  function setCharacter(cid, value) {
    setOverrides((o) => ({
      ...o,
      characters: { ...(o.characters || {}), [cid]: parseVoiceSelect(value) },
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

  function voiceOptions(compiledVoice, label) {
    const opts = [
      <option key="def" value={`default:${compiledVoice}`}>
        {label} (from book{compiledVoice ? ` — ${compiledVoice.split("-").slice(-1)[0]}` : ""})
      </option>,
      <option key="up" value="uploaded" disabled title="Coming soon">
        Uploaded voice (coming soon)
      </option>,
    ];
    voices.forEach((v) => {
      const short = v.id || v.ShortName;
      const label = v.label || v.FriendlyName || v.Name || short;
      opts.push(
        <option key={short} value={`edge:${short}`}>
          {label}
        </option>,
      );
    });
    return opts;
  }

  return (
    <div className="vae-sheet-backdrop" data-testid="reader-menu" onClick={onClose}>
      <div className="vae-sheet" onClick={(e) => e.stopPropagation()}>
        <header className="vae-sheet-head">
          <h2>Voices</h2>
          <button type="button" className="vae-sheet-close" onClick={onClose}>×</button>
        </header>

        <label className="vae-sheet-field">
          Narrator
          <select data-testid="voice-narrator"
            value={voiceSelectValue(overrides.narrator, narratorCompiled)}
            onChange={(e) => setNarrator(e.target.value)}>
            {voiceOptions(narratorCompiled, "Default narrator")}
          </select>
        </label>

        {characters.map((c) => (
          <label key={c.id} className="vae-sheet-field">
            {c.name}
            <select data-testid={`voice-char-${c.id}`}
              value={voiceSelectValue(overrides.characters?.[c.id], c.voice)}
              onChange={(e) => setCharacter(c.id, e.target.value)}>
              {voiceOptions(c.voice, `Default (${c.name})`)}
            </select>
          </label>
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
