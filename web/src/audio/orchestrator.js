// Central playback orchestrator (Brief: "keep one central orchestrator").
// Owns the single source of truth for timing: it fires audio start, sprite
// state change, and typewriter reveal off the SAME clock per line, so they
// can't drift apart. The React layer just renders the state it emits.
import {
  speakLine, speakLinesViaEdge, stopAllSpeech, setEdgePlaybackRate,
} from "./playSpeech.js";
import {
  isSharedAudioLoaded, playSharedContinuous, stopSharedAudio,
  getSharedAudioCurrentTimeMs, getSharedAudioDurationMs, setSharedAudioPlaybackRate,
  seekSharedAudioMs, isSharedAudioBuffering, onSharedAudioBufferingChange,
} from "./sharedAudioSource.js";
import { buildMergedTimingIndex, lineAt } from "./lineAt.js";
import { backendConfigured } from "../api.js";
import { getActivePack, packSupportsOfflineAudio } from "../offline/packBridge.js";
import { estimateDurationSec, revealedCount, effectiveLineDuration } from "./timing.js";

export class Orchestrator {
  constructor({ onState, onEnd, onError } = {}) {
    this.onState = onState || (() => {});
    this.onEnd = onEnd || (() => {});
    this.onError = onError || (() => {});
    this.lines = [];
    this.speed = 1;
    this.autoAdvance = true;
    this.voiceOverrides = null;
    this.timingAlgorithm = "linear"; // selected audiobook→script sync strategy
    this.lineTimings = null;       // { [lineIndex]: {startMs,endMs,durationMs} } — set via setTimeline()
    this.timelineMeta = {};        // TimingResult.meta — { strategy: "acoustic" } enables Mode B
    this.syntheticSegments = [];   // gap ("narrator filler") entries — see setTimeline()/extendTimeline()
    this.status = "idle";          // idle | playing | paused | done | error
    this.index = 0;
    // Non-null while the acoustic playhead is inside a synthetic gap segment
    // — this.index deliberately does NOT change while this is set (every
    // other consumer — resume, rewind, sceneOf scene lookup — assumes it's a
    // real, stable line position), so a gap is layered on top instead of
    // becoming a "line" in its own right.
    this.activeSynthetic = null;
    this.lastError = null;
    this._raf = null;
    this._lineStart = 0;
    this._lineDur = 0;
    this._token = 0;               // typewriter loop guard
    this._lineTimingIndexCache = null; // { linesSrc, gapsSrc, entries } — rebuilt only when either source changes
    // Surfaced so the UI can show "buffering" instead of looking frozen — a
    // fresh seek into unbuffered territory of a large m4b can stall for a
    // real, sometimes long stretch (see sharedAudioSource.js's comment).
    this.buffering = isSharedAudioBuffering();
    onSharedAudioBufferingChange((buffering) => {
      this.buffering = buffering;
      this._emit();
    });
  }

  configure({ speed, autoAdvance, voiceOverrides, timingAlgorithm }) {
    if (speed != null) {
      this.speed = speed;
      setEdgePlaybackRate(speed);
      if (this._hasSharedTimeline()) setSharedAudioPlaybackRate(speed);
    }
    if (autoAdvance != null) this.autoAdvance = autoAdvance;
    if (voiceOverrides !== undefined) this.voiceOverrides = voiceOverrides;
    // Selected audiobook→script timing strategy. Stored now; consumed by the
    // playback-integration milestone (when a precomputed timeline overrides
    // estimateDurationSec). Inert today, so playback behavior is unchanged.
    if (timingAlgorithm != null) this.timingAlgorithm = timingAlgorithm;
  }

  /**
   * Sync the book's lines into the orchestrator WITHOUT starting/touching
   * playback — call this whenever the book's flattened lines are ready
   * (mount, book refresh), independent of whether play() has ever run.
   * Without this, this.lines stays [] (its constructor default) until the
   * user's first play() call, so seek()/rewind()/next() — which all clamp
   * against this.lines.length — clamp to 0 no matter the target: the
   * progress bar looked broken (every seek silently snapped back to line 0)
   * for a book the user hadn't started playing yet.
   */
  setLines(lines) {
    this.lines = lines || [];
  }

