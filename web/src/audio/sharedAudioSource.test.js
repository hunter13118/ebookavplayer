import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSharedAudio, unloadSharedAudio, isSharedAudioLoaded, playSharedSegment, stopSharedAudio,
} from "./sharedAudioSource.js";

function waitFor(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("sharedAudioSource", () => {
  beforeEach(() => {
    unloadSharedAudio();
  });

  it("is not loaded until loadSharedAudio is called", () => {
    expect(isSharedAudioLoaded()).toBe(false);
  });

  it("reports loaded after loadSharedAudio", () => {
    loadSharedAudio(new Blob([new Uint8Array(10)], { type: "audio/mp4" }));
    expect(isSharedAudioLoaded()).toBe(true);
  });

  it("reports not loaded after unloadSharedAudio", () => {
    loadSharedAudio(new Blob([new Uint8Array(10)]));
    unloadSharedAudio();
    expect(isSharedAudioLoaded()).toBe(false);
  });

  it("playSharedSegment calls onError (not onStart/onEnd) when nothing is loaded", async () => {
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const onError = vi.fn();
    await playSharedSegment(0, 1000, 1, { onStart, onEnd, onError });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
  });

  it("plays a segment: onStart fires with a numeric duration, then onEnd fires", async () => {
    loadSharedAudio(new Blob([new Uint8Array(100)]));
    const onStart = vi.fn();
    const ended = new Promise((resolve) => {
      playSharedSegment(0, 2000, 1, { onStart, onEnd: resolve, onError: resolve });
    });
    await ended;
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(typeof onStart.mock.calls[0][0]).toBe("number");
    expect(onStart.mock.calls[0][0]).toBeGreaterThan(0);
  });

  it("divides the reported duration by the playback rate", async () => {
    loadSharedAudio(new Blob([new Uint8Array(100)]));
    const onStart = vi.fn();
    await new Promise((resolve) => {
      playSharedSegment(0, 2000, 2, { onStart, onEnd: resolve, onError: resolve });
    });
    // [0,2000) at rate 2 -> 1.0s, not 2.0s.
    expect(onStart.mock.calls[0][0]).toBeCloseTo(1, 1);
  });

  it("defaults to rate 1 when rate is falsy/zero", async () => {
    loadSharedAudio(new Blob([new Uint8Array(100)]));
    const onStart = vi.fn();
    await new Promise((resolve) => {
      playSharedSegment(0, 1000, 0, { onStart, onEnd: resolve, onError: resolve });
    });
    expect(onStart.mock.calls[0][0]).toBeCloseTo(1, 1);
  });

  it("onEnd is called at most once per segment (no double-fire from the natural-end safety net)", async () => {
    loadSharedAudio(new Blob([new Uint8Array(100)]));
    const onEnd = vi.fn();
    await new Promise((resolve) => {
      playSharedSegment(0, 100, 1, { onEnd: () => { onEnd(); resolve(); }, onError: resolve });
    });
    await waitFor(40); // let any stray natural-end timer also fire, if it were going to
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("stopSharedAudio settles an in-flight segment's onEnd exactly once instead of leaving a caller awaiting it hanging forever", async () => {
    // Mirrors orchestrator._playSilent's setTimeout-based wait, which always
    // resolves regardless of pause/stop — a caller awaiting a segment's
    // completion (the orchestrator's playback loop) must always be
    // unblocked by an explicit stop, never left hanging on a never-firing
    // promise just because the boundary timer/native onended got cancelled.
    loadSharedAudio(new Blob([new Uint8Array(100)]));
    const onEnd = vi.fn();
    const onError = vi.fn();
    playSharedSegment(0, 5000, 1, { onEnd, onError }); // long segment, won't finish naturally for a while
    await waitFor(5); // let play() resolve and onStart fire
    stopSharedAudio();
    await waitFor(40);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("stopSharedAudio never double-fires onEnd if the boundary timer was already about to settle it", async () => {
    loadSharedAudio(new Blob([new Uint8Array(100)]));
    const onEnd = vi.fn();
    playSharedSegment(0, 10, 1, { onEnd }); // very short segment
    await waitFor(40); // let it settle naturally first
    expect(() => stopSharedAudio()).not.toThrow();
    await waitFor(10);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("starting a new segment supersedes a prior in-flight one — only the new one's callbacks fire", async () => {
    loadSharedAudio(new Blob([new Uint8Array(100)]));
    const firstEnd = vi.fn();
    const secondEnd = vi.fn();
    playSharedSegment(0, 5000, 1, { onEnd: firstEnd });
    await waitFor(5);
    await new Promise((resolve) => {
      playSharedSegment(1000, 1100, 1, { onEnd: () => { secondEnd(); resolve(); } });
    });
    await waitFor(20);
    expect(secondEnd).toHaveBeenCalledTimes(1);
    expect(firstEnd).not.toHaveBeenCalled();
  });

  it("stopSharedAudio is a safe no-op when nothing has ever been loaded", () => {
    expect(() => stopSharedAudio()).not.toThrow();
  });

  it("loading a new blob while one is already loaded replaces it without throwing", () => {
    loadSharedAudio(new Blob([new Uint8Array(10)]));
    expect(() => loadSharedAudio(new Blob([new Uint8Array(20)]))).not.toThrow();
    expect(isSharedAudioLoaded()).toBe(true);
  });

  it("playSharedSegment after unloadSharedAudio errors again (does not reuse a stale blob)", async () => {
    loadSharedAudio(new Blob([new Uint8Array(10)]));
    unloadSharedAudio();
    const onError = vi.fn();
    await playSharedSegment(0, 1000, 1, { onError });
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
