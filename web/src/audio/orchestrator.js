// Central playback orchestrator (Brief: "keep one central orchestrator").
// Owns the single source of truth for timing: it fires audio start, sprite
// state change, and typewriter reveal off the SAME clock per line, so they
// can't drift apart. The React layer just renders the state it emits.
import {
  speakLine, speakLinesViaEdge, stopAllSpeech, setEdgePlaybackRate,
} from "./playSpeech.js";
import { backendConfigured } from "../api.js";
import { estimateDurationSec, revealedCount, isCheckpoint } from "./timing.js";

export class Orchestrator {
  constructor({ onState, onCheckpoint, onEnd } = {}) {
    this.onState = onState || (() => {});
    this.onCheckpoint = onCheckpoint || (() => {});
    this.onEnd = onEnd || (() => {});
    this.lines = [];
    this.speed = 1;
    this.checkpointEvery = 0;
    this.autoAdvance = true;
    this.voiceOverrides = null;
    this.status = "idle";          // idle | playing | paused | checkpoint | done
    this.index = 0;
    this._raf = null;
    this._lineStart = 0;
    this._lineDur = 0;
    this._token = 0;               // typewriter loop guard
  }

  configure({ speed, checkpointEvery, autoAdvance, voiceOverrides }) {
    if (speed != null) { this.speed = speed; setEdgePlaybackRate(speed); }
    if (checkpointEvery != null) this.checkpointEvery = checkpointEvery;
    if (autoAdvance != null) this.autoAdvance = autoAdvance;
    if (voiceOverrides !== undefined) this.voiceOverrides = voiceOverrides;
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

  // Drive the typewriter for the current line off a real/estimated duration.
  _runTypewriter(text, durSec) {
    cancelAnimationFrame(this._raf);
    const myToken = ++this._token;
    this._lineStart = performance.now();
    this._lineDur = Math.max(0.4, durSec || estimateDurationSec(text, this.speed));
    const tick = () => {
      if (myToken !== this._token || this.status !== "playing") return;
      const elapsed = (performance.now() - this._lineStart) / 1000;
      const n = revealedCount(text, elapsed, this._lineDur);
      this._emit({ revealed: n });
      if (n < text.length) this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  /** Begin playback from `startIndex`. */
  async play(lines, startIndex = 0) {
    this.lines = lines || [];
    this.index = startIndex;
    this.status = "playing";
    this._emit({ revealed: 0 });

    if (backendConfigured()) {
      if (this.autoAdvance) await this._playAuto(startIndex);
      else await this._playSingle(startIndex);   // click-through: one line, then wait
    } else {
      await this._playSilent(startIndex);
    }
  }

  // Auto-advance: one /tts call per line, sequenced (mirrors the parallel-
  // reader's speakSentencesViaEdge). Typewriter paced to each clip's length.
  async _playAuto(startIndex) {
    await speakLinesViaEdge(this.lines, {
      rate: this.speed,
      startIndex,
      voiceOverrides: this.voiceOverrides,
      onLine: (i, line, durSec) => {
        this.index = i;
        this.status = "playing";
        this._emit({ revealed: 0 });
        this._runTypewriter(line.text, durSec);
      },
      onAdvance: (i) => {
        this._emit({ revealed: this.lines[i].text.length });
        if (isCheckpoint(i, this.checkpointEvery) && i < this.lines.length - 1) {
          this.pauseForCheckpoint();
        }
      },
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
    await speakLine(line, {
      rate: this.speed,
      voiceOverrides: this.voiceOverrides,
      onStart: (durSec) => this._runTypewriter(line.text, durSec),
      onEnd: () => {
        if (this.status !== "playing") return;
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
      await new Promise((r) => setTimeout(r, (dur + 0.5) * 1000));
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

  /** Manual next line (click-through advance / skip). */
  next() {
    if (this.index < this.lines.length - 1) this.play(this.lines, this.index + 1);
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
}