  /**
   * Inject a precomputed timeline (TimingResult.lineTimings) from the timing
   * engine. When set AND a shared .m4b is loaded (sharedAudioSource), play()
   * plays real segments of that file instead of synthesizing/fetching TTS.
   * Pass null to fall back to the existing TTS/silent playback paths.
   * `syntheticSegments` (WhisperX gap detection — audio-only content with
   * no book-line counterpart) is optional and only ever populated on the
   * whisperx path; every other algorithm passes none.
   */
  setTimeline(lineTimings, meta, syntheticSegments) {
    this.lineTimings = lineTimings || null;
    this.timelineMeta = meta || {};
    this.syntheticSegments = syntheticSegments || [];
  }

  /**
   * Merge newly-resolved per-line timings AND/OR newly-arrived gap segments
   * into the CURRENT timeline in place, without resetting playback — used
   * for progressive WhisperX alignment: an initial estimated timeline (e.g.
   * linear split) plays immediately on attach, and real acoustic timings
   * (plus any gaps found) replace/extend it a chunk at a time as the local
   * align server streams them in, live, mid-playback. A NEW object/array is
   * assigned (never mutated) so reference-equality checks that gate
   * rebuilding derived state (see _mergedTimingEntries) see the change and
   * refresh on the very next read.
   */
  extendTimeline(partialLineTimings, newSyntheticSegments) {
    if (partialLineTimings && Object.keys(partialLineTimings).length) {
      this.lineTimings = { ...(this.lineTimings || {}), ...partialLineTimings };
    }
    if (newSyntheticSegments && newSyntheticSegments.length) {
      this.syntheticSegments = [...this.syntheticSegments, ...newSyntheticSegments];
    }
  }

  _isAcousticMode() {
    return this.timelineMeta && this.timelineMeta.strategy === "acoustic";
  }

  /** True whenever a precomputed timeline is loaded AND a shared local m4b is
   *  attached — the condition for using the real-audio-clock (continuous)
   *  playback engine, regardless of which timing algorithm produced the
   *  timeline. `_isAcousticMode()`/`timelineMeta.strategy` stays pure
   *  metadata (still useful for labeling which algorithm produced the
   *  timing) — this is the one used to pick the playback engine. */
  _hasSharedTimeline() {
    return !!(this.lineTimings && isSharedAudioLoaded());
  }

  _emit(extra = {}) {
    // While a gap is active, render it as narrator dialogue instead of the
    // (frozen) real line at this.index — DialogueBox already knows how to
    // render {character_id:"narrator", kind:"narration"} correctly.
    const synthetic = this.activeSynthetic;
    const line = synthetic
      ? { character_id: "narrator", kind: "narration", text: synthetic.text }
      : (this.lines[this.index] || null);
    // Real audio clock, only meaningful when the continuous playback engine
    // is driving — null lets the UI fall back to the character-count
    // estimate everywhere else (TTS/silent playback, which have no real
    // audio file to read a position from).
    const liveClock = this._hasSharedTimeline();
    this.onState({
      status: this.status,
      index: this.index,
      total: this.lines.length,
      line,
      speakerId: line ? line.character_id : null,
      revealed: extra.revealed != null ? extra.revealed
        : (line ? line.text.length : 0),
      syntheticSegment: synthetic || null,
      currentTimeMs: liveClock ? getSharedAudioCurrentTimeMs() : null,
      durationMs: liveClock ? getSharedAudioDurationMs() : null,
      buffering: liveClock && this.buffering,
      ...extra,
    });
  }

