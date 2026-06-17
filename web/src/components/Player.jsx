import { useEffect, useMemo, useRef, useState } from "react";
import Stage from "./Stage.jsx";
import DialogueBox from "./DialogueBox.jsx";
import Controls from "./Controls.jsx";
import CheckpointOverlay from "./CheckpointOverlay.jsx";
import ProcessingBar from "./ProcessingBar.jsx";
import { Orchestrator } from "../audio/orchestrator.js";
import { fetchBook, apiBase } from "../api.js";
import { resumeIndex, saveResume } from "../library.js";

// Flatten scenes into one ordered line stream, remembering each line's scene
// so the Stage can switch background/sprites as the speaker moves between them.
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
  const orchRef = useRef(null);
  const lastSaved = useRef(-1);

  const processing = bk.status !== "error" && (bk.progress != null && bk.progress < 1);

  if (!orchRef.current) {
    orchRef.current = new Orchestrator({
      onState: (s) => {
        setSt(s);
        // persist resume position when the line index changes (not per char)
        if (s.index !== lastSaved.current && (s.status === "playing" || s.status === "paused")) {
          lastSaved.current = s.index;
          const sc = (bk.scenes || [])[sceneOf[s.index] ?? 0];
          saveResume(bk.book_id, {
            line: s.index, sceneId: sc?.id || "", chapter: sc?.chapter || 0,
            total: lines.length,
          });
        }
      },
      onCheckpoint: () => setCheckpoint(true),
      onEnd: () => {},
    });
  }
  const orch = orchRef.current;

  useEffect(() => {
    orch.configure({ speed: prefs.speed, checkpointEvery: prefs.checkpointEvery, autoAdvance: prefs.autoAdvance });
  }, [prefs.speed, prefs.checkpointEvery, prefs.autoAdvance]);

  // Resume: jump to the saved position when a book opens (no autoplay).
  useEffect(() => {
    const start = resumeIndex(bk.book_id, lines.length, bk.resume);
    lastSaved.current = start;
    setSt((s) => ({ ...s, index: start, revealed: 0, status: "idle" }));
  }, [bk.book_id, lines.length]);

  useEffect(() => () => orch.stop(), []);

  // Live media polling: while processing, refetch so newly generated art (and
  // any added lines) appear without interrupting playback.
  useEffect(() => {
    if (offline || !apiBase() || !processing) return undefined;
    const t = setInterval(async () => {
      try {
        const fresh = await fetchBook(bk.book_id);
        setBk((prev) => ({ ...fresh, /* keep nothing stale */ }));
      } catch { /* keep current */ }
    }, 2000);
    return () => clearInterval(t);
  }, [offline, processing, bk.book_id]);

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

  return (
    <div className={`vae-player theme-${prefs.theme}`}>
      {processing && <ProcessingBar stage={bk.stage} progress={bk.progress} />}

      {notReady ? (
        <div className="vae-preparing" data-testid="preparing">
          <span className="vae-spinner" />
          <p>Preparing this book… the story will appear here as soon as the text is analyzed.</p>
        </div>
      ) : (
        <>
          <Stage scene={scene} characters={bk.characters} speakerId={st.speakerId} borders={prefs.spriteBorders}>
            <DialogueBox line={curLine} speakerName={speakerName} revealed={st.revealed}
              style={prefs.displayStyle} onAdvance={advanceClick} />
            {checkpoint && <CheckpointOverlay onContinue={continueCheckpoint} />}
          </Stage>

          <div className="vae-progress">
            <div className="vae-progress-bar"
              style={{ width: `${lines.length ? (st.index / lines.length) * 100 : 0}%` }} />
            <span className="vae-progress-label" data-testid="progress"
              data-index={st.index} data-total={lines.length} data-status={st.status}>
              {st.index + 1} / {lines.length} · {scene?.title || ""}
            </span>
          </div>

          <Controls prefs={prefs} setPrefs={setPrefs} status={st.status}
            onPlay={play} onPause={pause} onNext={next} onRestart={restart} />
        </>
      )}
    </div>
  );
}
