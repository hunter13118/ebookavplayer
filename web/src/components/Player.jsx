import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import Stage from "./Stage.jsx";

import DialogueBox from "./DialogueBox.jsx";

import Controls from "./Controls.jsx";

import TtsErrorModal from "./TtsErrorModal.jsx";

import ProcessingBar from "./ProcessingBar.jsx";

import PlayerMenu from "./PlayerMenu.jsx";

import ReplaceArtSheet from "./ReplaceArtSheet.jsx";

import EpubPlatesSheet from "./EpubPlatesSheet.jsx";

import GapNavSheet from "./GapNavSheet.jsx";

import IllustrationGallerySheet from "./IllustrationGallerySheet.jsx";

import BannerStack from "./BannerStack.jsx";

import { collectIllustrations } from "../illustrationGallery.js";
import { formatRegenRequestError } from "../clientBanners.js";

import { useCompareModal } from "../hooks/compareModalContext.jsx";
import { useRegenFeedback } from "../hooks/useRegenFeedback.js";

import { Orchestrator } from "../audio/orchestrator.js";

import { sleepTimerRemainingMs } from "../audio/timing.js";

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

import { buildSlidesByChapter, computeTimelineFromM4b } from "../timing/index.js";

import { getConnection } from "../backends/connections.js";

import { storeM4b, loadM4b, loadM4bName, removeM4b } from "../offline/m4bStore.js";

import { storeAlignManifest, loadAlignManifest, removeAlignManifest } from "../offline/alignCache.js";

