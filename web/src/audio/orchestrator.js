// Central playback orchestrator (Brief: "keep one central orchestrator").
// Owns the single source of truth for timing: it fires audio start, sprite
// state change, and typewriter reveal off the SAME clock per line, so they
// can't drift apart. The React layer just renders the state it emits.
import {
  speakLine, speakLinesViaEdge, stopAllSpeech, setEdgePlaybackRate,
} from "./playSpeech.js";
import { backendConfigured } from "../api.js";
import { getActivePack, packSupportsOfflineAudio } from "../offline/packBridge.js";
import { estimateDurationSec, revealedCount, isCheckpoint, effectiveLineDuration } from "./timing.js";

export class Orchestrator {
  constructor({ onState, onCheckpoint, onEnd, onError } = {}) {
    this.onState = onState || (() => {});
    this.onCheckpoint = onCheckpoint || (() => {});
    this.onEnd = onEnd || (() => {});
    this.onError = onError || (() => {});
    this.lines = [];
    this.speed = 1;
    this.checkpointEvery = 0;
    this.autoAdvance = true;
    this.voiceOverrides = null;
    this.timingAlgorithm = "linear"; // selected audiobook→script sync strategy
    this.status = "idle";          // idle | playing | paused | checkpoint | done | error
    this.index = 0;
    this.lastError = null;
    this._raf = null;
    this._lineStart = 0;
    this._lineDur = 0;
    this._token = 0;               // typewriter loop guard
  }

  configure({ speed, checkpointEvery, autoAdvance, voiceOverrides, timingAlgorithm }) {
    if (speed != null) { this.speed = speed; setEdgePlaybackRate(speed); }
    if (checkpointEvery != null) this.checkpointEvery = checkpointEvery;
    if (autoAdvance != null) this.autoAdvance = autoAdvance;
    if (voiceOverrides !== undefined) this.voiceOverrides = voiceOverrides;
    // Selected audiobook→script timing strategy. Stored now; consumed by the
    // playback-integration milestone (when a precomputed timeline overrides
    // estimateDurationSec). Inert today, so playback behavior is unchanged.
    if (timingAlgorithm != null) this.timingAlgorithm = timingAlgorithm;
  }

  _emit(extra = {}) {
    const line = this.lines[this.index] || null;
    this.onState({
      status: this.status,
      index: this.index,
      total: this.lines.length,
      line,
      speakerId: line ? line.character_id : null,
      revealed: extra.revealed != null ? extra.revealed
        : (line ? line.text.length : 0),
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
    this.status = "playing";
    this._emit({ revealed: 0 });

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
      checkpointEvery: this.checkpointEvery,
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
        if (isCheckpoint(i, this.checkpointEvery) && i < this.lines.length - 1) {
          this.pauseForCheckpoint();
        }
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
        if (isCheckpoint(i, this.checkpointEvery) && i < this.lines.length - 1) {
          this.pauseForCheckpoint();
        } else if (i >= this.lines.length - 1) {
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
      if (isCheckpoint(i, this.checkpointEvery) && i < this.lines.length - 1) {
        this.pauseForCheckpoint();
        return;
      }
      if (!this.autoAdvance) { this.status = "paused"; this._emit(); return; }
    }
    this._finish();
  }

  pauseForCheckpoint() {
    this.status = "checkpoint";
    stopAllSpeech();
    cancelAnimationFrame(this._raf);
    this._emit();
    this.onCheckpoint(this.index);
  }

  /** Reveal the rest of the current line immediately (skip typewriter). */
  revealAll() {
    const line = this.lines[this.index];
    if (line) { this._token++; cancelAnimationFrame(this._raf); this._emit({ revealed: line.text.length }); }
  }

  /** Jump to line index (scrub). */
  seek(index) {
    const i = Math.max(0, Math.min(index, this.lines.length - 1));
    stopAllSpeech();
    cancelAnimationFrame(this._raf);
    this.index = i;
    this.status = "paused";
    this._emit({ revealed: 0 });
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

  /** Manual next line (click-through advance / skip). */
  next(steps = 1) {
    const n = Math.max(1, steps || 1);
    const target = Math.min(this.index + n, this.lines.length - 1);
    if (this.index < this.lines.length - 1) this.play(this.lines, target);
    else this._finish();
  }

  resume() { if (this.status !== "playing") this.play(this.lines, this.index); }
  pause() { this.status = "paused"; stopAllSpeech(); cancelAnimationFrame(this._raf); this._emit(); }
  stop() { this.status = "idle"; stopAllSpeech(); cancelAnimationFrame(this._raf); this._token++; }

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
    cancelAnimationFrame(this._raf);
    this._emit();
    this.onError({ ...info, index: this.index });
  }
}