  // Drive typewriter reveal for a character range within a line (sentence-sized TTS).
  _runTypewriterRange(fullText, charStart, charEnd, durSec) {
    cancelAnimationFrame(this._raf);
    const myToken = ++this._token;
    const segment = (fullText || "").slice(charStart, charEnd);
    this._lineStart = performance.now();
    this._lineDur = effectiveLineDuration(segment, durSec, this.speed);
    const tick = () => {
      if (myToken !== this._token || this.status !== "playing") return;
      const elapsed = (performance.now() - this._lineStart) / 1000;
      const segReveal = revealedCount(segment, elapsed, this._lineDur);
      const n = Math.min(charEnd, charStart + segReveal);
      this._emit({ revealed: n });
      if (n < charEnd) this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  // Drive the typewriter for the current line off a real/estimated duration.
  _runTypewriter(text, durSec) {
    this._runTypewriterRange(text, 0, (text || "").length, durSec);
  }

  /** Begin playback from `startIndex`. */
  async play(lines, startIndex = 0) {
    this.lines = lines || [];
    this.index = startIndex;
    this.activeSynthetic = null;
    this.status = "playing";
    this._emit({ revealed: 0 });

    if (this._hasSharedTimeline()) {
      await this._playMediaElementClock(startIndex);
      return;
    }

    const pack = await getActivePack();
    const canSpeak = backendConfigured() || packSupportsOfflineAudio(pack);
    if (canSpeak) {
      if (this.autoAdvance) await this._playAuto(startIndex);
      else await this._playSingle(startIndex);
    } else {
      await this._playSilent(startIndex);
    }
  }

  // Auto-advance: ~160-char TTS clips with prefetch; typewriter per clip.
  async _playAuto(startIndex) {
    await speakLinesViaEdge(this.lines, {
      getRate: () => this.speed,
      startIndex,
      voiceOverrides: this.voiceOverrides,
      onLine: (i, line) => {
        this.index = i;
        this.status = "playing";
        this._emit({ revealed: 0 });
      },
      onLinePart: (i, line, part) => {
        this.index = i;
        this.status = "playing";
        this._runTypewriterRange(line.text, part.charStart, part.charEnd, part.durSec);
      },
      onAdvance: (i) => {
        this._emit({ revealed: this.lines[i].text.length });
      },
      onError: (info) => this._fail(info),
      onEnd: () => { if (this.status === "playing") this._finish(); },
    });
  }

  // Click-through: speak exactly ONE line, then pause and wait for the user to
  // advance (so nothing fires until they ask for it).
  async _playSingle(i) {
    this.index = i;
    this.status = "playing";
    this._emit({ revealed: 0 });
    const line = this.lines[i];
    if (!line) { this._finish(); return; }
    let failInfo = null;
    await speakLine(line, {
      rate: this.speed,
      voiceOverrides: this.voiceOverrides,
      onPartStart: (unit, durSec) => {
        if (unit.partIndex === 0) this._emit({ revealed: 0 });
        this._runTypewriterRange(line.text, unit.charStart, unit.charEnd, durSec);
      },
      onError: (e) => { failInfo = { lineIndex: i, line, error: e }; },
      onEnd: () => {
        if (this.status !== "playing") return;
        if (failInfo) { this._fail(failInfo); return; }
        this._emit({ revealed: line.text.length });
        if (i >= this.lines.length - 1) {
          this._finish();
        } else {
          this.status = "paused";       // hold until next()/click
          this._emit();
        }
      },
    });
  }

  async _playSilent(startIndex) {
    for (let i = startIndex; i < this.lines.length; i += 1) {
      if (this.status !== "playing") return;
      this.index = i;
      const line = this.lines[i];
      this._emit({ revealed: 0 });
      const dur = estimateDurationSec(line.text, this.speed);
      this._runTypewriter(line.text, dur);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, (dur + 0.04) * 1000));
      if (this.status !== "playing") return;
      this._emit({ revealed: line.text.length });
      if (!this.autoAdvance) { this.status = "paused"; this._emit(); return; }
    }
    this._finish();
  }

  // Play the shared audio file CONTINUOUSLY for the whole session — a single
  // rAF loop reads the real playhead and maps it back to a line index via
  // lineAt(), driving both auto-advance and typewriter reveal off the same
  // real clock the audio is actually on, instead of an estimated per-line
  // duration timer. Used for every timing algorithm once a shared m4b is
  // loaded (see _hasSharedTimeline()) — an earlier per-line seek-and-stop
  // path existed here for non-acoustic algorithms but was removed: seeking
  // on every line plus a blind wall-clock stop timer caused audio to cut off
  // early whenever a seek stalled on buffering (see sharedAudioSource.js).
  _mergedTimingEntries() {
    const cache = this._lineTimingIndexCache;
    if (!cache || cache.linesSrc !== this.lineTimings || cache.gapsSrc !== this.syntheticSegments) {
      this._lineTimingIndexCache = {
        linesSrc: this.lineTimings,
        gapsSrc: this.syntheticSegments,
        entries: buildMergedTimingIndex(this.lineTimings, this.syntheticSegments),
      };
    }
    return this._lineTimingIndexCache.entries;
  }

  async _playMediaElementClock(startIndex) {
    this.index = startIndex;
    this.status = "playing";
    this._emit({ revealed: 0 });
    // Starting from the very top of the book: consult the merged timeline
    // (already startMs-sorted) instead of jumping straight to line 0's own
    // timestamp, so a leading gap (audio-only intro narration before the
    // book's first line) actually plays instead of being silently skipped.
    // Any other startIndex is an explicit seek target and should land
    // exactly there.
    let fromMs;
    if (startIndex === 0) {
      const entries = this._mergedTimingEntries();
      fromMs = entries.length ? entries[0].startMs : 0;
    } else {
      const timing = this.lineTimings[startIndex];
      fromMs = timing ? timing.startMs : 0;
    }
    await this._startMediaElementClock(fromMs);
  }

