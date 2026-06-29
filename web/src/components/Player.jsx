import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import Stage from "./Stage.jsx";

import DialogueBox from "./DialogueBox.jsx";

import Controls from "./Controls.jsx";

import CheckpointOverlay from "./CheckpointOverlay.jsx";

import ProcessingBar from "./ProcessingBar.jsx";

import PlayerMenu from "./PlayerMenu.jsx";

import ReplaceArtSheet from "./ReplaceArtSheet.jsx";

import EpubPlatesSheet from "./EpubPlatesSheet.jsx";

import IllustrationGallerySheet from "./IllustrationGallerySheet.jsx";

import BannerStack from "./BannerStack.jsx";

import { collectIllustrations } from "../illustrationGallery.js";
import { formatRegenRequestError } from "../clientBanners.js";

import { useCompareModal } from "../hooks/compareModalContext.jsx";
import { useRegenFeedback } from "../hooks/useRegenFeedback.js";

import { Orchestrator } from "../audio/orchestrator.js";

import { fetchBook, backendConfigured, generateMomentIllustration, unlockImaging } from "../api.js";
import { useJobEvents, activeJobIdForBook } from "../hooks/useJobEvents.js";
import ProcessingLog from "./ProcessingLog.jsx";

import { resumeIndex, saveResume } from "../library.js";

import { bookDurationSec, elapsedSec, formatClock } from "../bookTiming.js";

import { spotlightCharacterId } from "../audio/lineKinds.js";

import { KEYS, setPref } from "../audio/voicePrefs.js";

import {

  buildChapterIndex,

  chapterLabel,

  chapterRelativeIndex,

  sliceLinesForChapter,

} from "../chapterNav.js";



function flatten(book) {

  const lines = [];

  const sceneOf = [];

  (book.scenes || []).forEach((s, si) => {

    (s.lines || []).forEach((ln) => { lines.push(ln); sceneOf.push(si); });

  });

  return { lines, sceneOf };

}



