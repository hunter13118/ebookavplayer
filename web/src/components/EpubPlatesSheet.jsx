import { useEffect, useMemo, useState } from "react";
import {
  backfillIllustrations, matchIllustrationsToCharacters, saveExternalRefs, saveIllustrationRefs,
  subscribeJobEvents, jobEventToStatus,
} from "../api.js";
import {
  characterIllustrationRefs,
  listIllustrationPlates,
  plateAssignmentMap,
} from "../illustrationCatalog.js";
import { mediaImageSrc } from "../media.js";
import CharacterManager from "./CharacterManager.jsx";

function PlateThumb({ url, index }) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) {
    return (
      <div className="vae-plate-thumb vae-plate-thumb-fallback" aria-hidden>
        {index}
      </div>
    );
  }
  return (
    <img
      src={mediaImageSrc(url)}
      alt=""
      className="vae-plate-thumb"
      loading="lazy"
      onError={() => setBroken(true)}
    />
  );
}

function ExternalUrlList({ urls, onRemove }) {
  if (!urls?.length) return <p className="vae-sheet-hint">No URLs yet.</p>;
  return (
    <ul className="vae-ext-ref-list">
      {urls.map((url) => (
        <li key={url}>
          <a href={url} target="_blank" rel="noreferrer noopener">{url}</a>
          <button type="button" className="vae-ext-ref-remove" onClick={() => onRemove(url)}>×</button>
        </li>
      ))}
    </ul>
  );
}

