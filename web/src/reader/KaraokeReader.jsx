import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { buildLineIndex, activeLineIndex, lineReveal } from "./karaoke.js";
import { paginate, pageOfLine } from "./pagination.js";
import {
  loadSharedAudio, unloadSharedAudio, playSharedContinuous, stopSharedAudio,
  getSharedAudioCurrentTimeMs, seekSharedAudioMs, setSharedAudioPlaybackRate,
} from "../audio/sharedAudioSource.js";
import "./reader.css";

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

/**
 * The M4B-first minimal reader: an auto-scrolling, auto-paginating karaoke book.
 * The audiobook's own playhead is the master clock (sharedAudioSource) — a rAF
 * loop reads it each frame and drives the highlight imperatively (word wipes at
 * 60fps must not churn React), while React state handles only page turns and
 * font-size re-pagination.
 *
 * Pages are procedurally generated from the user's font size: every sentence is
 * measured offscreen at that size and greedily packed into pages that fit the
 * stage. When narration crosses into a sentence on the next page, the page turns
 * itself.
 *
 * @param {{lines:Array, durationMs:number, title?:string}} transcript
 * @param {Blob} blob  The audiobook file (also drives the audio element).
 */
export default function KaraokeReader({ transcript, blob, initialFontSizePx = 28, onExit }) {
  const lines = transcript?.lines || [];
  const durationMs = transcript?.durationMs || 0;
  const lineIndex = useMemo(() => buildLineIndex(lines), [lines]);

  const [fontSizePx, setFontSizePx] = useState(initialFontSizePx);
  const [pages, setPages] = useState([]);
  const [currentPage, setCurrentPage] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);

  const stageRef = useRef(null);
  const measureRef = useRef(null);
  const lineElRefs = useRef(new Map()); // lineIdx -> sentence element (current page only)
  const wordElRefs = useRef(new Map()); // lineIdx -> [word span elements]
  const scrubRef = useRef(null);
  const timeLabelRef = useRef(null);
  const rafRef = useRef(0);
  const currentPageRef = useRef(0);
  const activeLineRef = useRef(-1);
  const activeWordRef = useRef(-1);
  const pagesRef = useRef([]);

  useEffect(() => { pagesRef.current = pages; }, [pages]);
  useEffect(() => { currentPageRef.current = currentPage; }, [currentPage]);

  // Load the audiobook blob into the single shared <audio> element once.
  useEffect(() => {
    if (!blob) return undefined;
    loadSharedAudio(blob);
    return () => { stopSharedAudio(); unloadSharedAudio(); };
  }, [blob]);

  // Measure every sentence offscreen at the current font size, then paginate.
  // Re-runs when the text or font size changes, or the stage resizes. Measuring
  // all sentences up front is O(lines) DOM work — fine for a chapter/demo; a
  // full multi-thousand-sentence book would want batched/estimated measurement
  // (tracked as a follow-up in docs/M4B_FIRST_FLOW.md).
  const repaginate = useCallback(() => {
    const stage = stageRef.current;
    const meas = measureRef.current;
    if (!stage || !meas || !lines.length) return;
    const cs = getComputedStyle(stage);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    // Match the measurer's text column to the stage's content width so wrapping
    // (and thus measured height) is identical to what the page will render.
    meas.style.width = `${Math.max(1, stage.clientWidth - padX)}px`;
    const heights = [...meas.children].map((el) => el.getBoundingClientRect().height);
    const usable = Math.max(1, stage.clientHeight - padY);
    const pg = paginate(heights, usable);
    setPages(pg);
    // Keep the active sentence on screen across a re-pagination (font change).
    const li = activeLineRef.current;
    if (li >= 0) setCurrentPage(pageOfLine(pg, li));
  }, [lines.length]);

  useLayoutEffect(() => { repaginate(); }, [repaginate, fontSizePx, lines]);
  useEffect(() => {
    const onResize = () => repaginate();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [repaginate]);

  // ── Imperative highlight ──────────────────────────────────────────────────
  // Reconcile line-level classes across the visible page (cheap, runs only when
  // the active sentence changes): past sentences read as fully narrated, the
  // active one gets per-word treatment, upcoming ones stay dim.
  const reconcileLines = useCallback((activeLi) => {
    for (const [li, el] of lineElRefs.current) {
      el.classList.toggle("is-read", li < activeLi);
      el.classList.toggle("is-active", li === activeLi);
    }
  }, []);

  const applyWordHighlight = useCallback((line, li, ms) => {
    const spans = wordElRefs.current.get(li);
    if (!spans) return;
    const reveal = lineReveal(line, ms);
    const active = reveal.activeWord;
    // Only rewrite word classes when the active word advances; the wipe on the
    // active word updates every frame (one style write).
    if (activeWordRef.current !== active || activeLineRef.current !== li) {
      for (let i = 0; i < spans.length; i++) {
        const s = spans[i];
        s.classList.toggle("spoken", i < active);
        s.classList.toggle("active", i === active);
      }
      activeWordRef.current = active;
    }
    if (active >= 0 && spans[active]) {
      spans[active].style.setProperty("--wipe", `${(reveal.wordProgress * 100).toFixed(1)}%`);
    }
  }, []);

  const tick = useCallback(() => {
    const ms = getSharedAudioCurrentTimeMs();
    const li = activeLineIndex(lineIndex, ms);
    if (li >= 0) {
      const pg = pageOfLine(pagesRef.current, li);
      if (pg !== currentPageRef.current) {
        currentPageRef.current = pg;
        setCurrentPage(pg); // React swaps the page; callback refs rebuild the maps
        activeWordRef.current = -1; // force a full word reconcile on the new page
      }
      if (li !== activeLineRef.current) {
        reconcileLines(li);
        activeLineRef.current = li;
      }
      applyWordHighlight(lines[li], li, ms);
    }
    // Scrubber + clock label updated imperatively so playback doesn't re-render.
    if (scrubRef.current && !scrubRef.current.matches(":active")) scrubRef.current.value = String(ms);
    if (timeLabelRef.current) timeLabelRef.current.textContent = fmtTime(ms);
    rafRef.current = requestAnimationFrame(tick);
  }, [lineIndex, lines, reconcileLines, applyWordHighlight]);

  const startRaf = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
  }, [tick]);
  const stopRaf = useCallback(() => cancelAnimationFrame(rafRef.current), []);

  useEffect(() => () => stopRaf(), [stopRaf]);

  // Re-apply the highlight for the current page right after it renders (so a
  // page turn or manual nav lands with correct classes even while paused).
  useLayoutEffect(() => {
    const ms = getSharedAudioCurrentTimeMs();
    const li = activeLineIndex(lineIndex, ms);
    if (li < 0) return;
    activeWordRef.current = -1;
    reconcileLines(li);
    if (lines[li]) applyWordHighlight(lines[li], li, ms);
  }, [currentPage, fontSizePx, lineIndex, lines, reconcileLines, applyWordHighlight]);

  // ── Controls ──────────────────────────────────────────────────────────────
  const play = useCallback(() => {
    setPlaying(true);
    playSharedContinuous(getSharedAudioCurrentTimeMs(), rate, {
      onEnded: () => { setPlaying(false); stopRaf(); },
      onError: () => { setPlaying(false); stopRaf(); },
    });
    startRaf();
  }, [rate, startRaf, stopRaf]);

  const pause = useCallback(() => {
    setPlaying(false);
    stopSharedAudio();
    stopRaf();
  }, [stopRaf]);

  const togglePlay = useCallback(() => { playing ? pause() : play(); }, [playing, play, pause]);

  const seekTo = useCallback((ms) => {
    const clamped = Math.max(0, Math.min(ms, durationMs || ms));
    seekSharedAudioMs(clamped);
    const li = activeLineIndex(lineIndex, clamped);
    if (li >= 0) setCurrentPage(pageOfLine(pagesRef.current, li));
    // Reflect immediately even while paused.
    activeLineRef.current = -1; activeWordRef.current = -1;
    requestAnimationFrame(() => {
      if (li >= 0) { reconcileLines(li); activeLineRef.current = li; if (lines[li]) applyWordHighlight(lines[li], li, clamped); }
      if (scrubRef.current) scrubRef.current.value = String(clamped);
      if (timeLabelRef.current) timeLabelRef.current.textContent = fmtTime(clamped);
    });
  }, [durationMs, lineIndex, lines, reconcileLines, applyWordHighlight]);

  const goToPage = useCallback((p) => {
    const pg = pagesRef.current;
    if (!pg.length) return;
    const clamped = Math.max(0, Math.min(p, pg.length - 1));
    const firstLine = lines[pg[clamped].startLine];
    if (firstLine) seekTo(firstLine.startMs);
    else setCurrentPage(clamped);
  }, [lines, seekTo]);

  const changeRate = useCallback(() => {
    const next = SPEEDS[(SPEEDS.indexOf(rate) + 1) % SPEEDS.length];
    setRate(next);
    setSharedAudioPlaybackRate(next);
  }, [rate]);

  const changeFont = useCallback((delta) => {
    setFontSizePx((f) => Math.max(16, Math.min(64, f + delta)));
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────
  const pageSpan = pages[currentPage] || { startLine: 0, endLine: 0 };
  const pageLines = lines.slice(pageSpan.startLine, pageSpan.endLine);

  const setLineEl = useCallback((li) => (el) => {
    if (el) lineElRefs.current.set(li, el);
    else lineElRefs.current.delete(li);
  }, []);
  const setWordEls = useCallback((li) => (el) => {
    if (el) wordElRefs.current.set(li, [...el.querySelectorAll(".kr-w")]);
    else wordElRefs.current.delete(li);
  }, []);

  return (
    <div className="vae-kr" style={{ "--kr-font": `${fontSizePx}px` }} data-testid="karaoke-reader">
      <header className="vae-kr-head">
        <button type="button" className="vae-kr-exit" onClick={onExit} aria-label="Back to library">‹ Library</button>
        <div className="vae-kr-title">{transcript?.title || "Reading"}</div>
        <div className="vae-kr-font">
          <button type="button" onClick={() => changeFont(-2)} aria-label="Smaller text">A−</button>
          <button type="button" onClick={() => changeFont(2)} aria-label="Larger text">A+</button>
        </div>
      </header>

      <div className="vae-kr-stage" ref={stageRef} data-testid="karaoke-stage">
        {pageLines.map((line) => {
          const li = line.idx;
          return (
            <p key={li} className="vae-kr-line" ref={(el) => { setLineEl(li)(el); setWordEls(li)(el); }}
              onClick={() => seekTo(line.startMs)}>
              {(line.words?.length ? line.words.map((w) => w[0]) : line.text.split(" ")).map((w, wi) => (
                <span key={wi} className="kr-w">{w}{" "}</span>
              ))}
            </p>
          );
        })}
      </div>

      {/* Offscreen measurement pass — same column width & font as the stage, so
          wrapping (and therefore height) matches the rendered page exactly. */}
      <div className="vae-kr-measure" ref={measureRef} aria-hidden="true">
        {lines.map((line) => <p key={line.idx} className="vae-kr-line">{line.text}</p>)}
      </div>

      <footer className="vae-kr-controls">
        <div className="vae-kr-scrubrow">
          <span className="vae-kr-time" ref={timeLabelRef}>0:00</span>
          <input ref={scrubRef} type="range" className="vae-kr-scrub" min={0} max={durationMs || 1}
            defaultValue={0} onChange={(e) => seekTo(Number(e.target.value))} aria-label="Seek" />
          <span className="vae-kr-time">{fmtTime(durationMs)}</span>
        </div>
        <div className="vae-kr-btnrow">
          <button type="button" className="vae-kr-btn" onClick={() => goToPage(currentPage - 1)} aria-label="Previous page">‹</button>
          <button type="button" className="vae-kr-btn vae-kr-play" onClick={togglePlay} data-testid="karaoke-play">
            {playing ? "❚❚" : "▶"}
          </button>
          <button type="button" className="vae-kr-btn" onClick={() => goToPage(currentPage + 1)} aria-label="Next page">›</button>
          <button type="button" className="vae-kr-speed" onClick={changeRate}>{rate}×</button>
          <span className="vae-kr-page">{pages.length ? `${currentPage + 1}/${pages.length}` : "…"}</span>
        </div>
      </footer>
    </div>
  );
}

function fmtTime(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}