import { loadSharedAudio, unloadSharedAudio } from "../audio/sharedAudioSource.js";



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

  // Sleep timer — pauses playback after real-time minutes elapse, replacing
  // the old line-count-based "are you still listening?" checkpoint. Starts
  // (or restarts) whenever playback begins with a non-zero timer selected.
  const [sleepTimerStartedAt, setSleepTimerStartedAt] = useState(null);
  const [sleepTimerRemaining, setSleepTimerRemaining] = useState(null);

  const [ttsError, setTtsError] = useState(null);

  const [m4bStatus, setM4bStatus] = useState({ attached: false, busy: false, fileName: null, error: null });
  // Progress log for m4b alignment, shown via the same ProcessingLog used
  // for extraction/imaging — see applyM4bTimeline's onChapterProgress/
  // onGapsReady below.
  const [alignEventLog, setAlignEventLog] = useState([]);
  // Background WhisperX alignment can still be streaming in when the user
  // navigates to a different book — this always tracks whichever book_id is
  // CURRENTLY showing, so a stale chunk/result from a previous book's
  // alignment can be told apart and ignored instead of corrupting the new
  // book's timeline/status.
  const activeBookIdRef = useRef(bk.book_id);
  activeBookIdRef.current = bk.book_id;

  const [menuOpen, setMenuOpen] = useState(false);

  const [replaceOpen, setReplaceOpen] = useState(false);
  const [platesOpen, setPlatesOpen] = useState(false);
  const [gapNavOpen, setGapNavOpen] = useState(false);

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



  const processing = bk.status !== "error" && (bk.status !== "ready" || bk.stage !== "done")
    && (bk.progress != null && bk.progress < 1);

  const imaging = imagingJob.active;
  const aligning = Boolean(m4bStatus.aligning);

  const showProcessingBar = processing || imaging || comparePending || aligning;

  const barStage = imagingJob.active ? imagingJob.stage
    : aligning ? "aligning"
    : (bookJobStatus?.stage || bk.stage);

  const barProgress = imagingJob.active ? imagingJob.progress
    : aligning ? (m4bStatus.progress && m4bStatus.progress.total ? m4bStatus.progress.chapter / m4bStatus.progress.total : 0)
    : (bookJobStatus?.progress ?? bk.progress);

  const barLabel = imagingJob.active ? imagingJob.label
    : aligning ? (m4bStatus.progress
        ? `${Math.round(m4bStatus.progress.chapter / 60000)}/${Math.round(m4bStatus.progress.total / 60000)} min transcribed`
        : "Starting…")
    : (bookJobStatus?.detail || null);

  const barProviderWait = imagingJob.active && imagingJob.providerWait;

  const barSource = imagingJob.active ? "job" : aligning ? "align" : "book";

  const displayProcessingLog = imagingJob.active ? processingLog : aligning ? alignEventLog : bookEventLog;



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

      onEnd: () => {

        const total = linesRef.current.length;

        if (!total) return;

        saveResume(bookIdRef.current, {

          line: total, sceneId: "", chapter: 0, total, completed: true,

        });

        lastSaved.current = total;

      },

      onError: (info) => setTtsError(info),

    });

  }

  const orch = orchRef.current;



  useEffect(() => {

    orch.configure({

      speed: prefs.speed,

      autoAdvance: prefs.autoAdvance,

      voiceOverrides: bk.voice_overrides || null,

      timingAlgorithm: prefs.timingAlgorithm,

    });

  }, [prefs.speed, prefs.autoAdvance, bk.voice_overrides, prefs.timingAlgorithm]);

  useEffect(() => {
    if (!sleepTimerStartedAt || !prefs.sleepTimerMinutes) {
      setSleepTimerRemaining(null);
      return undefined;
    }
    const tick = () => {
      const remaining = sleepTimerRemainingMs(sleepTimerStartedAt, prefs.sleepTimerMinutes, Date.now());
      setSleepTimerRemaining(remaining);
      if (remaining === 0) {
        orch.pause();
        setSleepTimerStartedAt(null);
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [sleepTimerStartedAt, prefs.sleepTimerMinutes, orch]);

  // Mode B's tick loop is requestAnimationFrame-driven, which browsers fully
  // suspend while this tab is hidden — playback itself keeps going, but the
  // displayed line/scene/clock go stale until a frame fires again. Catch up
  // instantly the moment the tab is visible again instead of leaving the
  // user looking at a frozen screen until the next natural frame.
  useEffect(() => {
    const onVisibilityChange = () => { if (!document.hidden) orch.resyncDisplay(); };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [orch]);

  const applyM4bTimeline = useCallback(async (blob, fileName) => {

    const slidesByChapter = buildSlidesByChapter(bk);

    if (prefs.timingAlgorithm !== "whisperx") {
      const result = await computeTimelineFromM4b({ blob, slidesByChapter, algorithmId: prefs.timingAlgorithm });
      loadSharedAudio(blob);
      orch.setTimeline(result.lineTimings, result.meta);
      setM4bStatus({ attached: true, busy: false, fileName: fileName || null, error: null, progress: null });
      return;
    }

    const connection = getConnection(prefs.alignConnectionId);
    if (!connection?.baseUrl) {
      throw new Error("Pick an align server connection in Settings before using WhisperX sync.");
    }

    // A fully-resolved manifest from a prior run of this same (unchanged)
    // book + m4b — use it directly, no need for the progressive dance below.
    const cached = await loadAlignManifest(bk.book_id, "whisperx", blob.size, slidesByChapter);
    if (cached) {
      loadSharedAudio(blob);
      orch.setTimeline(cached.lineTimings, cached.meta, cached.syntheticSegments);
      setM4bStatus({ attached: true, busy: false, fileName: fileName || null, error: null, progress: null });
      return;
    }

    // No cache: play immediately on an instant client-side estimate (the
    // same "linear" split algorithm 1 uses — a proportional character-count
    // guess, no acoustics, no network), then refine it live in place as the
    // local align server streams real per-line timings back a chunk at a
    // time — usually starting within seconds, well before the whole book
    // finishes aligning. See whisperxAlignerClient.js / server.py.
    const estimate = await computeTimelineFromM4b({ blob, slidesByChapter, algorithmId: "linear" });
    loadSharedAudio(blob);
    orch.setTimeline(estimate.lineTimings, { ...estimate.meta, strategy: "acoustic" });
    setM4bStatus({
      attached: true, busy: false, fileName: fileName || null, error: null, aligning: true, progress: null,
    });
    setAlignEventLog([]);

    const bookIdAtStart = bk.book_id;
    const isStale = () => activeBookIdRef.current !== bookIdAtStart;

    computeTimelineFromM4b({
      blob, slidesByChapter, algorithmId: "whisperx", connection,
      onChapterProgress: (processedMs, totalMs) => {
        if (isStale()) return;
        setM4bStatus((s) => ({ ...s, aligning: true, progress: { chapter: processedMs, total: totalMs } }));
        setAlignEventLog((log) => [...log, {
          ts: Date.now(), type: "progress",
          text: `Transcribed ${Math.round(processedMs / 60000)}/${Math.round(totalMs / 60000)} min`,
          phase: "aligning", progress: totalMs ? processedMs / totalMs : 0,
        }].slice(-120));
      },
      onLinesReady: (partial) => { if (!isStale()) orch.extendTimeline(partial); },
      onGapsReady: (gaps) => {
        if (isStale()) return;
        orch.extendTimeline(null, gaps);
        setAlignEventLog((log) => [...log, {
          ts: Date.now(), type: "gap",
          text: `Found ${gaps.length} narrator aside${gaps.length === 1 ? "" : "s"} not in the ebook`,
          phase: "aligning", progress: null,
        }].slice(-120));
      },
    }).then(async (finalResult) => {
      if (isStale()) return;
      // Authoritative final merge (covers any line the chunked stream never
      // reached, e.g. right at the tail) + persist for next time.
      orch.setTimeline(finalResult.lineTimings, finalResult.meta, finalResult.syntheticSegments);
      await storeAlignManifest(bk.book_id, "whisperx", blob.size, slidesByChapter, finalResult);
      if (isStale()) return;
      setM4bStatus((s) => ({ ...s, aligning: false, progress: null }));
    }).catch((e) => {
      if (isStale()) return;
      setM4bStatus((s) => ({ ...s, aligning: false, progress: null, error: e?.message || "Alignment failed" }));
    });

  }, [bk, prefs.timingAlgorithm, prefs.alignConnectionId, orch]);



  const handleAttachM4b = useCallback(async (file) => {

    setM4bStatus((s) => ({ ...s, busy: true, error: null }));

    try {

      await storeM4b(bk.book_id, file, file.name);

      await applyM4bTimeline(file, file.name);

    } catch (e) {

      setM4bStatus((s) => ({ ...s, busy: false, error: e?.message || "Failed to attach audiobook" }));

      throw e;

    }

  }, [bk.book_id, applyM4bTimeline]);



  const handleRemoveM4b = useCallback(async () => {

    setM4bStatus((s) => ({ ...s, busy: true }));

    try {

      await removeM4b(bk.book_id);
      await removeAlignManifest(bk.book_id, "whisperx");

    } finally {

      orch.setTimeline(null);

      unloadSharedAudio();

      setM4bStatus({ attached: false, busy: false, fileName: null, error: null });

    }

  }, [bk.book_id, orch]);



  // Auto-reload a previously attached .m4b for this book so it survives a

  // page reload without re-prompting for the file. Falls back silently (TTS

  // playback) when none was ever attached, or it fails to load/scan.

  useEffect(() => {

    let cancelled = false;

    orch.setTimeline(null);

    unloadSharedAudio();

    setM4bStatus({ attached: false, busy: false, fileName: null, error: null });

    (async () => {

      try {

        const blob = await loadM4b(bk.book_id);

        if (!blob || cancelled) return;

        const fileName = await loadM4bName(bk.book_id);

        if (cancelled) return;

        await applyM4bTimeline(blob, fileName);

      } catch {

        // No persisted .m4b for this book, or it failed to load/scan.

      }

    })();

    return () => { cancelled = true; };

    // eslint-disable-next-line react-hooks/exhaustive-deps

  }, [bk.book_id]);



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

  useEffect(() => {
    if (!processing || !backendConfigured()) return undefined;
    const id = setInterval(() => refreshBook().catch(() => {}), 2000);
    return () => clearInterval(id);
  }, [processing]);

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

  // Frozen at the last real scene while a gap plays — st.index deliberately
  // doesn't advance during one (see orchestrator.js), so sceneIndex/scene
  // above already stay put with no special-casing needed. st.line is the
  // orchestrator's own synthetic narrator pseudo-line during a gap (built in
  // Orchestrator._emit) — falls back to the ordinary lines[st.index] lookup
  // the rest of the time, including before the orchestrator's first emit.
  const curLine = st.syntheticSegment ? st.line : (lines[st.index] || null);

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

  // Mode B: prefer the real m4b clock over the character-count estimate.
  // Falls back to the estimate outside acoustic mode or before a chapter's
  // boundary lines have real timings.
  const chapterStartMs = chapterScoped && curChapter ? orch.lineTimings?.[curChapter.startLine]?.startMs : null;

  const chapterEndMs = chapterScoped && curChapter ? orch.lineTimings?.[curChapter.endLine]?.endMs : null;

  const useRealChapterTime = st.durationMs != null && chapterStartMs != null && chapterEndMs != null;

  const scopeTotalSec = useRealChapterTime

    ? (chapterEndMs - chapterStartMs) / 1000

    : bookDurationSec(scopeLines, prefs.speed);

  const scopeElapsed = useRealChapterTime

    ? Math.max(0, Math.min(scopeTotalSec, (st.currentTimeMs - chapterStartMs) / 1000))

    : (chapterScoped && curChapter

      ? Math.max(0, elapsedSec(lines, st.index, st.revealed, prefs.speed)

        - elapsedSec(lines, curChapter.startLine, 0, prefs.speed))

      : elapsedSec(lines, st.index, st.revealed, prefs.speed));



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



  const play = () => {
    if (prefs.sleepTimerMinutes > 0 && !sleepTimerStartedAt) setSleepTimerStartedAt(Date.now());
    orch.play(lines, st.index);
  };

  const pause = () => orch.pause();

  const cancelSleepTimer = () => {
    setSleepTimerStartedAt(null);
    setSleepTimerRemaining(null);
  };

  const next = (steps = prefs.nextSteps || 1) => orch.next(steps);

  const rewind = (steps = prefs.rewindSteps || 3) => {

    dismissFlash();

    orch.rewind(steps);

  };

  const restart = () => {

    dismissFlash();

    orch.play(lines, 0);

  };

  const acknowledgeTtsError = () => {

    setTtsError(null);

    setPref(KEYS.autoAdvance, false);

    setPrefs((p) => ({ ...p, autoAdvance: false }));

  };

  const seekTo = (index, { preserveFlash = false } = {}) => {

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

  const totalSec = st.durationMs != null ? st.durationMs / 1000 : bookDurationSec(lines, prefs.speed);

  const elapsed = st.currentTimeMs != null ? st.currentTimeMs / 1000 : elapsedSec(lines, st.index, st.revealed, prefs.speed);



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

        {orch.syntheticSegments?.length > 0 && (

          <button type="button" className="vae-toolbar-btn vae-gap-nav-btn" data-testid="open-gap-nav"

            onClick={() => setGapNavOpen(true)} aria-label="Narration outside the book">

            Narration outside book

          </button>

        )}

        <div className="vae-toolbar-spacer" />

        <button type="button" className="vae-toolbar-btn vae-menu-btn" data-testid="open-settings"

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

            onSwipePrev={() => rewind(prefs.rewindSteps || 3)}

            sceneDimmed={Boolean(st.syntheticSegment)}>

            <DialogueBox line={curLine} speakerName={speakerName} revealed={st.revealed}

              style={prefs.displayStyle} onAdvance={advanceClick} />

          </Stage>

          {st.buffering && (
            <div className="vae-buffering-badge" data-testid="buffering-badge">
              Buffering…
            </div>
          )}

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



          {sleepTimerRemaining != null && (
            <button type="button" className="vae-sleep-timer-badge" data-testid="sleep-timer-badge"
              onClick={cancelSleepTimer} title="Tap to cancel sleep timer">
              💤 {formatClock(Math.round(sleepTimerRemaining / 1000))}
            </button>
          )}

          <Controls prefs={prefs} setPrefs={setPrefs} status={st.status} index={st.index} lines={lines}

            onPlay={play} onPause={pause} onNext={next} onRewind={rewind} onRestart={restart} />

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

        m4bStatus={m4bStatus} onAttachM4b={handleAttachM4b} onRemoveM4b={handleRemoveM4b}

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

      <GapNavSheet
        open={gapNavOpen}
        onClose={() => setGapNavOpen(false)}
        gaps={orch.syntheticSegments}
        firstLineStartMs={orch.lineTimings?.[0]?.startMs}
        onSeekToGap={(id) => { orch.seekToGap(id); setGapNavOpen(false); }}
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

      <TtsErrorModal open={Boolean(ttsError)} onAcknowledge={acknowledgeTtsError} />

    </div>

  );

}

