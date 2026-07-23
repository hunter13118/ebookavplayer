import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { revealFromChars } from "./karaoke.js";
import {
  groupIntoParagraphs, paragraphTokens, paragraphIndexOfLine, gapInsertIndex,
} from "./paragraphs.js";
import { paginate, pageOfLine } from "./pagination.js";
import { backgroundStyle } from "../media.js";
import ArtGallery, { READER_ART_HOLD_MS } from "./ArtGallery.jsx";
import IllustrationFlash from "../components/IllustrationFlash.jsx";
import "./reader.css";

/**
 * Minimal "reader" view — the surface only. Unlike the standalone
 * KaraokeReader (M4B-first harness, which owns its own clock), this renders
 * whatever playback state the orchestrator emits, so it works for EVERY audio
 * source: Edge TTS, silent estimate, per-line m4b, and continuous acoustic m4b
 * alike (docs/VIEW_MODES.md). Playback controls live in the surrounding Player
 * chrome; this component is purely the paginated, auto-scrolling, karaoke text.
 *
 * Per-line (~per-sentence) book lines are re-flowed into PARAGRAPHS
 * (paragraphs.js) before pagination/render — that's what makes this read like
 * a book instead of one fragment per line: consecutive narration merges, a
 * dialogue line keeps its short attribution tag, quote marks come back. Tap a
 * PARAGRAPH to resume playback from its first line.
 *
 * The word bolden derives from `revealed` (the char count the orchestrator
 * typewriters through the active line in every mode), NOT from a clock — that's
 * what makes it uniform across audio sources.
 *
 * @param {Array}   lines         Flattened book lines (array position = index).
 * @param {number[]} [sceneOf]    Parallel array, scene index per line — forces
 *   a paragraph break at every scene change (see paragraphs.js).
 * @param {number}  activeIndex   Orchestrator st.index — the line being read.
 * @param {number}  revealed      Orchestrator st.revealed — chars revealed in the active line.
 * @param {object}  [scene]       Current scene (for the optional dimmed backdrop).
 * @param {number}  [fontSizePx]  Procedural-pagination font size.
 * @param {boolean} [dimBackground]
 * @param {{text:string, syntheticId?:string, leading?:boolean}} [syntheticSegment]
 *   Orchestrator st.syntheticSegment — audio the WhisperX align server heard
 *   that has no counterpart in this book's extracted lines at all (a spoken
 *   intro, an ad-lib, a publisher bumper like "This is Audible."). The words
 *   on screen must match what the listener is actually hearing, so this is
 *   ALWAYS rendered (dimmed/italicized to mark it as "not in the book text",
 *   never hidden or gated behind a modal) for as long as it's the active
 *   segment. Spliced into the paginated paragraph flow itself rather than a
 *   separate banner, so it gets measured/paginated/word-wrapped exactly like
 *   real book text — see reader.css's .vae-kr-gap. `leading` (set by the
 *   orchestrator) says whether this gap plays BEFORE the pinned paragraph's
 *   own line has started (a book's leading intro bumper — splice before) or
 *   after it (the usual mid-book gap — splice after, the historical default).
 * @param {(index:number)=>void} [onSeekLine]  Tap a paragraph to resume from its first line.
 * @param {(deltaPx:number)=>void} [onChangeFontSize]
 * @param {{url:string}[]} [frontMatter]  Art with no chapter to attach to at
 *   all — cover/character-gallery/title-page plates from BEFORE the book's
 *   real text starts (book.front_matter — see matchIllustrationsToChapters
 *   in chapter-extract-pipeline.js). Shown as a gallery (ArtGallery.jsx) the
 *   moment the book is at its very start (activeIndex 0, nothing revealed
 *   yet) — overlaid on top of whatever's already playing underneath (the
 *   m4b's leading gap narration, if any), so real audio is never blocked on
 *   the gallery finishing. Each image holds READER_ART_HOLD_MS, tap/scroll
 *   skips ahead immediately.
 * @param {{url:string}[]} [backMatter]  Same idea for trailing art AFTER the
 *   book's real content ends (a publisher's ad/newsletter page) —
 *   book.back_matter. Shown once `finished`.
 * @param {boolean} [finished]  Orchestrator status === "done" — gates the
 *   back-matter gallery.
 * @param {string} [illustrationUrl]  The active line's illustration_url, if
 *   any (Player.jsx's `activeFlash.url` — the SAME auto-triggered state
 *   cinematic/Stage already renders, just also wired in here so regular
 *   in-book illustrations show up in the reader at all).
 * @param {boolean} [flashActive]  Player.jsx's `flashActive`.
 * @param {number} [flashDismissSignal]  Player.jsx's `flashDismissSignal`.
 * @param {() => void} [onFlashDone]  Player.jsx's flash-finished callback.
 * @param {() => void} [onDismissFlash]  Tap/scroll-to-skip callback.
 */