  /** Resume Mode B playback in place — from wherever the audio was paused,
   *  not from the current line's start (unlike a fresh play()/seek()). */
  async _resumeMediaElementClock() {
    this.status = "playing";
    this._emit();
    await this._startMediaElementClock(getSharedAudioCurrentTimeMs());
  }

  /**
   * Given the real audio position, resolve which line/gap it falls in and
   * update this.index/activeSynthetic + emit accordingly — the same lookup
   * the tick loop below runs every frame. Factored out so resyncDisplay()
   * can run this ONE TIME on demand (e.g. when a hidden tab regains
   * visibility) and land on the CORRECT current position in a single jump,
   * rather than just re-emitting whatever index/activeSynthetic happened to
   * be set the last time a frame actually ran — which, after rAF sat
   * suspended for a while, could be many lines/minutes behind the audio's
   * real (still-advancing) position.
   * This engine (the continuous acoustic clock) never click-through-pauses
   * on a boundary — `autoAdvance` only gates the per-line TTS engine
   * (`play()`'s `_playAuto`/`_playSingle` choice). A real audio file plays
   * straight through regardless of that setting; always returns true.
   */
  _resolvePosition(currentMs) {
    // Re-fetched every call (cheap: cached unless extendTimeline() just
    // changed a reference) so a chunk of real WhisperX timing OR a newly
    // arrived gap landing mid-playback takes effect on the very next
    // frame, not just on the next seek/resume.
    const entries = this._mergedTimingEntries();
    const entry = lineAt(entries, currentMs);

    if (entry && entry.lineIndex == null) {
      // On a gap — this.index deliberately does not change (see the
      // constructor comment on activeSynthetic). `leading` records whether
      // this gap plays BEFORE this.index's own line has started (true at a
      // book's leading intro bumper, where index is still pinned to line 0
      // but line 0 hasn't been heard yet) vs. after it (the usual mid-book
      // gap) — the reader view needs this to splice the gap paragraph on
      // the correct side of the pinned line.
      if (this.activeSynthetic?.syntheticId !== entry.syntheticId) {
        const lineStartMs = this.lineTimings?.[this.index]?.startMs ?? Infinity;
        this.activeSynthetic = { ...entry, leading: entry.startMs < lineStartMs };
        this._emit({ revealed: entry.text.length });
      }
      return true;
    }
    if (this.activeSynthetic) this.activeSynthetic = null; // left the gap — resume real-line tracking

    if (entry && entry.lineIndex !== this.index) {
      this.index = entry.lineIndex;
      this._emit({ revealed: 0 });
    }
    const line = this.lines[this.index];
    if (line && entry) {
      const span = Math.max(1, entry.endMs - entry.startMs);
      const frac = Math.min(1, Math.max(0, (currentMs - entry.startMs) / span));
      this._emit({ revealed: Math.floor(line.text.length * frac) });
    }
    return true;
  }

  async _startMediaElementClock(fromMs) {
    cancelAnimationFrame(this._raf);
    await playSharedContinuous(fromMs, this.speed, {
      onEnded: () => { if (this.status === "playing") this._finish(); },
      onError: (e) => this._fail({ lineIndex: this.index, line: this.lines[this.index], error: e }),
    });
    if (this.status !== "playing") return;

    const tick = () => {
      if (this.status !== "playing") return;
      if (this._resolvePosition(getSharedAudioCurrentTimeMs())) {
        this._raf = requestAnimationFrame(tick);
      }
    };
    this._raf = requestAnimationFrame(tick);
  }

  /** Reveal the rest of the current line immediately (skip typewriter). */
  revealAll() {
    const line = this.lines[this.index];
    if (line) { this._token++; cancelAnimationFrame(this._raf); this._emit({ revealed: line.text.length }); }
  }

  /** Recompute the current line/gap from the real audio clock and emit —
   *  for a caller (Player's visibilitychange handler) to call after the tab
   *  regains visibility. Mode B's tick loop is requestAnimationFrame-driven,
   *  which browsers fully suspend while the tab is hidden — the underlying
   *  audio keeps playing correctly the whole time (rAF suspension doesn't
   *  touch the <audio> element itself), but this.index/activeSynthetic only
   *  ever get updated INSIDE that suspended loop, so after any real stretch
   *  of hidden time they're left pointing at wherever playback was several
   *  lines/minutes ago. A bare _emit() would just re-report that stale
   *  state — this calls the same _resolvePosition() the tick loop itself
   *  uses, so a single call jumps straight to wherever the audio actually
   *  is now, in one step, instead of waiting for/needing per-frame catch-up. */
  resyncDisplay() {
    if (this.status === "playing" && this._hasSharedTimeline()) {
      this._resolvePosition(getSharedAudioCurrentTimeMs());
    }
  }

