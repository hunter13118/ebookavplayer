import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import {
  loadSharedAudio, unloadSharedAudio, seekSharedAudioMs, getSharedAudioCurrentTimeMs,
} from "./sharedAudioSource.js";
import * as sharedAudioSource from "./sharedAudioSource.js";
import { lineAt } from "./lineAt.js";

vi.mock("../api.js", () => ({
  backendConfigured: () => false,
}));

function waitForStatus(orch, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    if (predicate(orch.status)) { resolve(); return; }
    const start = Date.now();
    const iv = setInterval(() => {
      if (predicate(orch.status)) { clearInterval(iv); resolve(); return; }
      if (Date.now() - start > timeoutMs) { clearInterval(iv); reject(new Error(`timed out waiting for status, last=${orch.status}`)); }
    }, 10);
  });
}

function waitFor(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const LINES = [
  { idx: 0, text: "Line zero.", character_id: "narrator" },
  { idx: 1, text: "Line one.", character_id: "narrator" },
  { idx: 2, text: "Line two.", character_id: "narrator" },
];

const TIMELINE = {
  0: { startMs: 0, endMs: 100, durationMs: 100 },
  1: { startMs: 100, endMs: 200, durationMs: 100 },
  2: { startMs: 200, endMs: 300, durationMs: 100 },
};

describe("Orchestrator shared-audio (.m4b) playback", () => {
  beforeEach(() => {
    loadSharedAudio(new Blob([new Uint8Array(1000)], { type: "audio/mp4" }));
  });

  afterEach(() => {
    unloadSharedAudio();
  });

  it("does not use the shared-audio path when no timeline has been set", async () => {
    const orch = new Orchestrator();
    expect(orch.lineTimings).toBeNull();
    // Falls through to the existing silent/TTS-unavailable path — proven
    // elsewhere (orchestrator.offline.test.js); here we just confirm it
    // doesn't hang waiting on shared-audio internals it was never given.
    await orch.play([LINES[0]], 0);
    await waitForStatus(orch, (s) => ["playing", "done", "paused"].includes(s));
    orch.stop();
  });

  it("auto-advances through every line via real shared-audio segments and finishes", async () => {
    const orch = new Orchestrator();
    orch.configure({ autoAdvance: true });
    orch.setTimeline(TIMELINE);
    const seenIndexes = [];
    orch.onState = (s) => { if (s.status === "playing") seenIndexes.push(s.index); };
    let ended = false;
    orch.onEnd = () => { ended = true; };

    await orch.play(LINES, 0);
    await waitForStatus(orch, (s) => s === "done");

    expect(ended).toBe(true);
    expect(new Set(seenIndexes)).toEqual(new Set([0, 1, 2]));
  });

  it("click-through mode (autoAdvance=false) plays exactly one line then pauses", async () => {
    const orch = new Orchestrator();
    orch.configure({ autoAdvance: false });
    orch.setTimeline(TIMELINE);

    await orch.play(LINES, 0);
    await waitForStatus(orch, (s) => s === "paused");

    expect(orch.index).toBe(0);
    expect(orch.status).toBe("paused");
  });

  it("next() advances exactly one line at a time in click-through mode", async () => {
    const orch = new Orchestrator();
    orch.configure({ autoAdvance: false });
    orch.setTimeline(TIMELINE);

    await orch.play(LINES, 0);
    await waitForStatus(orch, (s) => s === "paused");
    expect(orch.index).toBe(0);

    orch.next();
    await waitForStatus(orch, (s) => s === "paused");
    expect(orch.index).toBe(1);
  });

  it("degrades gracefully for a line missing from the timeline instead of crashing", async () => {
    const orch = new Orchestrator();
    orch.configure({ autoAdvance: true, speed: 4 }); // speed up the silent-estimate fallback
    orch.setTimeline({ 0: TIMELINE[0] }); // line 1 and 2 deliberately absent
    let ended = false;
    orch.onEnd = () => { ended = true; };

    await orch.play(LINES, 0);
    await waitForStatus(orch, (s) => s === "done", 5000);
    expect(ended).toBe(true);
  });

  it("pause() halts shared-audio playback without throwing and the orchestrator does not advance further", async () => {
    const orch = new Orchestrator();
    orch.configure({ autoAdvance: true });
    // A deliberately long segment so we can pause mid-flight.
    orch.setTimeline({ 0: { startMs: 0, endMs: 5000, durationMs: 5000 } });

    const playDone = orch.play([LINES[0]], 0);
    await new Promise((r) => setTimeout(r, 10));
    expect(() => orch.pause()).not.toThrow();
    await playDone;
    expect(orch.status).toBe("paused");
  });

  it("setTimeline(null) reverts to non-shared-audio playback even if a blob is still loaded", async () => {
    const orch = new Orchestrator();
    orch.setTimeline(TIMELINE);
    orch.setTimeline(null);
    expect(orch.lineTimings).toBeNull();
    await orch.play([LINES[0]], 0);
    await waitForStatus(orch, (s) => ["playing", "done", "paused"].includes(s));
    orch.stop();
  });

  it("stop() resets status to idle from shared-audio playback", async () => {
    const orch = new Orchestrator();
    orch.configure({ autoAdvance: true });
    orch.setTimeline({ 0: { startMs: 0, endMs: 5000, durationMs: 5000 } });
    const playDone = orch.play([LINES[0]], 0);
    await new Promise((r) => setTimeout(r, 10));
    orch.stop();
    expect(orch.status).toBe("idle");
    await playDone;
  });
});

describe("Orchestrator Mode B (acoustic timeline, continuous shared-audio clock)", () => {
  beforeEach(() => {
    loadSharedAudio(new Blob([new Uint8Array(1000)], { type: "audio/mp4" }));
  });

  afterEach(() => {
    unloadSharedAudio();
    vi.restoreAllMocks();
  });

  it("plays continuously via playSharedContinuous (never per-line playSharedSegment) when meta.strategy is 'acoustic'", async () => {
    const continuousSpy = vi.spyOn(sharedAudioSource, "playSharedContinuous");
    const segmentSpy = vi.spyOn(sharedAudioSource, "playSharedSegment");
    const orch = new Orchestrator();
    orch.configure({ autoAdvance: true });
    orch.setTimeline(TIMELINE, { strategy: "acoustic" });

    await orch.play(LINES, 0);
    await waitForStatus(orch, (s) => s === "done");

    expect(continuousSpy).toHaveBeenCalledTimes(1);
    expect(continuousSpy.mock.calls[0][0]).toBe(0); // seeks to line 0's startMs
    expect(segmentSpy).not.toHaveBeenCalled();
  });

  it("starting mid-book seeks to the start line's own startMs, not 0", async () => {
    const continuousSpy = vi.spyOn(sharedAudioSource, "playSharedContinuous");
    const orch = new Orchestrator();
    orch.configure({ autoAdvance: true });
    orch.setTimeline(TIMELINE, { strategy: "acoustic" });

    await orch.play(LINES, 1);
    expect(continuousSpy.mock.calls[0][0]).toBe(TIMELINE[1].startMs);
    orch.stop();
  });

  it("falls back to Mode A (per-line playSharedSegment) when no meta.strategy is set", async () => {
    const continuousSpy = vi.spyOn(sharedAudioSource, "playSharedContinuous");
    const orch = new Orchestrator();
    orch.configure({ autoAdvance: true });
    orch.setTimeline(TIMELINE); // no meta -> Mode A, unchanged behavior
    await orch.play(LINES, 0);
    await waitForStatus(orch, (s) => s === "done");
    expect(continuousSpy).not.toHaveBeenCalled();
  });

  it("pause() halts Mode B playback in place without resetting the real playhead", async () => {
    const orch = new Orchestrator();
    orch.configure({ autoAdvance: true });
    orch.setTimeline({ 0: { startMs: 0, endMs: 100000, durationMs: 100000 } }, { strategy: "acoustic" });

    const playDone = orch.play([LINES[0]], 0);
    await waitFor(3); // stay well inside FakeAudio's fixed 15ms auto-end window
    seekSharedAudioMs(4000);
    expect(() => orch.pause()).not.toThrow();
    await playDone;

    expect(orch.status).toBe("paused");
    expect(getSharedAudioCurrentTimeMs()).toBeCloseTo(4000, 0);
  });

  it("resume() continues from the real playhead position, not the line's start", async () => {
    const continuousSpy = vi.spyOn(sharedAudioSource, "playSharedContinuous");
    const orch = new Orchestrator();
    orch.configure({ autoAdvance: true });
    orch.setTimeline({ 0: { startMs: 0, endMs: 100000, durationMs: 100000 } }, { strategy: "acoustic" });

    const playDone = orch.play([LINES[0]], 0);
    await waitFor(3);
    seekSharedAudioMs(4000);
    orch.pause();
    await playDone;

    orch.resume();
    await waitFor(3);
    expect(continuousSpy).toHaveBeenCalledTimes(2);
    expect(continuousSpy.mock.calls[1][0]).toBeCloseTo(4000, 0); // resumes near 4000ms, not the line's startMs (0)
    orch.stop();
  });

  it("configure({speed}) updates the shared audio element's rate live, without restarting playback", async () => {
    const rateSpy = vi.spyOn(sharedAudioSource, "setSharedAudioPlaybackRate");
    const continuousSpy = vi.spyOn(sharedAudioSource, "playSharedContinuous");
    const orch = new Orchestrator();
    orch.configure({ autoAdvance: true });
    orch.setTimeline({ 0: { startMs: 0, endMs: 100000, durationMs: 100000 } }, { strategy: "acoustic" });

    const playDone = orch.play([LINES[0]], 0);
    await waitFor(3);

    orch.configure({ speed: 1.75 });
    expect(rateSpy).toHaveBeenCalledWith(1.75);
    expect(continuousSpy).toHaveBeenCalledTimes(1); // no restart/reseek triggered by the rate change

    orch.stop();
    await playDone;
  });

  it("configure({speed}) does not touch the shared audio element outside acoustic mode", () => {
    const rateSpy = vi.spyOn(sharedAudioSource, "setSharedAudioPlaybackRate");
    const orch = new Orchestrator();
    orch.setTimeline(TIMELINE); // no meta.strategy -> Mode A
    orch.configure({ speed: 1.5 });
    expect(rateSpy).not.toHaveBeenCalled();
  });

  it("_emit() reports the real audio clock (currentTimeMs/durationMs) in acoustic mode", () => {
    const orch = new Orchestrator();
    orch.lines = LINES;
    orch.setTimeline(TIMELINE, { strategy: "acoustic" });
    seekSharedAudioMs(123);
    let seen = null;
    orch.onState = (s) => { seen = s; };
    orch._emit();

    expect(seen.currentTimeMs).toBeCloseTo(123, 0);
    expect(seen.durationMs).toBeCloseTo(250, 0); // FakeAudio's fixed test duration (0.25s)
  });

  it("_emit() reports null currentTimeMs/durationMs outside acoustic mode", () => {
    const orch = new Orchestrator();
    orch.lines = LINES;
    orch.setTimeline(TIMELINE); // Mode A
    let seen = null;
    orch.onState = (s) => { seen = s; };
    orch._emit();

    expect(seen.currentTimeMs).toBeNull();
    expect(seen.durationMs).toBeNull();
  });

  it("surfaces buffering state changes from the shared audio element, and re-emits immediately", () => {
    const orch = new Orchestrator();
    orch.lines = LINES;
    orch.setTimeline(TIMELINE, { strategy: "acoustic" });
    const el = globalThis.__lastFakeAudio;
    const seen = [];
    orch.onState = (s) => seen.push(s.buffering);

    el.onwaiting();
    expect(orch.buffering).toBe(true);
    expect(seen.at(-1)).toBe(true);

    el.onplaying();
    expect(orch.buffering).toBe(false);
    expect(seen.at(-1)).toBe(false);
  });

  it("reports buffering: false outside acoustic mode even if the element is waiting", () => {
    const orch = new Orchestrator();
    orch.lines = LINES;
    orch.setTimeline(TIMELINE); // Mode A
    const el = globalThis.__lastFakeAudio;
    el.onwaiting();
    let seen = null;
    orch.onState = (s) => { seen = s; };
    orch._emit();

    expect(seen.buffering).toBe(false);
    el.onplaying(); // reset shared module state so it doesn't leak into later tests
  });

  it("resyncDisplay() forces a fresh emit while playing in acoustic mode — catches up a display left stale by a suspended rAF loop (e.g. a backgrounded tab)", () => {
    const orch = new Orchestrator();
    orch.lines = LINES;
    orch.index = 1;
    orch.status = "playing";
    orch.setTimeline(TIMELINE, { strategy: "acoustic" });
    seekSharedAudioMs(4321);
    let seen = null;
    orch.onState = (s) => { seen = s; };
    orch.resyncDisplay();

    expect(seen).not.toBeNull();
    expect(seen.currentTimeMs).toBeCloseTo(4321, 0);
  });

  it("resyncDisplay() is a no-op when paused (nothing stale to catch up)", () => {
    const orch = new Orchestrator();
    orch.lines = LINES;
    orch.status = "paused";
    orch.setTimeline(TIMELINE, { strategy: "acoustic" });
    let called = false;
    orch.onState = () => { called = true; };
    orch.resyncDisplay();

    expect(called).toBe(false);
  });

  it("resyncDisplay() is a no-op outside acoustic mode", () => {
    const orch = new Orchestrator();
    orch.lines = LINES;
    orch.status = "playing";
    orch.setTimeline(TIMELINE); // Mode A
    let called = false;
    orch.onState = () => { called = true; };
    orch.resyncDisplay();

    expect(called).toBe(false);
  });

  it("natural end-of-file still finishes playback (no per-line boundary timer of its own)", async () => {
    const orch = new Orchestrator();
    orch.configure({ autoAdvance: true });
    orch.setTimeline(TIMELINE, { strategy: "acoustic" });
    let ended = false;
    orch.onEnd = () => { ended = true; };

    await orch.play(LINES, 0);
    await waitForStatus(orch, (s) => s === "done");
    expect(ended).toBe(true);
  });

  // Progressive WhisperX alignment: an estimate plays immediately, real
  // per-line timings replace it live as the local align server streams them
  // in. The Mode B tick loop must re-read entries every frame (not a
  // snapshot captured once at play-start) for that to take effect without a
  // pause/resume — this exercises the exact mechanism directly, since the
  // FakeAudio test double's fixed 15ms auto-end fires before jsdom's ~16.7ms
  // rAF interval ever would, so a real elapsed-time tick can't be observed
  // here (see _startMediaElementClock's tick() in orchestrator.js).
  it("extendTimeline() applied mid-playback is visible to the tick loop's entries lookup on the very next read", async () => {
    const orch = new Orchestrator();
    orch.configure({ autoAdvance: true });
    // One coarse "estimate" entry spanning the whole book, standing in for
    // line 0 only — nothing yet distinguishes line 1's real start.
    orch.setTimeline({ 0: { startMs: 0, endMs: 100000, durationMs: 100000 } }, { strategy: "acoustic" });

    const playDone = orch.play([LINES[0], LINES[1]], 0);
    await waitFor(3);

    const beforeEntries = orch._mergedTimingEntries();
    expect(lineAt(beforeEntries, 50000)?.lineIndex).toBe(0); // only the coarse estimate exists yet

    // A real WhisperX chunk lands: line 1 actually starts at 40000ms, well
    // before that same 50000ms position.
    orch.extendTimeline({
      0: { startMs: 0, endMs: 40000, durationMs: 40000 },
      1: { startMs: 40000, endMs: 100000, durationMs: 60000 },
    });

    // _startMediaElementClock's tick() calls this same method every frame —
    // it must see the update immediately, not a stale snapshot from play().
    const afterEntries = orch._mergedTimingEntries();
    expect(afterEntries).not.toBe(beforeEntries);
    expect(lineAt(afterEntries, 50000)?.lineIndex).toBe(1);

    orch.stop();
    await playDone;
  });

  it("extendTimeline() is a no-op for falsy/empty input (doesn't clear an existing timeline)", () => {
    const orch = new Orchestrator();
    orch.setTimeline(TIMELINE, { strategy: "acoustic" });
    orch.extendTimeline(null);
    orch.extendTimeline({});
    expect(orch.lineTimings).toEqual(TIMELINE);
  });

  it("extendTimeline() merges new entries while preserving untouched ones", () => {
    const orch = new Orchestrator();
    orch.setTimeline({ 0: TIMELINE[0] }, { strategy: "acoustic" });
    orch.extendTimeline({ 1: TIMELINE[1] });
    expect(orch.lineTimings).toEqual({ 0: TIMELINE[0], 1: TIMELINE[1] });
  });

  it("extendTimeline() overwrites an existing entry for the same line (refines an estimate with a real timing)", () => {
    const orch = new Orchestrator();
    orch.setTimeline({ 0: { startMs: 0, endMs: 100000, durationMs: 100000 } }, { strategy: "acoustic" });
    orch.extendTimeline({ 0: { startMs: 0, endMs: 1200, durationMs: 1200 } });
    expect(orch.lineTimings[0]).toEqual({ startMs: 0, endMs: 1200, durationMs: 1200 });
  });
});

// Gap ("narrator filler") segments — audio-only content with no book-line
// counterpart, surfaced via WhisperX gap detection (see lineAt.js's
// buildMergedTimingIndex and server.py's IncrementalAligner). Exercised via
// direct state/method calls rather than a live tick(), for the same reason
// the extendTimeline test above does: FakeAudio's fixed 15ms auto-end always
// beats jsdom's ~16.7ms rAF interval in this test environment, so a real
// tick can never be observed to fire — see that test's comment.
describe("Orchestrator gap (narrator filler) segments", () => {
  beforeEach(() => {
    loadSharedAudio(new Blob([new Uint8Array(1000)], { type: "audio/mp4" }));
  });

  afterEach(() => {
    unloadSharedAudio();
    vi.restoreAllMocks();
  });

  const GAP = { id: "gap-0", startMs: 150, endMs: 180, text: "hey listener, bonus scene" };

  it("setTimeline()'s syntheticSegments are visible via the merged timing lookup tick() searches", () => {
    const orch = new Orchestrator();
    orch.setTimeline(TIMELINE, { strategy: "acoustic" }, [GAP]);
    const entries = orch._mergedTimingEntries();
    expect(entries.find((e) => e.lineIndex == null)).toEqual({
      lineIndex: null, syntheticId: GAP.id, startMs: GAP.startMs, endMs: GAP.endMs, text: GAP.text,
    });
  });

  it("extendTimeline() appends newly-arrived gaps without disturbing existing ones", () => {
    const orch = new Orchestrator();
    orch.setTimeline(TIMELINE, { strategy: "acoustic" }, [GAP]);
    const secondGap = { id: "gap-1", startMs: 250, endMs: 280, text: "outro bumper" };
    orch.extendTimeline(null, [secondGap]);
    expect(orch.syntheticSegments).toEqual([GAP, secondGap]);
  });

  it("_emit() renders an active synthetic segment as narrator dialogue while index stays frozen at the real line", () => {
    const orch = new Orchestrator();
    orch.lines = LINES;
    orch.index = 1; // frozen at the last real line before the gap
    orch.activeSynthetic = { lineIndex: null, syntheticId: GAP.id, startMs: GAP.startMs, endMs: GAP.endMs, text: GAP.text };
    let seen = null;
    orch.onState = (s) => { seen = s; };
    orch._emit();

    expect(seen.index).toBe(1);
    expect(seen.line).toEqual({ character_id: "narrator", kind: "narration", text: GAP.text });
    expect(seen.speakerId).toBe("narrator");
    expect(seen.syntheticSegment).toEqual(orch.activeSynthetic);
  });

  it("_emit() reports syntheticSegment: null and the real line once no gap is active", () => {
    const orch = new Orchestrator();
    orch.lines = LINES;
    orch.index = 1;
    let seen = null;
    orch.onState = (s) => { seen = s; };
    orch._emit();

    expect(seen.line).toBe(LINES[1]);
    expect(seen.syntheticSegment).toBeNull();
  });

  it("seek() always clears an active synthetic segment — seeking never targets a gap directly", () => {
    const orch = new Orchestrator();
    orch.lines = LINES;
    orch.activeSynthetic = { lineIndex: null, syntheticId: GAP.id, startMs: GAP.startMs, endMs: GAP.endMs, text: GAP.text };
    orch.seek(2);
    expect(orch.activeSynthetic).toBeNull();
    expect(orch.index).toBe(2);
  });

  it("play() clears any stale synthetic segment from a previous run", () => {
    const orch = new Orchestrator();
    orch.activeSynthetic = { lineIndex: null, syntheticId: GAP.id, startMs: GAP.startMs, endMs: GAP.endMs, text: GAP.text };
    orch.setTimeline({ 0: TIMELINE[0] }, { strategy: "acoustic" });
    const playDone = orch.play([LINES[0]], 0);
    expect(orch.activeSynthetic).toBeNull();
    orch.stop();
    return playDone;
  });

  it("next() resumes the acoustic clock from the real playhead (not an index seek) when paused inside a gap", async () => {
    const continuousSpy = vi.spyOn(sharedAudioSource, "playSharedContinuous");
    const orch = new Orchestrator();
    orch.configure({ autoAdvance: false });
    orch.lines = LINES;
    orch.index = 0;
    orch.status = "paused";
    orch.setTimeline(TIMELINE, { strategy: "acoustic" });
    orch.activeSynthetic = { lineIndex: null, syntheticId: GAP.id, startMs: GAP.startMs, endMs: GAP.endMs, text: GAP.text };
    seekSharedAudioMs(160); // pretend playback paused mid-gap, past the gap's own startMs

    orch.next();
    await waitFor(3);

    expect(continuousSpy).toHaveBeenCalledTimes(1);
    expect(continuousSpy.mock.calls[0][0]).toBeCloseTo(160, 0); // resumed from the real playhead
    expect(orch.index).toBe(0); // next() never touched the frozen index directly
    orch.stop();
  });

  it("play(lines, 0) starts at a leading gap's startMs instead of skipping straight to line 0", async () => {
    const continuousSpy = vi.spyOn(sharedAudioSource, "playSharedContinuous");
    const orch = new Orchestrator();
    orch.configure({ autoAdvance: true });
    const leadingGap = { id: "gap-lead", startMs: 0, endMs: 50, text: "This is Audible presents..." };
    // Line 0 doesn't actually start until 50ms in — audio before that is the
    // intro narration the leading gap covers.
    const timelineWithLeadIn = { 0: { startMs: 50, endMs: 150, durationMs: 100 } };
    orch.setTimeline(timelineWithLeadIn, { strategy: "acoustic" }, [leadingGap]);

    const playDone = orch.play([LINES[0]], 0);
    await waitFor(3);

    expect(continuousSpy.mock.calls[0][0]).toBe(0); // the gap's startMs, not line 0's (50)
    orch.stop();
    await playDone;
  });

  it("play(lines, 0) still starts at line 0's own startMs when there is no leading gap (no regression)", async () => {
    const continuousSpy = vi.spyOn(sharedAudioSource, "playSharedContinuous");
    const orch = new Orchestrator();
    orch.configure({ autoAdvance: true });
    orch.setTimeline(TIMELINE, { strategy: "acoustic" }, [GAP]); // GAP sits at 150-180ms, after line 0's start
    const playDone = orch.play(LINES, 0);
    await waitFor(3);
    expect(continuousSpy.mock.calls[0][0]).toBe(TIMELINE[0].startMs);
    orch.stop();
    await playDone;
  });

  it("seekToGap() jumps to a gap and resumes playback there, instead of parking in a state Play can't recover", async () => {
    const continuousSpy = vi.spyOn(sharedAudioSource, "playSharedContinuous");
    const orch = new Orchestrator();
    orch.configure({ autoAdvance: true });
    orch.lines = LINES;
    orch.setTimeline(TIMELINE, { strategy: "acoustic" }, [GAP]);

    orch.seekToGap(GAP.id);
    await waitFor(3);

    expect(orch.status).toBe("playing");
    expect(orch.activeSynthetic?.syntheticId).toBe(GAP.id);
    expect(continuousSpy).toHaveBeenCalledTimes(1);
    expect(continuousSpy.mock.calls[0][0]).toBeCloseTo(GAP.startMs, 0);
    orch.stop();
  });

  it("seekToGap() with an unknown id is a no-op", () => {
    const orch = new Orchestrator();
    orch.lines = LINES;
    orch.setTimeline(TIMELINE, { strategy: "acoustic" }, [GAP]);
    const before = { index: orch.index, status: orch.status, activeSynthetic: orch.activeSynthetic };
    orch.seekToGap("not-a-real-gap");
    expect({ index: orch.index, status: orch.status, activeSynthetic: orch.activeSynthetic }).toEqual(before);
  });

  it("seekToGap() before any play() call doesn't throw (index defaults to 0)", () => {
    const orch = new Orchestrator();
    orch.setTimeline(TIMELINE, { strategy: "acoustic" }, [GAP]);
    expect(() => orch.seekToGap(GAP.id)).not.toThrow();
    orch.stop();
  });
});
