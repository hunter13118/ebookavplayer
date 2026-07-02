import { useRef, useState } from "react";
import { ingestBook } from "../api.js";
import { getPrefs, setPref, KEYS } from "../audio/voicePrefs.js";
import ArtStylePicker from "./ArtStylePicker.jsx";
import ProviderSelect from "./ProviderSelect.jsx";
import { SERVER_ID, getConnection, listConnections } from "../backends/connections.js";
import { getHealthSnapshot } from "../backends/health.js";

/** Backends an upload can be sent to — server always offered, remotes only once reachable. */
function uploadTargets() {
  return listConnections().filter((c) => c.kind === "server"
    || (c.kind === "remote" && getHealthSnapshot(c.id).status === "online"));
}

// Upload tray (below the library). Picking/dropping an EPUB POSTs /ingest,
// which kicks off the Gemini pipeline. Two upfront choices:
//   - Art style: how the book's art is GENERATED (semi-real | pixel | anime).
//     Anime suits light novels. (Swapping styles later = the multi-style system
//     in docs/ART_STYLES.md.)
//   - Extract only (dry run): skip image generation to preview the script first.
//   - BYO art: extract + skip AI imaging; copy prompts and upload your own art.
export default function Uploader({ onStarted, compact = false }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [useGenAi, setUseGenAi] = useState(true);
  const [byoMode, setByoMode] = useState(false);
  const [artStyle, setArtStyle] = useState(getPrefs().artStyle || "anime");
  const [preferProvider, setPreferProvider] = useState("auto");
  const [connectionId, setConnectionId] = useState(SERVER_ID);
  const [err, setErr] = useState("");

  const targets = uploadTargets();
  const connection = getConnection(connectionId) || targets[0];

  function chooseStyle(v) { setArtStyle(v); setPref(KEYS.artStyle, v); }

  async function handleFiles(files) {
    const file = files && files[0];
    if (!file) return;
    setBusy(true); setErr("");
    try {
      const res = await ingestBook(file, {
        artStyle,
        dryRun,
        generateArt: useGenAi && !dryRun && !byoMode,
        byoMode: byoMode && !dryRun,
        preferProvider,
        connection,
      });
      onStarted?.(res, file, connection?.id);
    } catch (e) {
      setErr(e.message || "Upload failed — is the backend running?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`vae-uploader${compact ? " vae-uploader-compact" : ""}`} data-testid="uploader"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); handleFiles(e.dataTransfer.files); }}>
      <input ref={inputRef} type="file" accept=".epub" hidden
        data-testid="upload-input"
        onChange={(e) => handleFiles(e.target.files)} />

      <div className="vae-upload-row">
        <button className="vae-upload-btn" data-testid="upload-btn"
          disabled={busy} onClick={() => inputRef.current?.click()}>
          {busy ? "Uploading…" : "＋ Add a book (EPUB)"}
        </button>
        <label className="vae-upload-style">Art style
          <ArtStylePicker value={artStyle} onChange={chooseStyle} testIdPrefix="upload-art-style" />
        </label>
        {targets.length > 1 && (
          <label className="vae-upload-style">Backend
            <span className="vae-select-wrap">
              <select className="vae-select" data-testid="upload-connection" value={connection?.id || ""}
                onChange={(e) => setConnectionId(e.target.value)}>
                {targets.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </span>
          </label>
        )}
        <label className="vae-upload-style">Extraction
          <ProviderSelect lane="extract" connection={connection} value={preferProvider}
            onChange={setPreferProvider} testId="upload-provider" />
        </label>
      </div>

      <label className="vae-upload-dry vae-checkbox" data-testid="gen-ai-toggle">
        <input type="checkbox" checked={useGenAi && !dryRun && !byoMode} disabled={dryRun || byoMode}
          data-testid="gen-ai-input"
          onChange={(e) => setUseGenAi(e.target.checked)} />
        <span className="vae-checkbox-box" aria-hidden />
        Generate art with AI (Gemini, then local SD when on your network)
      </label>

      <label className="vae-upload-dry vae-checkbox" data-testid="byo-mode-toggle">
        <input type="checkbox" checked={byoMode} disabled={dryRun}
          data-testid="byo-mode-input"
          onChange={(e) => {
            const on = e.target.checked;
            setByoMode(on);
            if (on) setUseGenAi(false);
          }} />
        <span className="vae-checkbox-box" aria-hidden />
        BYO art — extract script, copy prompts, upload your own images
      </label>

      <label className="vae-upload-dry vae-checkbox" data-testid="dry-run-toggle">
        <input type="checkbox" checked={dryRun}
          data-testid="dry-run-input"
          onChange={(e) => {
            setDryRun(e.target.checked);
            if (e.target.checked) setByoMode(false);
          }} />
        <span className="vae-checkbox-box" aria-hidden />
        Extract only (skip art — preview the script first)
      </label>
      <div className="vae-upload-hint">
        Drop an EPUB here or click to upload. It’ll be processed into a visual
        audiobook — you can open it as soon as the text is ready.
      </div>
      {err && <div className="vae-upload-err" data-testid="upload-err">{err}</div>}
    </div>
  );
}
