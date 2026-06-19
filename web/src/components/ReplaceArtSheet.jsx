import { useEffect, useMemo, useRef, useState } from "react";
import { replaceMedia, uploadMedia } from "../api.js";
import { listArtMediaItems, selectionToGenerateBody } from "../artMediaItems.js";
import { backgroundStyle, spriteVisual, gradientFromSeed } from "../media.js";
import BannerStack from "./BannerStack.jsx";

function ArtThumb({ item }) {
  const token = item.preview;
  if (item.kind === "backgrounds") {
    const style = backgroundStyle(token);
    return <div className="vae-art-thumb wide" style={style} />;
  }
  const v = spriteVisual(token);
  if (v.type === "image") {
    return (
      <div className="vae-art-thumb">
        <img src={v.url} alt="" draggable={false}
          onError={(e) => { e.currentTarget.style.display = "none"; }} />
      </div>
    );
  }
  const grad = v.type === "gradient"
    ? v.css
    : gradientFromSeed(item.id).css;
  return (
    <div className="vae-art-thumb" style={{ background: grad }}>
      {(item.label || "?").slice(0, 1)}
    </div>
  );
}

/** Replace art: generate via AI or upload files; pick specific assets from previews. */
export default function ReplaceArtSheet({ book, open, onClose, onStarted }) {
  const fileRef = useRef(null);
  const [mode, setMode] = useState("generate");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [uploadKey, setUploadKey] = useState("");

  const items = useMemo(() => listArtMediaItems(book), [book]);

  useEffect(() => {
    if (!open) return;
    setErr("");
    setBusy(false);
    setMode("generate");
    setSelected(new Set(items.map((it) => it.key)));
    setUploadKey(items[0]?.key || "");
  }, [open, book?.book_id, items]);

  if (!open) return null;

  function toggleKey(key, multi) {
    if (multi) {
      setSelected((prev) => {
        const n = new Set(prev);
        if (n.has(key)) n.delete(key);
        else n.add(key);
        return n;
      });
    } else {
      setUploadKey(key);
    }
  }

  async function runGenerate() {
    const body = selectionToGenerateBody([...selected], items);
    const { job_id: jobId } = await replaceMedia(book.book_id, body);
    onStarted?.(jobId);
    onClose?.();
  }

  async function runUpload(file) {
    if (!file) throw new Error("Choose an image file.");
    const item = items.find((it) => it.key === uploadKey);
    if (!item) throw new Error("Pick an image slot.");
    let kind = item.kind;
    let key = item.id;
    if (kind === "cover") key = "cover";
    await uploadMedia(book.book_id, kind, key, file);
  }

  async function submit() {
    setBusy(true);
    setErr("");
    try {
      if (mode === "generate") await runGenerate();
      else {
        const file = fileRef.current?.files?.[0];
        await runUpload(file);
        onClose?.();
      }
    } catch (e) {
      setErr(e.message || "Replace failed.");
      setBusy(false);
    }
  }

  const multi = mode === "generate";

  return (
    <div className="vae-sheet-backdrop" data-testid="replace-sheet" onClick={onClose}>
      <div className="vae-sheet" onClick={(e) => e.stopPropagation()}>
        <header className="vae-sheet-head">
          <h2>Replace art</h2>
          <button type="button" className="vae-sheet-close" onClick={onClose}>×</button>
        </header>

        <BannerStack banners={book?.banners} bookId={book?.book_id} className="vae-banners-inset" />

        <fieldset className="vae-sheet-fieldset">
          <legend>How</legend>
          <label>
            <input type="radio" name="replace-mode" checked={mode === "generate"}
              onChange={() => setMode("generate")} data-testid="replace-mode-generate" />
            Generate new (Gemini → free APIs → local SD)
          </label>
          <label>
            <input type="radio" name="replace-mode" checked={mode === "upload"}
              onChange={() => setMode("upload")} data-testid="replace-mode-upload" />
            Upload replacement image
          </label>
        </fieldset>

        <p className="vae-sheet-field" style={{ marginBottom: 4 }}>
          {multi ? "Select images to replace" : "Select one slot to replace"}
        </p>

        {multi && (
          <div className="vae-art-picker-actions">
            <button type="button" data-testid="replace-select-all"
              onClick={() => setSelected(new Set(items.map((it) => it.key)))}>
              Select all
            </button>
            <button type="button" data-testid="replace-select-none"
              onClick={() => setSelected(new Set())}>
              Select none
            </button>
          </div>
        )}

        <div className="vae-art-picker" data-testid="replace-art-picker">
          {items.map((item) => {
            const isOn = multi ? selected.has(item.key) : uploadKey === item.key;
            return (
              <button
                key={item.key}
                type="button"
                className={`vae-art-tile${isOn ? " selected" : ""}`}
                data-testid="replace-art-tile"
                data-art-key={item.key}
                data-selected={isOn ? "true" : "false"}
                onClick={() => toggleKey(item.key, multi)}
              >
                <ArtThumb item={item} />
                <span className="vae-art-label">{item.label}</span>
              </button>
            );
          })}
        </div>

        {mode === "upload" && (
          <label className="vae-sheet-field">
            Image file
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp"
              data-testid="replace-upload-input" />
          </label>
        )}

        {err && <p className="vae-sheet-err" data-testid="replace-error">{err}</p>}

        <footer className="vae-sheet-foot">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" data-testid="replace-submit" disabled={busy} onClick={submit}>
            {busy ? "Starting…" : "Replace"}
          </button>
        </footer>
      </div>
    </div>
  );
}
