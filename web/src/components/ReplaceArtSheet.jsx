import { useEffect, useMemo, useRef, useState } from "react";

import { replaceMedia, uploadMedia, apiBase } from "../api.js";
import { listArtMediaItems, listArtMediaGroups, resolveReplaceArtStyle, selectionToGenerateBody } from "../artMediaItems.js";
import { buildByoPrompt, buildByoPromptJson, buildByoPromptPack } from "../byoPrompts.js";
import { summarizeArtChecklist, artChecklistByKey } from "../artChecklist.js";
import {
  downloadArtPackManifest,
  planArtPackUpload,
  readArtPackInput,
} from "../byoArtPack.js";

import { formatRegenRequestError } from "../clientBanners.js";

import { summarizeArtSelection } from "../regenSummary.js";

import { backgroundStyle, spriteVisual, gradientFromSeed } from "../media.js";
import { getActiveConnection } from "../backends/connections.js";

import BannerStack from "./BannerStack.jsx";
import ArtStylePicker from "./ArtStylePicker.jsx";
import ProviderSelect from "./ProviderSelect.jsx";



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



/** Replace art: generate via AI, copy BYO prompts, or upload files. */

export default function ReplaceArtSheet({ book, open, onClose, onStarted, onFailed, onUploaded }) {

  const fileRef = useRef(null);
  const packZipRef = useRef(null);
  const packFolderRef = useRef(null);

  const [mode, setMode] = useState("generate");

  const [busy, setBusy] = useState(false);

  const [err, setErr] = useState("");

  const [selected, setSelected] = useState(() => new Set());

  const [uploadKey, setUploadKey] = useState("");

  const [focusedKey, setFocusedKey] = useState("");

  const [copied, setCopied] = useState("");
  const [packPlan, setPackPlan] = useState(null);
  const [packBusy, setPackBusy] = useState(false);
  const [styleOverride, setStyleOverride] = useState(() => resolveReplaceArtStyle(book));
  const [imageProvider, setImageProvider] = useState("auto");
  const activeConnection = getActiveConnection();



  const items = useMemo(() => listArtMediaItems(book), [book]);

  const groups = useMemo(() => listArtMediaGroups(book), [book]);

  const byoOpts = useMemo(() => ({ apiBase: apiBase(), styleOverride }), [open, styleOverride]);

  const checklist = useMemo(() => summarizeArtChecklist(items), [items]);
  const filledByKey = useMemo(() => artChecklistByKey(checklist), [checklist]);



  const selectedItems = useMemo(

    () => items.filter((it) => selected.has(it.key)),

    [items, selected],

  );



  const previewItem = useMemo(() => {

    if (focusedKey) {

      const hit = items.find((it) => it.key === focusedKey);

      if (hit && selected.has(hit.key)) return hit;

    }

    return selectedItems[0] || null;

  }, [items, focusedKey, selected, selectedItems]);



  const previewPrompt = useMemo(() => {

    if (!previewItem) return "";

    return buildByoPrompt(book, previewItem, byoOpts);

  }, [book, previewItem, byoOpts]);



  useEffect(() => {

    if (!open) return;

    setErr("");

    setBusy(false);

    setCopied("");

    setPackPlan(null);

    setStyleOverride(resolveReplaceArtStyle(book));

    setMode(book?.byo_mode ? "prompts" : "generate");

    const allKeys = items.map((it) => it.key);

    setSelected(new Set(allKeys));

    setUploadKey(items[0]?.key || "");

    setFocusedKey(items[0]?.key || "");

  }, [open, book?.book_id, book?.byo_mode, items]);



  if (!open) return null;



  function toggleKey(key, multi) {

    if (multi) {

      setSelected((prev) => {

        const n = new Set(prev);

        if (n.has(key)) n.delete(key);

        else n.add(key);

        return n;

      });

      setFocusedKey(key);

    } else {

      setUploadKey(key);

    }

  }



  async function copyText(text, label) {

    await navigator.clipboard.writeText(text);

    setCopied(label);

    setTimeout(() => setCopied(""), 1800);

  }



  async function copyOnePrompt() {

    if (!previewItem) {

      setErr("Select at least one image slot.");

      return;

    }

    setErr("");

    await copyText(buildByoPrompt(book, previewItem, byoOpts), "one");

  }



  async function copyAllPrompts() {

    if (!selectedItems.length) {

      setErr("Select at least one image slot.");

      return;

    }

    setErr("");

    await copyText(buildByoPromptPack(book, selectedItems, byoOpts), "all");

  }



  function downloadJson() {

    if (!selectedItems.length) {

      setErr("Select at least one image slot.");

      return;

    }

    setErr("");

    const payload = buildByoPromptJson(book, selectedItems, byoOpts);

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });

    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");

    a.href = url;

    a.download = `${book?.book_id || "book"}-byo-prompts.json`;

    a.click();

    URL.revokeObjectURL(url);

  }



  async function runGenerate() {

    const body = selectionToGenerateBody([...selected], items, book, { styleOverride });

    if (imageProvider !== "auto") body.prefer_provider = imageProvider;

    const partial = body.scope !== "all";

    const summary = summarizeArtSelection([...selected], items);

    const { job_id: jobId } = await replaceMedia(book.book_id, body);

    onStarted?.(jobId, { partial, compare: Boolean(body.compare), ...summary });

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

    onUploaded?.();

  }



  async function handlePackInput(input) {

    setErr("");

    try {

      const entries = await readArtPackInput(input);

      if (!entries.length) throw new Error("No images found in pack.");

      setPackPlan(planArtPackUpload(book, entries));

    } catch (e) {

      setPackPlan(null);

      setErr(e?.message || "Could not read art pack.");

    }

  }



  async function applyArtPack() {

    if (!packPlan?.matched?.length) {

      setErr("No matched images to upload.");

      return;

    }

    setPackBusy(true);

    setErr("");

    try {

      for (const row of packPlan.matched) {

        await uploadMedia(book.book_id, row.kind, row.key, row.file);

      }

      onUploaded?.();

      onClose?.();

    } catch (e) {

      setErr(formatRegenRequestError(e));

      onFailed?.(formatRegenRequestError(e));

    } finally {

      setPackBusy(false);

    }

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

      const msg = formatRegenRequestError(e);

      setErr(msg);

      onFailed?.(msg);

      setBusy(false);

    }

  }



  const multi = mode === "generate" || mode === "prompts";



  return (

    <div className="vae-sheet-backdrop" data-testid="replace-sheet" onClick={onClose}>

      <div className="vae-sheet" onClick={(e) => e.stopPropagation()}>

        <header className="vae-sheet-head">

          <h2>Replace art</h2>

          <button type="button" className="vae-sheet-close" onClick={onClose}>×</button>

        </header>

        <p className="vae-sheet-hint" data-testid="replace-style-hint">

          Target style: <ArtStylePicker value={styleOverride} onChange={setStyleOverride} testIdPrefix="replace-art-style" />

          {book?.art_filter === "pixel" && book?.active_style === "pixel" && styleOverride === resolveReplaceArtStyle(book)

            ? " (pixel filter uses this source art)" : ""}

          {" · "}

          Provider: <ProviderSelect lane="image" connection={activeConnection} value={imageProvider}
            onChange={setImageProvider} testId="replace-art-provider" />

          {" · "}

          <span data-testid="art-checklist-summary">

            {checklist.filled}/{checklist.total} slots filled

          </span>

        </p>



        {book?.byo_mode && (

          <p className="vae-sheet-hint" data-testid="byo-mode-hint">

            BYO mode — copy prompts, name files per manifest, then upload a zip or folder.

          </p>

        )}



        <BannerStack banners={book?.banners} bookId={book?.book_id} className="vae-banners-inset" />



        <fieldset className="vae-sheet-fieldset">

          <legend>How</legend>

          <label className="vae-radio">

            <input type="radio" name="replace-mode" checked={mode === "generate"}

              onChange={() => setMode("generate")} data-testid="replace-mode-generate" />

            <span className="vae-radio-dot" aria-hidden />

            Generate new (Gemini → free APIs → local SD)

          </label>

          <label className="vae-radio">

            <input type="radio" name="replace-mode" checked={mode === "prompts"}

              onChange={() => setMode("prompts")} data-testid="replace-mode-prompts" />

            <span className="vae-radio-dot" aria-hidden />

            Copy prompts (use your own ChatGPT / Gemini)

          </label>

          <label className="vae-radio">

            <input type="radio" name="replace-mode" checked={mode === "upload"}

              onChange={() => setMode("upload")} data-testid="replace-mode-upload" />

            <span className="vae-radio-dot" aria-hidden />

            Upload replacement image

          </label>

        </fieldset>



        {mode === "prompts" && (

          <p className="vae-sheet-hint">

            Copy a prompt, generate the image in ChatGPT, Gemini, or another tool, then switch to

            {" "}<strong>Upload replacement image</strong> to apply it.

          </p>

        )}



        <p className="vae-sheet-field" style={{ marginBottom: 4 }}>

          {multi ? "Select images to replace" : "Select one slot to replace"}

        </p>



        {multi && (

          <div className="vae-art-picker-actions">

            <button type="button" className="vae-btn vae-btn-sm" data-testid="replace-select-all"

              onClick={() => setSelected(new Set(items.map((it) => it.key)))}>

              Select all

            </button>

            <button type="button" className="vae-btn vae-btn-sm vae-btn-muted" data-testid="replace-select-none"

              onClick={() => setSelected(new Set())}>

              Select none

            </button>

          </div>

        )}



        <div className="vae-art-picker" data-testid="replace-art-picker">

          {groups.map((group) => (

            <section key={group.id} className="vae-art-group" data-testid="replace-art-group">

              <h3 className="vae-art-group-title">{group.label}</h3>

              <div className="vae-art-group-grid">

                {group.items.map((item) => {

                  const isOn = multi ? selected.has(item.key) : uploadKey === item.key;
                  const filled = filledByKey[item.key];

                  return (

                    <button

                      key={item.key}

                      type="button"

                      className={`vae-art-tile${isOn ? " selected" : ""}${focusedKey === item.key && mode === "prompts" ? " focused" : ""}${filled ? " filled" : ""}`}

                      data-testid="replace-art-tile"

                      data-art-key={item.key}

                      data-selected={isOn ? "true" : "false"}

                      data-filled={filled ? "true" : "false"}

                      onClick={() => toggleKey(item.key, multi)}

                    >

                      {filled && <span className="vae-art-check" aria-hidden>✓</span>}

                      <ArtThumb item={item} />

                      <span className="vae-art-label">{item.label}</span>

                      {item.sceneTitle && (

                        <span className="vae-art-sublabel">{item.sceneTitle}</span>

                      )}

                    </button>

                  );

                })}

              </div>

            </section>

          ))}

        </div>



        {mode === "upload" && (

          <>

            <section className="vae-sheet-field vae-art-pack" data-testid="byo-art-pack">

              <h3 className="vae-art-pack-title">Art pack (zip or folder)</h3>

              <p className="vae-sheet-hint">

                Name files: <code>cover.png</code>, <code>char_&#123;id&#125;.png</code>,

                {" "}<code>bg_&#123;scene_id&#125;.png</code>, <code>insert_&#123;line&#125;.png</code>

              </p>

              <div className="vae-art-picker-actions">

                <button type="button" className="vae-btn vae-btn-sm" data-testid="byo-download-manifest"

                  onClick={() => downloadArtPackManifest(book)}>

                  Download filename manifest

                </button>

              </div>

              <label className="vae-sheet-field">

                Zip file

                <input ref={packZipRef} type="file" accept=".zip,application/zip"

                  data-testid="byo-pack-zip"

                  onChange={(e) => handlePackInput(e.target.files?.[0])} />

              </label>

              <label className="vae-sheet-field">

                Folder of images

                <input ref={packFolderRef} type="file" accept="image/png,image/jpeg,image/webp"

                  webkitdirectory="true" directory="" multiple

                  data-testid="byo-pack-folder"

                  onChange={(e) => handlePackInput(e.target.files)} />

              </label>

              {packPlan && (

                <div className="vae-art-pack-plan" data-testid="byo-pack-plan">

                  <p className="vae-sheet-hint">

                    {packPlan.matched.length} matched

                    {packPlan.unmatched.length ? ` · ${packPlan.unmatched.length} skipped` : ""}

                  </p>

                  <ul className="vae-art-pack-matched">

                    {packPlan.matched.map((row) => (

                      <li key={`${row.kind}:${row.key}`}>

                        <span>{row.path}</span>

                        <span>→ {row.label}</span>

                      </li>

                    ))}

                  </ul>

                  {packPlan.unmatched.length > 0 && (

                    <ul className="vae-art-pack-unmatched">

                      {packPlan.unmatched.map((row) => (

                        <li key={row.path}>{row.path}: {row.reason}</li>

                      ))}

                    </ul>

                  )}

                  <button type="button" className="vae-menu-link" data-testid="byo-pack-apply"

                    disabled={packBusy || !packPlan.matched.length}

                    onClick={applyArtPack}>

                    {packBusy ? "Uploading…" : `Apply ${packPlan.matched.length} images`}

                  </button>

                </div>

              )}

            </section>



            <label className="vae-sheet-field">

              Or single image file

              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp"

                data-testid="replace-upload-input" />

            </label>

          </>

        )}



        {mode === "prompts" && (

          <div className="vae-sheet-field">

            <label htmlFor="byo-prompt-preview">Prompt preview</label>

            <textarea

              id="byo-prompt-preview"

              className="vae-byo-preview"

              readOnly

              rows={10}

              value={previewPrompt}

              data-testid="byo-prompt-preview"

            />

            <div className="vae-art-picker-actions" style={{ marginTop: 8 }}>

              <button type="button" className="vae-btn vae-btn-sm" data-testid="byo-copy-one" onClick={copyOnePrompt}>

                {copied === "one" ? "Copied!" : "Copy this prompt"}

              </button>

              <button type="button" className="vae-btn vae-btn-sm" data-testid="byo-copy-all" onClick={copyAllPrompts}>

                {copied === "all" ? "Copied!" : "Copy all prompts"}

              </button>

              <button type="button" className="vae-btn vae-btn-sm" data-testid="byo-download-json" onClick={downloadJson}>

                Download JSON

              </button>

              <button type="button" className="vae-btn vae-btn-sm" data-testid="byo-download-manifest"

                onClick={() => downloadArtPackManifest(book)}>

                Download filename manifest

              </button>

            </div>

          </div>

        )}



        {err && <p className="vae-sheet-err" data-testid="replace-error">{err}</p>}



        <footer className="vae-sheet-foot">

          <button type="button" className="vae-btn vae-btn-secondary" onClick={onClose}>Cancel</button>

          {mode !== "prompts" && (

            <button type="button" className="vae-btn vae-btn-primary" data-testid="replace-submit" disabled={busy} onClick={submit}>

              {busy ? "Starting…" : "Replace"}

            </button>

          )}

        </footer>

      </div>

    </div>

  );

}

