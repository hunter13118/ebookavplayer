import { useEffect, useMemo, useState } from "react";

import { fetchEdgeVoices, reExtractBook, subscribeJobEvents, jobEventToStatus, saveVoiceOverrides } from "../api.js";

import ArtStyleSwitcher from "./ArtStyleSwitcher.jsx";

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

  const [err, setErr] = useState("");



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



  async function handleReExtract() {

    setExtractBusy(true);

    setErr("");

    try {

      const { job_id: jobId } = await reExtractBook(book.book_id);

      onJobStarted?.(jobId);

      await pollJob(jobId);

      await onRefresh?.();

    } catch (e) {

      setErr(e?.message || "Could not re-extract script.");

    } finally {

      setExtractBusy(false);

    }

  }



  if (!open) return null;



  return (

    <div className="vae-sheet-backdrop" data-testid="reader-menu" onClick={onClose}>

      <div className="vae-sheet vae-player-menu-sheet" onClick={(e) => e.stopPropagation()}>

        <header className="vae-sheet-head">

          <h2>Settings</h2>

          <button type="button" className="vae-sheet-close" onClick={onClose}>×</button>

        </header>



        {!offline && (

          <section className="vae-menu-section">

            <h3>Art style</h3>

            <ArtStyleSwitcher book={book} disabled={disabled || extractBusy} onRefresh={onRefresh}
              onJobStarted={onRegenStarted} onRegenFailed={onRegenFailed} />

            <div className="vae-menu-actions">

              <button type="button" className="vae-menu-link" data-testid="re-extract-script"

                disabled={disabled || extractBusy || busy}

                onClick={handleReExtract}>

                {extractBusy ? "Re-extracting script…" : "Re-extract script"}

              </button>

              <button type="button" className="vae-menu-link" data-testid="open-replace"

                disabled={disabled || extractBusy}

                onClick={() => { onClose(); onOpenReplace?.(); }}>

                Replace art…

              </button>

              {onOpenPlates && (

                <button type="button" className="vae-menu-link" data-testid="open-epub-plates"

                  disabled={disabled || extractBusy}

                  onClick={() => { onClose(); onOpenPlates(); }}>

                  Art references…

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

    </div>

  );

}

