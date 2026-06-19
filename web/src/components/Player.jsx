import { useEffect, useMemo, useRef, useState } from "react";
import Stage from "./Stage.jsx";
import DialogueBox from "./DialogueBox.jsx";
import Controls from "./Controls.jsx";
import CheckpointOverlay from "./CheckpointOverlay.jsx";
import ProcessingBar from "./ProcessingBar.jsx";
import ReaderMenu from "./ReaderMenu.jsx";
import ReplaceArtSheet from "./ReplaceArtSheet.jsx";
import ArtStyleSwitcher from "./ArtStyleSwitcher.jsx";
import BannerStack from "./BannerStack.jsx";
import { Orchestrator } from "../audio/orchestrator.js";
import { fetchBook, backendConfigured } from "../api.js";
import { resumeIndex, saveResume } from "../library.js";

function flatten(book) {
  const lines = [];
  const sceneOf = [];
  (book.scenes || []).forEach((s, si) => {
    (s.lines || []).forEach((ln) => { lines.push(ln); sceneOf.push(si); });
  });
  return { lines, sceneOf };
}

export default function Player({ book, prefs, setPrefs, offline }) {
  const [bk, setBk] = useState(book);
  useEffect(() => { setBk(book); }, [book]);

  const { lines, sceneOf } = useMemo(() => flatten(bk), [bk]);
  const [st, setSt] = useState({ status: "idle", index: 0, revealed: 0, speakerId: null });
  const [checkpoint, setCheckpoint] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const orchRef = useRef(null);
  const lastSaved = useRef(-1);
  const linesRef = useRef(lines);
  const bookIdRef = useRef(bk.book_id);
  linesRef.current = lines;
  bookIdRef.current = bk.book_id;

  const processing = bk.status !== "error" && (bk.progress != null && bk.progress < 1);
  const imaging = bk.stage === "imaging"
    || (bk.styles || []).some((s) => s.status === "generating");

  if (!orchRef.current) {
    orchRef.current = new Orchestrator({
      onState: (s) => {
        setSt(s);
        if (s.index !== lastSaved.current && (s.status === "playing" || s.status === "paused")) {
          lastSaved.current = s.index;
          const sc = (bk.scenes || [])[sceneOf[s.index] ?? 0];
          saveResume(bookIdRef.current, {
            line: s.index, sceneId: sc?.id || "", chapter: sc?.chapter || 0,
            total: linesRef.current.length,
          });
        }
      },
      onCheckpoint: () => setCheckpoint(true),
      onEnd: () => {
        const total = linesRef.current.length;
        if (!total) return;
        saveResume(bookIdRef.current, {
          line: total, sceneId: "", chapter: 0, total, completed: true,
        });
        lastSaved.current = total;
      },
    });
  }
  const orch = orchRef.current;

  useEffect(() => {
    orch.configure({
      speed: prefs.speed,
      checkpointEvery: prefs.checkpointEvery,
      autoAdvance: prefs.autoAdvance,
      voiceOverrides: bk.voice_overrides || null,
    });
  }, [prefs.speed, prefs.checkpointEvery, prefs.autoAdvance, bk.voice_overrides]);

  useEffect(() => {
    const start = resumeIndex(bk.book_id, lines.length, bk.resume);
    lastSaved.current = start;
    setSt((s) => ({ ...s, index: start, revealed: 0, status: "idle" }));
  }, [bk.book_id, lines.length]);

  useEffect(() => () => orch.stop(), []);

  useEffect(() => {
    if (offline || !backendConfigured() || (!processing && !imaging)) return undefined;
    const t = setInterval(async () => {
      try {
        const fresh = await fetchBook(bk.book_id);
        setBk(fresh);
      } catch { /* keep current */ }
    }, 2000);
    return () => clearInterval(t);
  }, [offline, processing, imaging, bk.book_id]);

  async function refreshBook() {
    const fresh = await fetchBook(bk.book_id);
    setBk(fresh);
  }

  const sceneIndex = sceneOf[st.index] ?? 0;
  const scene = (bk.scenes || [])[sceneIndex] || null;
  const curLine = lines[st.index] || null;
  const speakerName = curLine
    ? (bk.characters?.[curLine.character_id]?.name || curLine.speaker_name || "")
    : "";

  const play = () => { setCheckpoint(false); orch.play(lines, st.index); };
  const pause = () => orch.pause();
  const next = () => { setCheckpoint(false); orch.next(); };
  const restart = () => { setCheckpoint(false); orch.play(lines, 0); };
  const advanceClick = () => {
    if (st.revealed < (curLine?.text.length || 0)) orch.revealAll();
    else if (!prefs.autoAdvance) next();
  };
  const continueCheckpoint = () => { setCheckpoint(false); orch.play(lines, st.index + 1); };

  const notReady = lines.length === 0;

  const progressPct = lines.length
    ? (st.status === "done" ? 100 : ((st.index + 1) / lines.length) * 100)
    : 0;

  return (
    <div className={`vae-player theme-${prefs.theme}`}>
      <BannerStack banners={bk.banners} bookId={bk.book_id} />
      {(processing || imaging) && <ProcessingBar stage={bk.stage} progress={bk.progress} />}

      <div className="vae-player-toolbar">
        {!offline && (
          <ArtStyleSwitcher book={bk} disabled={imaging}
            onRefresh={refreshBook} onJobStarted={() => refreshBook()} />
        )}
        {!offline && (
          <button type="button" className="vae-toolbar-btn" data-testid="open-replace"
            disabled={imaging} onClick={() => setReplaceOpen(true)}>
            Replace art…
          </button>
        )}
        <button type="button" className="vae-toolbar-btn vae-menu-btn" data-testid="open-voices"
          onClick={() => setMenuOpen(true)}>
          ☰ Voices
        </button>
      </div>

      {notReady ? (
        <div className="vae-preparing" data-testid="preparing">
          <span className="vae-spinner" />
          <p>Preparing this book… the story will appear here as soon as the text is analyzed.</p>
        </div>
      ) : (
        <>
          <Stage scene={scene} characters={bk.characters} speakerId={st.speakerId}
            borders={prefs.spriteBorders} pixelFilter={bk.art_filter === "pixel"}
            illustrationFlash={curLine?.illustration_url}
            lineKey={`${st.index}-${curLine?.illustration_url || ""}`}>
            <DialogueBox line={curLine} speakerName={speakerName} revealed={st.revealed}
              style={prefs.displayStyle} onAdvance={advanceClick} />
            {checkpoint && <CheckpointOverlay onContinue={continueCheckpoint} />}
          </Stage>

          <div className="vae-progress">
            <div className="vae-progress-bar" style={{ width: `${progressPct}%` }} />
            <span className="vae-progress-label" data-testid="progress"
              data-index={st.index} data-total={lines.length} data-status={st.status}>
              {st.index + 1} / {lines.length} · {scene?.title || ""}
            </span>
          </div>

          <Controls prefs={prefs} setPrefs={setPrefs} status={st.status}
            onPlay={play} onPause={pause} onNext={next} onRestart={restart} />
        </>
      )}

      <ReaderMenu book={bk} open={menuOpen} onClose={() => setMenuOpen(false)}
        onSaved={(saved) => setBk((b) => ({ ...b, voice_overrides: saved }))} />

      <ReplaceArtSheet book={bk} open={replaceOpen} onClose={() => setReplaceOpen(false)}
        onStarted={() => refreshBook()} />
    </div>
  );
}