/** EPUB plates + external reference URLs for continuity / BYO prompts. */
export default function EpubPlatesSheet({ book, open, onClose, onSaved }) {
  const plates = useMemo(() => listIllustrationPlates(book), [book]);
  const assignments = useMemo(() => plateAssignmentMap(book), [book]);

  const characters = useMemo(
    () => Object.entries(book?.characters || {})
      .filter(([id]) => id !== "narrator")
      .map(([id, c]) => ({ id, name: c.name || id })),
    [book],
  );

  const [coverRef, setCoverRef] = useState("");
  const [charRefs, setCharRefs] = useState({});
  const [extRefs, setExtRefs] = useState({ characters: {}, book: [] });
  const [draftUrls, setDraftUrls] = useState({});
  const [bookDraftUrl, setBookDraftUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [extBusy, setExtBusy] = useState(false);
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState(false);
  const [extSaved, setExtSaved] = useState(false);
  const [backfillBusy, setBackfillBusy] = useState(false);
  const [backfillResult, setBackfillResult] = useState("");
  const [matchBusy, setMatchBusy] = useState(false);
  const [matchResult, setMatchResult] = useState("");

  useEffect(() => {
    if (!open) return;
    setErr("");
    setSaved(false);
    setExtSaved(false);
    setCoverRef(
      book?.cover_illustration_ref != null ? String(book.cover_illustration_ref) : "",
    );
    setCharRefs(characterIllustrationRefs(book));
    setExtRefs(book?.external_refs || { characters: {}, book: [] });
    setDraftUrls({});
    setBookDraftUrl("");
  }, [open, book?.book_id, book?.cover_illustration_ref, book?.characters, book?.external_refs]);

  if (!open) return null;

  function setCharRef(id, value) {
    setCharRefs((prev) => {
      const next = { ...prev };
      if (!value) delete next[id];
      else next[id] = parseInt(value, 10);
      return next;
    });
  }

  function addExternalUrl(characterId, raw) {
    const url = String(raw || "").trim();
    if (!url) return;
    setExtRefs((prev) => {
      const characters = { ...prev.characters };
      const list = [...(characters[characterId] || [])];
      if (list.includes(url)) return prev;
      list.push(url);
      characters[characterId] = list;
      return { ...prev, characters };
    });
    setDraftUrls((prev) => ({ ...prev, [characterId]: "" }));
  }

  function removeExternalUrl(characterId, url) {
    setExtRefs((prev) => {
      const characters = { ...prev.characters };
      characters[characterId] = (characters[characterId] || []).filter((u) => u !== url);
      if (!characters[characterId]?.length) delete characters[characterId];
      return { ...prev, characters };
    });
  }

  function addBookExternalUrl() {
    const url = bookDraftUrl.trim();
    if (!url) return;
    setExtRefs((prev) => {
      const bookUrls = [...(prev.book || [])];
      if (bookUrls.includes(url)) return prev;
      return { ...prev, book: [...bookUrls, url] };
    });
    setBookDraftUrl("");
  }

  async function handleSavePlates() {
    setBusy(true);
    setErr("");
    setSaved(false);
    try {
      const body = {
        cover_illustration_ref: coverRef === "" ? null : parseInt(coverRef, 10),
        characters: {},
      };
      for (const c of characters) {
        const v = charRefs[c.id];
        body.characters[c.id] = v == null ? null : v;
      }
      const result = await saveIllustrationRefs(book.book_id, body);
      onSaved?.(result);
      setSaved(true);
    } catch (e) {
      setErr(e?.message || "Could not save plate mapping.");
    } finally {
      setBusy(false);
    }
  }

  async function handleBackfill() {
    setBackfillBusy(true);
    setErr("");
    setBackfillResult("");
    try {
      const result = await backfillIllustrations(book.book_id);
      onSaved?.(result);
      setBackfillResult(
        result.plates_found > 0
          ? `Found ${result.plates_found} plate${result.plates_found === 1 ? "" : "s"}.`
          : "No images found in this EPUB.",
      );
    } catch (e) {
      setErr(e?.message || "Could not backfill illustrations.");
    } finally {
      setBackfillBusy(false);
    }
  }

  function waitForJob(jobId) {
    return new Promise((resolve, reject) => {
      const unsub = subscribeJobEvents(jobId, {
        onEvent: (ev) => {
          const st = jobEventToStatus(ev);
          const done = ev.type === "done" || st.status === "done";
          const errored = ev.type === "error" || st.status === "error";
          if (done) { unsub(); resolve(st); }
          else if (errored) { unsub(); reject(new Error(st.detail || st.error || "Matching failed.")); }
        },
        onError: (err) => { unsub(); reject(err || new Error("Lost connection to matching job.")); },
      });
    });
  }

  async function handleMatchCharacters() {
    setMatchBusy(true);
    setErr("");
    setMatchResult("");
    try {
      const { job_id: jobId } = await matchIllustrationsToCharacters(book.book_id);
      const st = await waitForJob(jobId);
      await onSaved?.();
      setMatchResult(st.detail || "Done.");
    } catch (e) {
      setErr(e?.message || "Could not match plates to characters.");
    } finally {
      setMatchBusy(false);
    }
  }

  async function handleSaveExternal() {
    setExtBusy(true);
    setErr("");
    setExtSaved(false);
    try {
      const result = await saveExternalRefs(book.book_id, extRefs);
      onSaved?.(result);
      setExtSaved(true);
    } catch (e) {
      setErr(e?.message || "Could not save external references.");
    } finally {
      setExtBusy(false);
    }
  }

  return (
    <div className="vae-sheet-backdrop" data-testid="epub-plates-sheet" onClick={onClose}>
      <div className="vae-sheet vae-plates-sheet" onClick={(e) => e.stopPropagation()}>
        <header className="vae-sheet-head">
          <h2>Character settings</h2>
          <button type="button" className="vae-sheet-close" onClick={onClose}>×</button>
        </header>

        <section className="vae-menu-section">
          <h3>Characters</h3>
          <p className="vae-sheet-hint">
            Rename a character, edit their description, upload reference pictures, or merge one
            into an existing one if extraction got it wrong (e.g. &ldquo;Unnamed male
            protagonist&rdquo; → Eizo) — applies everywhere, past and future chapters, sprite and
            voice included.
          </p>
          <CharacterManager book={book} onRefresh={onSaved} />
        </section>

        <h3 className="vae-sheet-subhead">EPUB illustrations</h3>
        <p className="vae-sheet-hint">
          EPUB plates come from the book file. External URLs (Fandom, wiki, etc.) are stored separately
          and fetched only when generating art — not copied to R2.
        </p>

        <div className="vae-menu-actions">
          <button
            type="button"
            className="vae-menu-link"
            data-testid="illustrations-backfill"
            disabled={backfillBusy}
            onClick={handleBackfill}
          >
            {backfillBusy ? "Scanning EPUB…" : "Re-scan EPUB for plates"}
          </button>
          {backfillResult && <span className="vae-sheet-hint">{backfillResult}</span>}
        </div>

        {plates.length > 0 && (
          <div className="vae-menu-actions">
            <button
              type="button"
              className="vae-menu-link"
              data-testid="illustrations-match-characters"
              disabled={matchBusy}
              onClick={handleMatchCharacters}
            >
              {matchBusy ? "Matching plates to characters…" : "Auto-match plates to characters"}
            </button>
            {matchResult && <span className="vae-sheet-hint">{matchResult}</span>}
          </div>
        )}

        {plates.length > 0 ? (
          <>
            <div className="vae-plates-grid" data-testid="epub-plates-grid">
              {plates.map((plate) => {
                const usedBy = assignments.get(plate.index) || [];
                return (
                  <figure key={plate.index} className="vae-plate-card" data-testid={`epub-plate-${plate.index}`}>
                    <PlateThumb url={plate.url} index={plate.index} />
                    <figcaption>
                      <span className="vae-plate-label">{plate.label}</span>
                      {usedBy.length > 0 && (
                        <span className="vae-plate-used">{usedBy.join(", ")}</span>
                      )}
                    </figcaption>
                  </figure>
                );
              })}
            </div>

            <section className="vae-menu-section">
              <h3>EPUB plate mapping</h3>
              <label className="vae-sheet-field">
                Cover reference plate
                <span className="vae-select-wrap">
                  <select
                    className="vae-select"
                    data-testid="epub-cover-ref"
                    value={coverRef}
                    onChange={(e) => setCoverRef(e.target.value)}
                  >
                    <option value="">None</option>
                    {plates.map((p) => (
                      <option key={p.index} value={String(p.index)}>{p.label}</option>
                    ))}
                  </select>
                </span>
              </label>

              {characters.map((c) => (
                <label key={c.id} className="vae-sheet-field">
                  {c.name}
                  <span className="vae-select-wrap">
                    <select
                      className="vae-select"
                      data-testid={`epub-char-ref-${c.id}`}
                      value={charRefs[c.id] != null ? String(charRefs[c.id]) : ""}
                      onChange={(e) => setCharRef(c.id, e.target.value)}
                    >
                      <option value="">None</option>
                      {plates.map((p) => (
                        <option key={p.index} value={String(p.index)}>{p.label}</option>
                      ))}
                    </select>
                  </span>
                </label>
              ))}

              <button
                type="button"
                className="vae-menu-link"
                data-testid="epub-plates-save"
                disabled={busy}
                onClick={handleSavePlates}
              >
                {busy ? "Saving…" : saved ? "Saved" : "Save plate mapping"}
              </button>
            </section>
          </>
        ) : (
          <p className="vae-sheet-hint">No EPUB plates yet — re-ingest a book with interior art.</p>
        )}

        <section className="vae-menu-section">
          <h3>External reference URLs</h3>
          <p className="vae-sheet-hint">HTTPS links only. Included in BYO prompts and auto-imaging refs.</p>

          <label className="vae-sheet-field">
            Book-wide references
            <div className="vae-ext-ref-add">
              <input
                type="url"
                className="vae-input"
                placeholder="https://…"
                value={bookDraftUrl}
                data-testid="external-ref-book-input"
                onChange={(e) => setBookDraftUrl(e.target.value)}
              />
              <button type="button" className="vae-btn vae-btn-sm" onClick={addBookExternalUrl}>Add</button>
            </div>
          </label>
          <ExternalUrlList
            urls={extRefs.book}
            onRemove={(url) => setExtRefs((prev) => ({
              ...prev,
              book: (prev.book || []).filter((u) => u !== url),
            }))}
          />

          {characters.map((c) => (
            <div key={c.id} className="vae-ext-ref-char">
              <strong>{c.name}</strong>
              <div className="vae-ext-ref-add">
                <input
                  type="url"
                  className="vae-input"
                  placeholder="https://…"
                  value={draftUrls[c.id] || ""}
                  data-testid={`external-ref-input-${c.id}`}
                  onChange={(e) => setDraftUrls((prev) => ({ ...prev, [c.id]: e.target.value }))}
                />
                <button type="button" className="vae-btn vae-btn-sm" onClick={() => addExternalUrl(c.id, draftUrls[c.id])}>Add</button>
              </div>
              <ExternalUrlList
                urls={extRefs.characters?.[c.id]}
                onRemove={(url) => removeExternalUrl(c.id, url)}
              />
            </div>
          ))}

          <button
            type="button"
            className="vae-menu-link"
            data-testid="external-refs-save"
            disabled={extBusy}
            onClick={handleSaveExternal}
          >
            {extBusy ? "Saving…" : extSaved ? "Saved" : "Save external references"}
          </button>
        </section>

        {err && <p className="vae-sheet-err">{err}</p>}
      </div>
    </div>
  );
}