export default function Player({ book, prefs, setPrefs, offline, onOpenPipeline }) {

  const [bk, setBk] = useState(book);

  useEffect(() => { setBk(book); }, [book]);



  const { lines, sceneOf } = useMemo(() => flatten(bk), [bk]);

  const chapters = useMemo(() => buildChapterIndex(bk.scenes), [bk.scenes]);

  const [st, setSt] = useState({ status: "idle", index: 0, revealed: 0, speakerId: null });

  const [checkpoint, setCheckpoint] = useState(false);

  const [menuOpen, setMenuOpen] = useState(false);

  const [replaceOpen, setReplaceOpen] = useState(false);
  const [platesOpen, setPlatesOpen] = useState(false);

  const {
    comparePending,
    startCompareJob,
    completeCompareChoice,
    ingestCompareFromJob,
    onResolvedRef,
  } = useCompareModal();

  const { clientBanners, ackRegenStart, failRegenStart, imagingJob, processingLog, releaseServerLock, stopImaging } =
    useRegenFeedback(bk.book_id);

  const bookJobId = activeJobIdForBook(bk);
  const bookStillProcessing = bk.status !== "error" && bk.status !== "ready"
    && (bk.progress != null && bk.progress < 1);
  const { log: bookEventLog, status: bookJobStatus } = useJobEvents(bookJobId, {
    enabled: Boolean(bookJobId && bookStillProcessing && !imagingJob.active && !offline && backendConfigured()),
    onTerminal: () => { refreshBook().catch(() => {}); },
  });

  const regenWatchStop = useRef(null);

  const unlockAttemptedRef = useRef(false);

  const staleLockReleaseRef = useRef(false);

  const resumedJobRef = useRef(null);

  const [activeFlash, setActiveFlash] = useState({ url: null, key: "" });

  const [flashActive, setFlashActive] = useState(false);

  const [flashManual, setFlashManual] = useState(false);

  const [flashDismissSignal, setFlashDismissSignal] = useState(0);

  const manualFlashRef = useRef(false);

  const manualFlashLineRef = useRef(null);

  const [illusGalleryOpen, setIllusGalleryOpen] = useState(false);

  const [unlockedMax, setUnlockedMax] = useState(0);

  const [momentBusy, setMomentBusy] = useState(false);

  const [momentErr, setMomentErr] = useState("");

  const playerRef = useRef(null);

  const orchRef = useRef(null);

  const lastSaved = useRef(-1);

  const linesRef = useRef(lines);

  const bookIdRef = useRef(bk.book_id);

  linesRef.current = lines;

  bookIdRef.current = bk.book_id;



  useEffect(() => () => clearRegenWatch(), []);



  useEffect(() => {

    unlockAttemptedRef.current = false;

    staleLockReleaseRef.current = false;

    resumedJobRef.current = null;

  }, [bk.book_id]);



  useEffect(() => {

    if (offline || !backendConfigured() || !bk.book_id) return;

    if (imagingJob.active) return;

    const stuck = bk.status === "ready" && (

      (bk.styles || []).some((s) => s.status === "generating")

    );

    if (!stuck || unlockAttemptedRef.current) return;

    unlockAttemptedRef.current = true;

    releaseServerLock().then(() => refreshBook()).catch(() => {

      unlockAttemptedRef.current = false;

    });

  }, [bk.book_id, bk.status, bk.stage, bk.styles, imagingJob.active, offline, releaseServerLock]);



  function handleRegenStarted(jobId, meta) {
    clearRegenWatch();
    const withCompare = meta?.compare !== false;
    if (withCompare) startCompareJob(jobId);
    regenWatchStop.current = ackRegenStart(jobId, meta, {
      holdAfterDone: withCompare,
      onDone: (st) => {
        resumedJobRef.current = null;
        refreshBook().catch(() => {});
        if (withCompare) ingestCompareFromJob(jobId, st?.comparisons);
      },
      onError: () => {
        clearRegenWatch();
        resumedJobRef.current = null;
        refreshBook().catch(() => {});
      },
    });
    if (!withCompare) {
      clearRegenWatch();
      refreshBook().catch(() => {});
    }
  }

  function handleCompareResolved() {
    refreshBook().catch(() => {});
    const more = completeCompareChoice();
    if (!more) {
      clearRegenWatch();
      stopImaging();
    }
  }

  useEffect(() => {
    onResolvedRef.current = handleCompareResolved;
    return () => {
      onResolvedRef.current = () => {};
    };
  });

  useEffect(() => {
    if (offline || !backendConfigured() || !bk.book_id) return;
    if (imagingJob.active || comparePending) return;
    // Only clear orphan locks — active_job_id means a job is running (SSE handles progress).
    if (!bk.imaging_locked || bk.active_job_id) return;
    if (staleLockReleaseRef.current) return;
    staleLockReleaseRef.current = true;
    releaseServerLock().then(() => refreshBook()).catch(() => {
      staleLockReleaseRef.current = false;
    });
  }, [bk.book_id, bk.imaging_locked, bk.active_job_id, imagingJob.active, comparePending, offline, releaseServerLock]);



  const allBanners = useMemo(

    () => [...(bk.banners || []), ...clientBanners],

    [bk.banners, clientBanners],

  );



  const processing = bk.status !== "error" && bk.status !== "ready"
    && (bk.progress != null && bk.progress < 1);

  const imaging = imagingJob.active;

  const showProcessingBar = processing || imaging || comparePending;

  const barStage = imagingJob.active ? imagingJob.stage : (bookJobStatus?.stage || bk.stage);

  const barProgress = imagingJob.active ? imagingJob.progress : (bookJobStatus?.progress ?? bk.progress);

  const barLabel = imagingJob.active ? imagingJob.label : (bookJobStatus?.detail || null);

  const barProviderWait = imagingJob.active && imagingJob.providerWait;

  const barSource = imagingJob.active ? "job" : "book";

  const displayProcessingLog = imagingJob.active ? processingLog : bookEventLog;



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

    setUnlockedMax(start);

    setSt((s) => ({ ...s, index: start, revealed: 0, status: "idle" }));

  }, [bk.book_id, lines.length, bk.resume]);



  useEffect(() => {

    setUnlockedMax((prev) => Math.max(prev, st.index));

  }, [st.index]);



  useEffect(() => () => orch.stop(), []);



  async function refreshBook() {

    const fresh = await fetchBook(bk.book_id);

    setBk(fresh);

    return fresh;

  }



  function clearRegenWatch() {

    regenWatchStop.current?.();

    regenWatchStop.current = null;

  }



  const sceneIndex = sceneOf[st.index] ?? 0;

  const scene = (bk.scenes || [])[sceneIndex] || null;

  const curLine = lines[st.index] || null;

  const spotlightId = useMemo(

    () => spotlightCharacterId(lines, st.index),

    [lines, st.index],

  );



  const illustrationItems = useMemo(
    () => collectIllustrations(bk, unlockedMax),
    [bk, unlockedMax],
  );

  const lineSprites = useMemo(() => {

    const map = {};

    if (curLine?.sprite_url && curLine.character_id) {

      map[curLine.character_id] = curLine.sprite_url;

    }

    return map;

  }, [curLine?.sprite_url, curLine?.character_id]);

  const { chapter: curChapter, relIndex, chapterTotal } = chapterRelativeIndex(chapters, st.index);

  const progressScope = prefs.progressScope === "book" ? "book" : "chapter";

  const chapterScoped = progressScope === "chapter" && curChapter;

  const scrubMin = chapterScoped ? curChapter.startLine : 0;

  const scrubMax = chapterScoped

    ? curChapter.endLine

    : Math.max(0, lines.length - 1);

  const displayIndex = chapterScoped ? relIndex + 1 : st.index + 1;

  const displayTotal = chapterScoped ? chapterTotal : lines.length;

  const progressHint = chapterScoped

    ? (curChapter ? `Ch. ${curChapter.chapter}` : "")

    : "entire book";



  const scopeLines = chapterScoped

    ? sliceLinesForChapter(lines, curChapter)

    : lines;

  const scopeTotalSec = bookDurationSec(scopeLines, prefs.speed);

  const scopeElapsed = chapterScoped && curChapter

    ? Math.max(0, elapsedSec(lines, st.index, st.revealed, prefs.speed)

      - elapsedSec(lines, curChapter.startLine, 0, prefs.speed))

    : elapsedSec(lines, st.index, st.revealed, prefs.speed);



  function toggleProgressScope() {

    const next = progressScope === "chapter" ? "book" : "chapter";

    setPref(KEYS.progressScope, next);

    setPrefs((p) => ({ ...p, progressScope: next }));

  }



  function jumpToChapter(chapterNum) {

    const ch = chapters.find((c) => c.chapter === chapterNum);

    if (ch) seekTo(ch.startLine);

  }



  async function handleGenerateMoment(lineIdx) {

    setMomentBusy(true);

    setMomentErr("");

    try {

      const diversify = Boolean(lines[lineIdx]?.illustration_url);

      const res = await generateMomentIllustration(bk.book_id, {

        lineIdx,

        tweakScript: true,

        diversify,

      });

      regenWatchStop.current = ackRegenStart(res.job_id, {
        label: `moment · slide ${lineIdx + 1}`,
        compare: diversify,
      }, {
        holdAfterDone: diversify,
        onDone: () => {
          refreshBook();
          setMomentBusy(false);
          if (!diversify) stopImaging();
        },
        onError: () => {
          setMomentBusy(false);
          stopImaging();
        },
      });

      if (diversify) startCompareJob(res.job_id);

    } catch (e) {

      const msg = formatRegenRequestError(e);

      setMomentErr(msg);

      failRegenStart(msg);

      setMomentBusy(false);

    }

  }



  useEffect(() => {

    if (manualFlashRef.current) {

      if (manualFlashLineRef.current != null && st.index !== manualFlashLineRef.current) {

        manualFlashRef.current = false;

        manualFlashLineRef.current = null;

        setFlashManual(false);

      } else {

        return;

      }

    }

    if (!curLine?.illustration_url) return;

    setActiveFlash({

      url: curLine.illustration_url,

      key: `${st.index}-${curLine.illustration_url}`,

    });

    setFlashDismissSignal(0);

    setFlashActive(true);

  }, [st.index, curLine?.illustration_url]);



  const onFlashDone = useCallback(() => {

    manualFlashRef.current = false;

    manualFlashLineRef.current = null;

    setFlashManual(false);

    setFlashActive(false);

  }, []);

  const dismissFlash = useCallback(() => setFlashDismissSignal((n) => n + 1), []);



  const speakerName = curLine

    ? (bk.characters?.[curLine.character_id]?.name || curLine.speaker_name || "")

    : "";



  const play = () => { setCheckpoint(false); orch.play(lines, st.index); };

  const pause = () => orch.pause();

  const next = (steps = prefs.nextSteps || 1) => { setCheckpoint(false); orch.next(steps); };

  const rewind = (steps = prefs.rewindSteps || 3) => {

    setCheckpoint(false);

    dismissFlash();

    orch.rewind(steps);

  };

  const seekTo = (index, { preserveFlash = false } = {}) => {

    setCheckpoint(false);

    if (!preserveFlash) dismissFlash();

    orch.seek(index);

  };

  const showIllustration = (url, { manual = false, lineIdx = null } = {}) => {

    if (!url) return;

    manualFlashRef.current = manual;

    manualFlashLineRef.current = manual ? lineIdx : null;

    setFlashManual(manual);

    setActiveFlash({ url, key: manual ? `manual-${Date.now()}` : `view-${Date.now()}` });

    setFlashDismissSignal(0);

    setFlashActive(true);

  };

  const advanceClick = () => {

    if (st.revealed < (curLine?.text.length || 0)) orch.revealAll();

    else if (!prefs.autoAdvance) next(1);

  };

  const continueCheckpoint = () => { setCheckpoint(false); orch.play(lines, st.index + 1); };



  function toggleFullscreen() {

    const el = playerRef.current;

    if (!el) return;

    if (!document.fullscreenElement) {

      el.requestFullscreen?.().then(() => {

        setPrefs((p) => ({ ...p, fullscreen: true }));

      }).catch(() => {});

    } else {

      document.exitFullscreen?.().then(() => {

        setPrefs((p) => ({ ...p, fullscreen: false }));

      }).catch(() => {});

    }

  }



  const notReady = lines.length === 0;

  const totalSec = bookDurationSec(lines, prefs.speed);

  const elapsed = elapsedSec(lines, st.index, st.revealed, prefs.speed);



  const playerCls = [

    "vae-player",

    `theme-${prefs.theme}`,

    prefs.portraitLayout ? "vae-player-portrait" : "",

    prefs.fullscreen ? "vae-player-fullscreen" : "",

  ].filter(Boolean).join(" ");



  return (

    <div ref={playerRef} className={playerCls}>

      <BannerStack banners={allBanners} bookId={bk.book_id} />

      {(showProcessingBar) && (
        <>
        <ProcessingBar
          stage={barStage}
          progress={barProgress}
          label={barLabel}
          source={barSource}
          providerWait={barProviderWait}
        />
        <ProcessingLog entries={displayProcessingLog} />
        </>
      )}



      <div className="vae-player-toolbar">

        {chapters.length > 0 && (

          <label className="vae-chapter-select-wrap">

            <select className="vae-chapter-select" data-testid="chapter-select"

              value={curChapter?.chapter ?? chapters[0].chapter}

              onChange={(e) => jumpToChapter(parseInt(e.target.value, 10))}

              aria-label="Jump to chapter">

              {chapters.map((ch) => (

                <option key={ch.chapter} value={ch.chapter}>{chapterLabel(ch, bk.chapters)}</option>

              ))}

            </select>

          </label>

        )}

        <div className="vae-toolbar-spacer" />

        <button type="button" className="vae-toolbar-btn vae-menu-btn" data-testid="open-voices"

          onClick={() => setMenuOpen(true)} aria-label="Settings">

          ☰

        </button>

        {lines.length > 0 && (

          <button type="button" className="vae-toolbar-btn vae-illus-btn" data-testid="show-illustration"

            onClick={() => setIllusGalleryOpen(true)}>

            Illustrations

            {illustrationItems.length > 0 && (
              <span className="vae-illus-badge">{illustrationItems.length}</span>
            )}

          </button>

        )}

      </div>



      {notReady ? (

        <div className="vae-preparing" data-testid="preparing">

          <span className="vae-spinner" />

          <p>Preparing this book… the story will appear here as soon as the text is analyzed.</p>

        </div>

      ) : (

        <>

          <Stage scene={scene} characters={bk.characters} speakerId={spotlightId}

            lineSprites={lineSprites}

            curExpression={curLine?.expression}

            borders={prefs.spriteBorders} pixelFilter={bk.art_filter === "pixel"}

            portraitLayout={prefs.portraitLayout}

            illustrationFlash={activeFlash.url}

            lineKey={activeFlash.key}

            flashActive={flashActive}

            flashDismissSignal={flashDismissSignal}

            flashManual={flashManual}

            onFlashDone={onFlashDone}

            onDismissFlash={dismissFlash}

            onSwipeNext={() => next(prefs.nextSteps || 1)}

            onSwipePrev={() => rewind(prefs.rewindSteps || 3)}>

            <DialogueBox line={curLine} speakerName={speakerName} revealed={st.revealed}

              style={prefs.displayStyle} onAdvance={advanceClick} />

            {checkpoint && <CheckpointOverlay onContinue={continueCheckpoint} />}

          </Stage>



          <div className="vae-player-bottom">

          <div className="vae-progress-wrap">

            <input type="range" className="vae-scrub" data-testid="progress-scrub"

              min={scrubMin} max={scrubMax} value={st.index}

              onChange={(e) => seekTo(parseInt(e.target.value, 10))} />

            <div className="vae-progress-meta">

              <button type="button" className="vae-progress-label vae-progress-toggle"

                data-testid="progress" data-scope={progressScope}

                data-index={st.index} data-total={lines.length} data-status={st.status}

                title="Click to toggle chapter vs entire book"

                onClick={toggleProgressScope}>

                {displayIndex} / {displayTotal} · {progressHint}

              </button>

              <span className="vae-progress-time" data-testid="progress-time">

                {formatClock(scopeElapsed)} / {formatClock(chapterScoped ? scopeTotalSec : totalSec)}

              </span>

            </div>

          </div>



          <Controls prefs={prefs} setPrefs={setPrefs} status={st.status}

            onPlay={play} onPause={pause} onNext={next} onRewind={rewind} />

          </div>

        </>

      )}



      <PlayerMenu book={bk} open={menuOpen} onClose={() => setMenuOpen(false)}

        prefs={prefs} setPrefs={setPrefs} offline={offline}

        onOpenReplace={() => setReplaceOpen(true)}

        onOpenPlates={() => setPlatesOpen(true)}

        onOpenPipeline={onOpenPipeline}

        onRefresh={refreshBook}

        onJobStarted={() => refreshBook()}

        onRegenStarted={handleRegenStarted}

        onRegenFailed={failRegenStart}

        onToggleFullscreen={toggleFullscreen}

        onSaved={(saved) => setBk((b) => ({ ...b, voice_overrides: saved }))}

        disabled={imaging || imagingJob.active} />



      <ReplaceArtSheet book={bk} open={replaceOpen} onClose={() => setReplaceOpen(false)}

        onStarted={handleRegenStarted}

        onFailed={failRegenStart}

        onUploaded={() => refreshBook().catch(() => {})} />

      <EpubPlatesSheet
        book={bk}
        open={platesOpen}
        onClose={() => setPlatesOpen(false)}
        onSaved={() => refreshBook().catch(() => {})}
      />

      <IllustrationGallerySheet
        open={illusGalleryOpen}
        onClose={() => { setIllusGalleryOpen(false); setMomentErr(""); }}
        items={illustrationItems}
        currentLineIdx={st.index}
        currentLine={curLine}
        onGenerateMoment={handleGenerateMoment}
        momentBusy={momentBusy}
        momentErr={momentErr}
        onSelect={(it) => {
          setIllusGalleryOpen(false);
          if (it.lineIdx != null) seekTo(it.lineIdx, { preserveFlash: true });
          showIllustration(it.url, { manual: true, lineIdx: it.lineIdx ?? st.index });
        }}
      />

    </div>

  );

}

