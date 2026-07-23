import { useRef, useState } from "react";
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

// Upload tray (below the library). Picking/dropping an EPUB hands the file +
// chosen options up to onUpload, which does the actual POST /ingest — owned
// by a parent that outlives this component (Library.jsx / App.jsx), NOT by
// local state here. Closing the "Add to library" sheet unmounts this
// component; if the upload's busy/error state lived here, closing mid-upload
// would silently lose it (no error surfaced, no progress indicator anywhere
// once the sheet is gone). See docs — the m4b upload path already gets this
// right via the same lifted-state pattern (m4bUpload in App.jsx).
//
// Two upfront choices besides the file:
//   - Art style: how the book's art is GENERATED (semi-real | pixel | anime).
//     Anime suits light novels. (Swapping styles later = the multi-style system
//     in docs/ART_STYLES.md.)
//   - Extract only (dry run): skip image generation to preview the script first.
//   - BYO art: extract + skip AI imaging; copy prompts and upload your own art.
//
// Picking a file no longer fires the upload immediately — both the epub and
// an optional m4b are held as pending selections, submitted together by one
// explicit "Upload" action, so onUpload's opts can carry `m4bFile` alongside
// the epub for a combined upload (App.jsx's handleEpubUpload auto-attaches
// it to the freshly-opened book — see Player.jsx's pendingM4bFile effect).
export default function Uploader({ onUpload, upload = null, compact = false, allowM4b = true }) {
  const inputRef = useRef(null);
  const m4bInputRef = useRef(null);
  const [pendingFile, setPendingFile] = useState(null);
  const [pendingM4bFile, setPendingM4bFile] = useState(null);
  const [dryRun, setDryRun] = useState(false);
  const [useGenAi, setUseGenAi] = useState(true);
  const [byoMode, setByoMode] = useState(false);
  const [expressiveSprites, setExpressiveSprites] = useState(true);
  const [artStyle, setArtStyle] = useState(getPrefs().artStyle || "anime");
  const [preferProvider, setPreferProvider] = useState("auto");
  const [connectionId, setConnectionId] = useState(SERVER_ID);

  const busy = Boolean(upload?.busy);
  const err = upload?.error || "";
  const targets = uploadTargets();
  const connection = getConnection(connectionId) || targets[0];

  // Server-derived (GET /health's booknlp_available/annotate_available,
  // worker.js) — these are worker-side-only env toggles (VAE_BOOKNLP_URL/
  // VAE_ANNOTATE_LLM), not something the browser can reach directly like the
  // align server, so availability can only ever come from the connection's
  // own health snapshot (health.js), never a new fetch of our own.
  const booknlpAvailable = Boolean(getHealthSnapshot(connection?.id)?.health?.booknlp_available);
  const annotateAvailable = Boolean(getHealthSnapshot(connection?.id)?.health?.annotate_available);
  const [useBooknlp, setUseBooknlp] = useState(booknlpAvailable);
  const [useAnnotate, setUseAnnotate] = useState(annotateAvailable);

  function chooseStyle(v) { setArtStyle(v); setPref(KEYS.artStyle, v); }

  function pickEpub(files) {
    const file = files && files[0];
    if (!file || busy) return;
    setPendingFile(file);
  }

  function pickM4b(files) {
    const file = files && files[0];
    if (!file) return;
    setPendingM4bFile(file);
  }

  function handleSubmit() {
    if (!pendingFile || busy) return;
    const genAi = useGenAi && !dryRun && !byoMode;
    onUpload?.(pendingFile, {
      artStyle,
      dryRun,
      generateArt: genAi,
      byoMode: byoMode && !dryRun,
      generateExpressiveSprites: expressiveSprites && genAi,
      preferProvider,
      useBooknlp: useBooknlp && booknlpAvailable,
      useAnnotate: useAnnotate && annotateAvailable,
      connection,
      m4bFile: pendingM4bFile,
    });
    setPendingFile(null);
    setPendingM4bFile(null);
  }

  return (
    <div className={`vae-uploader${compact ? " vae-uploader-compact" : ""}`} data-testid="uploader"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); pickEpub(e.dataTransfer.files); }}>
      <input ref={inputRef} type="file" accept=".epub" hidden
        data-testid="upload-input"
        onChange={(e) => { pickEpub(e.target.files); e.target.value = ""; }} />
      {allowM4b && (
        <input ref={m4bInputRef} type="file" accept=".m4b" hidden
          data-testid="upload-m4b-companion-input"
          onChange={(e) => { pickM4b(e.target.files); e.target.value = ""; }} />
      )}

      <div className="vae-upload-row">
        <button className="vae-upload-btn" data-testid="upload-btn"
          disabled={busy} onClick={() => inputRef.current?.click()}>
          {pendingFile ? `EPUB: ${pendingFile.name}` : "＋ Choose a book (EPUB)"}
        </button>
        {allowM4b && (
          <button type="button" className="vae-upload-btn" data-testid="upload-m4b-companion-btn"
            disabled={busy} onClick={() => m4bInputRef.current?.click()}>
            {pendingM4bFile ? `Audiobook: ${pendingM4bFile.name}` : "+ Add audiobook (.m4b) — optional"}
          </button>
        )}
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

      <label className="vae-upload-dry vae-checkbox" data-testid="expressive-sprites-toggle">
        <input type="checkbox" checked={expressiveSprites} disabled={!useGenAi || dryRun || byoMode}
          data-testid="expressive-sprites-input"
          onChange={(e) => setExpressiveSprites(e.target.checked)} />
        <span className="vae-checkbox-box" aria-hidden />
        Expressive character art (slower, more images — alt-expression sprites for main characters)
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

      <label className="vae-upload-dry vae-checkbox" data-testid="use-booknlp-toggle"
        title={booknlpAvailable ? "" : "No local BookNLP server configured for this backend"}>
        <input type="checkbox" checked={useBooknlp && booknlpAvailable} disabled={!booknlpAvailable}
          data-testid="use-booknlp-input"
          onChange={(e) => setUseBooknlp(e.target.checked)} />
        <span className="vae-checkbox-box" aria-hidden />
        Use BookNLP (mechanical dialogue attribution, no LLM cost)
        {!booknlpAvailable && " — not configured"}
      </label>

      <label className="vae-upload-dry vae-checkbox" data-testid="use-annotate-toggle"
        title={annotateAvailable ? "" : "Annotate-in-place enrichment isn't enabled on this backend"}>
        <input type="checkbox" checked={useAnnotate && annotateAvailable} disabled={!annotateAvailable}
          data-testid="use-annotate-input"
          onChange={(e) => setUseAnnotate(e.target.checked)} />
        <span className="vae-checkbox-box" aria-hidden />
        Use annotate-in-place LLM (assigns speakers only, never rewrites text)
        {!annotateAvailable && " — not configured"}
      </label>

      <button type="button" className="vae-upload-btn vae-upload-submit" data-testid="upload-submit"
        disabled={!pendingFile || busy} onClick={handleSubmit}>
        {busy ? "Uploading…" : "Upload"}
      </button>

      <div className="vae-upload-hint">
        Drop an EPUB here or click to choose one — add a matching audiobook too
        for synced narration. It’ll be processed into a visual audiobook — you
        can open it as soon as the text is ready, and it keeps getting richer
        in the background.
      </div>
      {err && <div className="vae-upload-err" data-testid="upload-err">{err}</div>}
    </div>
  );
}