  /** Jump to line index (scrub). Always a REAL line — see next()'s comment
   *  on why seeking never targets a gap directly, and seekToGap() below for
   *  the deliberate way to do that instead. */
  seek(index) {
    const i = Math.max(0, Math.min(index, this.lines.length - 1));
    stopAllSpeech();
    stopSharedAudio();
    cancelAnimationFrame(this._raf);
    this.index = i;
    this.activeSynthetic = null;
    this.status = "paused";
    this._emit({ revealed: 0 });
  }

  /** Deliberately jump to a synthetic gap (chunk) by its syntheticId — the
   *  one sanctioned way to target a gap directly (forward fall-in during
   *  continuous playback is the only other way one is ever reached). Leaves
   *  this.index untouched: _emit() ignores this.lines[this.index] entirely
   *  whenever activeSynthetic is set, so whatever index was last real (or
   *  the constructor's default 0, if called before any play()) is a safe
   *  placeholder.
   *
   *  Resumes playback immediately rather than parking in "paused" — unlike
   *  a real-line seek(), the main Play button can't recover this position:
   *  orch.play() unconditionally clears activeSynthetic and reseeks by line
   *  index, discarding exactly the spot we just jumped to (the same reason
   *  next() calls resume() instead of play() when stepping past a gap). */
  seekToGap(syntheticId) {
    const entry = this._mergedTimingEntries().find((e) => e.syntheticId === syntheticId);
    if (!entry) return;
    stopAllSpeech();
    stopSharedAudio();
    cancelAnimationFrame(this._raf);
    seekSharedAudioMs(entry.startMs);
    this.activeSynthetic = entry;
    this.status = "paused"; // resume()'s guard requires status !== "playing"
    this.resume();
  }

  /** Rewind N lines from current position. */
  rewind(steps = 1) {
    const target = Math.max(0, this.index - Math.max(1, steps));
    if (target === this.index && this.status === "playing") {
      this.play(this.lines, target);
    } else {
      this.seek(target);
    }
  }

  /** Manual next line (click-through advance / skip, TTS engine only — the
   *  continuous acoustic engine never click-through-pauses, but a user can
   *  still manually pause() while a gap happens to be active). */
  next(steps = 1) {
    if (this.activeSynthetic) {
      // Manually paused mid-gap: this.index is frozen at the last real
      // line, so an index-based seek target doesn't apply here — just let
      // the acoustic clock continue forward past the gap, same as tapping
      // through any other line boundary. Gaps are only ever reached via
      // forward continuous playback in v1 (never a seek/rewind target), so
      // this is the one place that needs to know about them explicitly.
      this.resume();
      return;
    }
    const n = Math.max(1, steps || 1);
    const target = Math.min(this.index + n, this.lines.length - 1);
    if (this.index < this.lines.length - 1) this.play(this.lines, target);
    else this._finish();
  }

  resume() {
    if (this.status === "playing") return;
    if (this._hasSharedTimeline()) {
      this._resumeMediaElementClock();
    } else {
      this.play(this.lines, this.index);
    }
  }
  pause() {
    this.status = "paused"; stopAllSpeech(); stopSharedAudio(); cancelAnimationFrame(this._raf); this._emit();
  }
  stop() {
    this.status = "idle"; stopAllSpeech(); stopSharedAudio(); cancelAnimationFrame(this._raf); this._token++;
    this.activeSynthetic = null;
  }

  _finish() {
    this.status = "done";
    cancelAnimationFrame(this._raf);
    this._emit();
    this.onEnd();
  }

  /** A real TTS failure — halt in place (don't advance past the failing
   *  line) and surface it. The caller (Player) decides what the user sees
   *  and whether to switch to manual mode; we just stop and wait. */
  _fail(info = {}) {
    if (info.lineIndex != null) this.index = info.lineIndex;
    this.status = "error";
    this.lastError = info.error || null;
    stopAllSpeech();
    stopSharedAudio();
    cancelAnimationFrame(this._raf);
    this._emit();
    this.onError({ ...info, index: this.index });
  }
}