export default function ReaderView({
  lines, sceneOf, activeIndex = 0, revealed = 0, scene, fontSizePx = 28,
  dimBackground = true, syntheticSegment = null, onSeekLine, onChangeFontSize,
  frontMatter = null, backMatter = null, finished = false,
  illustrationUrl = null, flashActive = false, flashDismissSignal = 0, onFlashDone, onDismissFlash,
}) {
  const paragraphs = useMemo(() => groupIntoParagraphs(lines, sceneOf), [lines, sceneOf]);

  const clampedActiveIndex = Math.min(activeIndex, Math.max(0, lines.length - 1));

  // When a gap is active, splice a synthetic pseudo-paragraph next to the
  // paragraph containing the pinned real line (the orchestrator pins
  // activeIndex to that real line for the whole duration of the gap — see
  // _resolvePosition), so it's measured/paginated/word-wrapped exactly like
  // a real paragraph instead of floating outside the stage. A `leading` gap
  // (the pinned line hasn't actually started yet — e.g. a book's opening
  // publisher bumper) splices BEFORE that paragraph instead of after it, so
  // the reader sees text in the order it's actually spoken.
  const gapInsertAt = useMemo(() => {
    const realIndex = paragraphIndexOfLine(paragraphs, clampedActiveIndex);
    return gapInsertIndex(realIndex, !!syntheticSegment?.leading);
  }, [paragraphs, syntheticSegment, clampedActiveIndex]);

  const displayParagraphs = useMemo(() => {
    if (!syntheticSegment?.text) return paragraphs;
    const synthetic = { synthetic: true, syntheticId: syntheticSegment.syntheticId, text: syntheticSegment.text };
    return [...paragraphs.slice(0, gapInsertAt), synthetic, ...paragraphs.slice(gapInsertAt)];
  }, [paragraphs, syntheticSegment, gapInsertAt]);

  const [pages, setPages] = useState([]);
  const [page, setPage] = useState(0);
  const stageRef = useRef(null);
  const measureRef = useRef(null);
  const activeParaRef = useRef(null);

  // Measure every PARAGRAPH (not line) offscreen at the current font size.
  const repaginate = useCallback(() => {
    const stage = stageRef.current;
    const meas = measureRef.current;
    if (!stage || !meas || !displayParagraphs.length) return;
    const cs = getComputedStyle(stage);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    meas.style.width = `${Math.max(1, stage.clientWidth - padX)}px`;
    const heights = [...meas.children].map((el) => el.getBoundingClientRect().height);
    const usable = Math.max(1, stage.clientHeight - padY);
    setPages(paginate(heights, usable));
  }, [displayParagraphs]);

  useLayoutEffect(() => { repaginate(); }, [repaginate, fontSizePx]);
  useEffect(() => {
    const onResize = () => repaginate();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [repaginate]);

  // Index into displayParagraphs of the paragraph the listener is on right
  // now — the synthetic gap paragraph itself, if one is active (it always
  // lands at gapInsertAt by construction, before or after the real
  // paragraph depending on `leading`), else the real paragraph containing
  // activeIndex.
  const activeDisplayIndex = useMemo(() => {
    if (syntheticSegment?.text) return gapInsertAt;
    return paragraphIndexOfLine(paragraphs, clampedActiveIndex);
  }, [paragraphs, syntheticSegment, clampedActiveIndex, gapInsertAt]);

  // Auto page-turn: keep the active paragraph's page on screen.
  useEffect(() => {
    if (pages.length) setPage(pageOfLine(pages, activeDisplayIndex));
  }, [activeDisplayIndex, pages]);

  // Keep the active paragraph comfortably in view (auto-scroll feel).
  useEffect(() => {
    activeParaRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeDisplayIndex, page]);

  // Front/back-matter galleries — "armed" once (a ref, not re-checked every
  // render) the moment the book is genuinely at its very start/end, then
  // stays active regardless of activeIndex/revealed continuing to change
  // underneath (real playback never waits on the gallery) until ArtGallery
  // reports it finished. Re-arms on a real book change (`lines` identity),
  // so switching books doesn't skip the new one's gallery, but rewinding
  // back to line 0 within the SAME book doesn't replay it.
  const [frontMatterActive, setFrontMatterActive] = useState(false);
  const [backMatterActive, setBackMatterActive] = useState(false);
  const frontMatterArmedRef = useRef(false);
  const backMatterArmedRef = useRef(false);

  useEffect(() => {
    frontMatterArmedRef.current = false;
    backMatterArmedRef.current = false;
    setFrontMatterActive(false);
    setBackMatterActive(false);
  }, [lines]);

  useEffect(() => {
    if (activeIndex === 0 && revealed === 0 && frontMatter?.length && !frontMatterArmedRef.current) {
      frontMatterArmedRef.current = true;
      setFrontMatterActive(true);
    }
  }, [activeIndex, revealed, frontMatter]);

  useEffect(() => {
    if (finished && backMatter?.length && !backMatterArmedRef.current) {
      backMatterArmedRef.current = true;
      setBackMatterActive(true);
    }
  }, [finished, backMatter]);

  const span = pages[page] || { startLine: 0, endLine: 0 };
  const pageParas = displayParagraphs.slice(span.startLine, span.endLine);

  const activePara = displayParagraphs[activeDisplayIndex];
  const activeTokens = useMemo(
    () => (activePara && !activePara.synthetic ? paragraphTokens(lines, activePara.startLine, activePara.endLine) : []),
    [activePara, lines],
  );
  const activeReveal = revealFromChars(lines[activeIndex]?.text || "", revealed);

  const bgStyle = dimBackground && scene?.background ? backgroundStyle(scene.background) : null;

  return (
    <div className="vae-reader" style={{ "--kr-font": `${fontSizePx}px` }} data-testid="reader-view">
      {bgStyle && <div className="vae-reader-bg" style={bgStyle} aria-hidden="true" />}

      {onChangeFontSize && (
        <div className="vae-reader-font">
          <button type="button" onClick={() => onChangeFontSize(-2)} aria-label="Smaller text">A−</button>
          <button type="button" onClick={() => onChangeFontSize(2)} aria-label="Larger text">A+</button>
        </div>
      )}

      <div className="vae-kr-stage" ref={stageRef} data-testid="reader-stage">
        {pageParas.map((para, i) => {
          const gi = span.startLine + i;
          const isActive = gi === activeDisplayIndex;
          if (para.synthetic) {
            return (
              <p key={`gap-${para.syntheticId ?? gi}`} className="vae-kr-line vae-kr-gap is-active"
                ref={isActive ? activeParaRef : null} data-testid="reader-gap-segment">
                {para.text}
              </p>
            );
          }
          const isRead = para.endLine <= activeIndex;
          const cls = `vae-kr-line${isRead ? " is-read" : ""}${isActive ? " is-active" : ""}`;
          return (
            <p key={para.startLine} className={cls} ref={isActive ? activeParaRef : null}
              data-testid="reader-paragraph"
              onClick={() => onSeekLine?.(para.startLine)}>
              {isActive
                ? renderActiveTokens(activeTokens, activeIndex, activeReveal)
                : para.text}
            </p>
          );
        })}
      </div>

      {/* Offscreen measurer — one <p> per PARAGRAPH (including the synthetic
          gap, when present), same column width (set in JS) & font as the
          stage, so wrapping/height matches exactly. */}
      <div className="vae-kr-measure" ref={measureRef} aria-hidden="true">
        {displayParagraphs.map((para, i) => (
          <p key={para.synthetic ? `gap-${para.syntheticId ?? i}` : para.startLine}
            className={`vae-kr-line${para.synthetic ? " vae-kr-gap" : ""}`}>
            {para.text}
          </p>
        ))}
      </div>

      {/* Order of operations: outside-book narration (the gap paragraph
          above, already playing/audible underneath) → front-matter art →
          real book content (text + per-line illustrations) → back-matter
          art. Only one of these ever renders at a time — front/back-matter
          gate closed once ArtGallery finishes, and per-line flash only shows
          once neither gallery is active. */}
      {frontMatterActive ? (
        <ArtGallery images={frontMatter} onFinished={() => setFrontMatterActive(false)} />
      ) : backMatterActive ? (
        <ArtGallery images={backMatter} onFinished={() => setBackMatterActive(false)} />
      ) : illustrationUrl && (
        <IllustrationFlash
          url={illustrationUrl}
          lineKey={`line-${activeIndex}-${illustrationUrl}`}
          active={flashActive}
          dismissSignal={flashDismissSignal}
          holdMs={READER_ART_HOLD_MS}
          onDone={onFlashDone}
          onTap={onDismissFlash}
        />
      )}
    </div>
  );
}

/** Render the active paragraph's tokens: lines already fully spoken (before
 *  activeIndex) read fully bold; the active line's own words get the live
 *  per-word karaoke wipe (via revealFromChars, positionally zipped onto this
 *  paragraph's tokens for that line); lines not yet reached stay dim. */
function renderActiveTokens(tokens, activeIndex, activeReveal) {
  let activeWordSeen = -1; // counts tokens with lineIdx === activeIndex seen so far
  return tokens.map((t, i) => {
    if (t.lineIdx < activeIndex) {
      return <span key={i} className="kr-w spoken">{t.text}{" "}</span>;
    }
    if (t.lineIdx > activeIndex) {
      return <span key={i} className="kr-w">{t.text}{" "}</span>;
    }
    activeWordSeen += 1;
    const cls = activeWordSeen < activeReveal.activeWord ? "kr-w spoken"
      : activeWordSeen === activeReveal.activeWord ? "kr-w active" : "kr-w";
    const style = activeWordSeen === activeReveal.activeWord
      ? { "--wipe": `${(activeReveal.wordProgress * 100).toFixed(1)}%` } : undefined;
    return <span key={i} className={cls} style={style}>{t.text}{" "}</span>;
  });
}
