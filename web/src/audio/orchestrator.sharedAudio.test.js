import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { loadSharedAudio, unloadSharedAudio } from "./sharedAudioSource.js";

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
