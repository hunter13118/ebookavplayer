import { useRef, useState } from "react";
import { ingestBook } from "../api.js";
import { getPrefs, setPref, KEYS } from "../audio/voicePrefs.js";

// Upload tray (below the library). Picking/dropping an EPUB POSTs /ingest,
// which kicks off the Gemini pipeline. Two upfront choices:
//   - Art style: how the book's art is GENERATED (semi-real | pixel | anime).
//     Anime suits light novels. (Swapping styles later = the multi-style system
//     in docs/ART_STYLES.md.)
//   - Extract only (dry run): skip image generation to preview the script first.
export default function Uploader({ onStarted }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [useGenAi, setUseGenAi] = useState(true);
  const [artStyle, setArtStyle] = useState(getPrefs().artStyle || "semi-real");
  const [err, setErr] = useState("");

  function chooseStyle(v) { setArtStyle(v); setPref(KEYS.artStyle, v); }

  async function handleFiles(files) {
    const file = files && files[0];
    if (!file) return;
    setBusy(true); setErr("");
    try {
      const res = await ingestBook(file, { artStyle, dryRun, generateArt: useGenAi && !dryRun });
      onStarted?.(res, file);
    } catch (e) {
      setErr("Upload failed — is the backend running?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vae-uploader" data-testid="uploader"
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
          <select data-testid="upload-art-style" value={artStyle}
            onChange={(e) => chooseStyle(e.target.value)}>
            <option value="semi-real">Semi-realistic</option>
            <option value="anime">Anime (light novels)</option>
            <option value="cartoon">Cartoon / comic</option>
            <option value="pixel">Pixel-art</option>
          </select>
        </label>
      </div>

      <label className="vae-upload-dry" data-testid="gen-ai-toggle">
        <input type="checkbox" checked={useGenAi && !dryRun} disabled={dryRun}
          data-testid="gen-ai-input"
          onChange={(e) => setUseGenAi(e.target.checked)} />
        Generate art with AI (Gemini, then local SD when on your network)
      </label>

      <label className="vae-upload-dry" data-testid="dry-run-toggle">
        <input type="checkbox" checked={dryRun}
          data-testid="dry-run-input"
          onChange={(e) => setDryRun(e.target.checked)} />
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
