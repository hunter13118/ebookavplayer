import { useEffect, useMemo, useState } from "react";

import {
  fetchEdgeVoices, reExtractBook, runExpressionRepass, subscribeJobEvents, jobEventToStatus, saveVoiceOverrides,
  attachEpubToBook, renameBook,
} from "../api.js";

import { KEYS, setPref } from "../audio/voicePrefs.js";

import { getActiveConnection } from "../backends/connections.js";

import ArtStyleSwitcher from "./ArtStyleSwitcher.jsx";

import ProviderSelect from "./ProviderSelect.jsx";

import PinMismatchConfirm from "./PinMismatchConfirm.jsx";

import VoiceField from "./VoiceField.jsx";

import { DisplaySettings, PlaybackSettings, AudiobookSyncSettings } from "./AppSettingsSections.jsx";

import {

  buildChapterIndex,

  chapterLabel,

  charactersForChapter,

} from "../chapterNav.js";



/** Hamburger menu: display prefs, voices, art style, layout options. */

export default function PlayerMenu({

  book, open, onClose, prefs, setPrefs, offline, onOpenReplace, onOpenPlates, onRefresh, onJobStarted,

  onRegenStarted, onRegenFailed,

  onToggleFullscreen, onSaved, onOpenPipeline, disabled,

  m4bStatus, onAttachM4b, onRemoveM4b,

}) {

  const [voices, setVoices] = useState([]);

  const [overrides, setOverrides] = useState(book?.voice_overrides || {});

  const [voiceChapter, setVoiceChapter] = useState(1);

  const [busy, setBusy] = useState(false);

  const [extractBusy, setExtractBusy] = useState(false);

  const [expressionRepassBusy, setExpressionRepassBusy] = useState(false);

  const [epubBusy, setEpubBusy] = useState(false);

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);

  const [err, setErr] = useState("");

  const [extractProvider, setExtractProvider] = useState("auto");

  const [pinConfirmOpen, setPinConfirmOpen] = useState(false);

  const activeConnection = getActiveConnection();



  const chapters = useMemo(() => buildChapterIndex(book?.scenes), [book?.scenes]);



  useEffect(() => {

    if (!open) return;

    setOverrides(book?.voice_overrides || {});

    setErr("");

    setVoiceChapter(chapters[0]?.chapter ?? 1);

    fetchEdgeVoices("en").then(setVoices).catch(() => setVoices([]));

  }, [open, book?.book_id, book?.voice_overrides, chapters]);



  const characters = useMemo(() => {

    const map = book?.characters || {};

    return Object.entries(map)

      .filter(([id]) => id !== "narrator")

      .map(([id, c]) => ({

        id, name: c.name, voice: c.voice, pitch: c.pitch, rate: c.rate,

      }));

  }, [book]);



  const chapterCharacters = useMemo(

    () => charactersForChapter(chapters, voiceChapter, characters, { book }),

    [chapters, voiceChapter, characters, book],

  );



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



  async function saveVoices() {

    setBusy(true);

    setErr("");

    try {

      const saved = await saveVoiceOverrides(book.book_id, overrides);

      onSaved?.(saved);

    } catch {

      setErr("Could not save voice settings.");

    } finally {

      setBusy(false);

    }

  }



  function waitForJob(jobId) {
    return new Promise((resolve, reject) => {
      const unsub = subscribeJobEvents(jobId, {
        onEvent: (ev) => {
          const st = jobEventToStatus(ev);
          const done = ev.type === "done" || st.status === "done";
          const errored = ev.type === "error" || st.status === "error";
          if (done) {
            unsub();
            resolve(true);
          } else if (errored) {
            unsub();
            reject(new Error(st.detail || st.error || "Re-extract failed."));
          }
        },
        onError: (err) => {
          unsub();
          reject(err || new Error("Lost connection to re-extract job."));
        },
      });
    });
  }

  async function pollJob(jobId) {
    await waitForJob(jobId);
  }



  async function runReExtract() {

    setExtractBusy(true);

    setErr("");

    try {

      const { job_id: jobId } = await reExtractBook(book.book_id, { preferProvider: extractProvider });

      onJobStarted?.(jobId);

      await pollJob(jobId);

      await onRefresh?.();

    } catch (e) {

      setErr(e?.message || "Could not re-extract script.");

    } finally {

      setExtractBusy(false);

      setPinConfirmOpen(false);

    }

  }



  async function handleExpressionRepass() {
    setExpressionRepassBusy(true);
    setErr("");
    try {
      const { job_id: jobId } = await runExpressionRepass(book.book_id, { preferProvider: extractProvider });
      onJobStarted?.(jobId);
      await pollJob(jobId);
      await onRefresh?.();
    } catch (e) {
      setErr(e?.message || "Could not re-tag expressions.");
    } finally {
      setExpressionRepassBusy(false);
    }
  }

  // Attach a real EPUB to a book that started without one (e.g. m4b-first —
  // docs/M4B_FIRST_FLOW.md). Reuses the exact same job (POST /ingest with
  // existing_book_id) and job-tracking dance as re-extract above — the worker
  // treats this as a normal re-ingest onto the same book_id, so the same
  // ProcessingBar/job-events UI already covers it, no new plumbing needed.
  async function handleAttachEpub(ev) {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if (!file) return;
    if (!window.confirm(
      `Attach this EPUB to "${book.title}"? This re-extracts the whole book from the EPUB's real text `
      + "(replacing the current version) and pulls in any illustrations it contains.",
    )) return;
    setEpubBusy(true);
    setErr("");
    try {
      const { job_id: jobId } = await attachEpubToBook(book.book_id, file, {
        title: book.title, artStyle: book.art_style,
      });
      onJobStarted?.(jobId);
      await pollJob(jobId);
      await onRefresh?.();
    } catch (e) {
      setErr(e?.message || "Could not attach EPUB.");
    } finally {
      setEpubBusy(false);
    }
  }

  function openRename() {
    setRenameValue(book?.title || "");
    setRenameOpen(true);
  }

  async function handleSaveRename() {
    const title = renameValue.trim();
    if (!title || title === book?.title) {
      setRenameOpen(false);
      return;
    }
    setRenameBusy(true);
    setErr("");
    try {
      await renameBook(book.book_id, title);
      await onRefresh?.();
      setRenameOpen(false);
    } catch (e) {
      setErr(e?.message || "Could not rename book.");
    } finally {
      setRenameBusy(false);
    }
  }

  // Extraction has a real, durable pin (book.extract_provider) — picking a
  // different explicit provider re-pins the book, so confirm first. "auto"
  // and a first-ever extraction (no existing pin) skip the confirm.

  async function handleReExtract() {

    const pinned = book?.extract_provider;

    if (extractProvider !== "auto" && pinned && pinned !== extractProvider) {

      setPinConfirmOpen(true);

      return;

    }

    await runReExtract();

  }



  if (!open) return null;



  return (

    <div className="vae-sheet-backdrop" data-testid="reader-menu" onClick={onClose}>

      <div className="vae-sheet vae-player-menu-sheet" onClick={(e) => e.stopPropagation()}>

        <header className="vae-sheet-head">

          <h2>Settings</h2>

          <button type="button" className="vae-sheet-close" onClick={onClose}>×</button>

        </header>

        <section className="vae-menu-section">
          <button type="button" className="vae-menu-link" data-testid="use-simple-view"
            onClick={() => {
              setPref(KEYS.uiMode, "simple");
              setPrefs((p) => ({ ...p, uiMode: "simple" }));
              onClose();
            }}>
            Use simple view
          </button>
        </section>

        {!offline && (

          <section className="vae-menu-section">

            <h3>Art style</h3>

            <ArtStyleSwitcher book={book} disabled={disabled || extractBusy} onRefresh={onRefresh}
              onJobStarted={onRegenStarted} onRegenFailed={onRegenFailed} />

            <div className="vae-menu-actions">

              <label className="vae-upload-style">Extraction provider
                <ProviderSelect lane="extract" connection={activeConnection} value={extractProvider}
                  onChange={setExtractProvider} testId="re-extract-provider"
                  disabled={disabled || extractBusy} />
              </label>

              <button type="button" className="vae-menu-link" data-testid="re-extract-script"

                disabled={disabled || extractBusy || busy}

                onClick={handleReExtract}>

                {extractBusy ? "Re-extracting script…" : "Re-extract script"}

              </button>

              <button type="button" className="vae-menu-link" data-testid="expression-repass"

                disabled={disabled || extractBusy || expressionRepassBusy}

                onClick={handleExpressionRepass}>

                {expressionRepassBusy ? "Re-tagging expressions…" : "Re-tag expressions"}

              </button>

              <span className="vae-sheet-hint" data-testid="text-source-indicator">
                {book?.text_source === "m4b_transcript"
                  ? "Text source: audio transcript (no EPUB attached yet)"
                  : "Text source: EPUB ✓"}
              </span>

              {renameOpen ? (
                <>
                  <label className="vae-sheet-field">
                    Book title
                    <input type="text" className="vae-input" data-testid="rename-book-input"
                      value={renameValue} onChange={(e) => setRenameValue(e.target.value)}
                      disabled={renameBusy} autoFocus />
                  </label>
                  <button type="button" className="vae-menu-link" data-testid="rename-book-save"
                    disabled={renameBusy || !renameValue.trim()} onClick={handleSaveRename}>
                    {renameBusy ? "Saving…" : "Save"}
                  </button>
                  <button type="button" className="vae-menu-link" data-testid="rename-book-cancel"
                    disabled={renameBusy} onClick={() => setRenameOpen(false)}>
                    Cancel
                  </button>
                </>
              ) : (
                <button type="button" className="vae-menu-link" data-testid="rename-book"
                  disabled={disabled} onClick={openRename}>
                  Rename…
                </button>
              )}

              <label className="vae-menu-link" data-testid="attach-epub">
                {epubBusy ? "Attaching EPUB…" : "Attach EPUB…"}
                <input type="file" accept=".epub,application/epub+zip" hidden
                  data-testid="attach-epub-input" onChange={handleAttachEpub}
                  disabled={disabled || extractBusy || epubBusy} />
              </label>

              <button type="button" className="vae-menu-link" data-testid="open-replace"

                disabled={disabled || extractBusy}

                onClick={() => { onClose(); onOpenReplace?.(); }}>

                Replace art…

              </button>

              {onOpenPlates && (

                <button type="button" className="vae-menu-link" data-testid="open-character-settings"

                  disabled={disabled || extractBusy}

                  onClick={() => { onClose(); onOpenPlates(); }}>

                  Character settings…

                </button>

              )}

              {onOpenPipeline && (

                <button type="button" className="vae-menu-link" data-testid="open-pipeline-menu"

                  onClick={() => { onClose(); onOpenPipeline(); }}>

                  AI Pipeline…

                </button>

              )}

            </div>

          </section>

        )}



        <DisplaySettings prefs={prefs} setPrefs={setPrefs}

          onToggleFullscreen={onToggleFullscreen} showFullscreen />



        <PlaybackSettings prefs={prefs} setPrefs={setPrefs} />



        <AudiobookSyncSettings prefs={prefs} setPrefs={setPrefs}

          m4bStatus={m4bStatus} onAttachM4b={onAttachM4b} onRemoveM4b={onRemoveM4b} />



        <section className="vae-menu-section">

          <h3>Voices</h3>

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

          <p className="vae-sheet-hint">Filter by chapter for long books. Primary characters appear first.</p>

          {chapters.length > 0 && (

            <label className="vae-sheet-field vae-voice-chapter-filter">

              Characters in chapter

              <select data-testid="voice-chapter-filter" value={voiceChapter}

                onChange={(e) => setVoiceChapter(parseInt(e.target.value, 10))}>

                {chapters.map((ch) => (

                  <option key={ch.chapter} value={ch.chapter}>

                    {chapterLabel(ch, book?.chapters)}

                  </option>

                ))}

              </select>

            </label>

          )}

          {chapterCharacters.length === 0 && (

            <p className="vae-sheet-hint">No speaking characters in this chapter.</p>

          )}

          {chapterCharacters.map((c) => (

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

          <button type="button" className="vae-menu-link" data-testid="voice-save" disabled={busy}

            onClick={saveVoices}>

            {busy ? "Saving voices…" : "Save voices"}

          </button>

        </section>



        {err && <p className="vae-sheet-err">{err}</p>}

      </div>

      <PinMismatchConfirm
        open={pinConfirmOpen}
        current={book?.extract_provider}
        requested={extractProvider}
        busy={extractBusy}
        onCancel={() => setPinConfirmOpen(false)}
        onConfirm={runReExtract}
      />

    </div>

  );

}

