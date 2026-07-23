import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSharedAudio, unloadSharedAudio, isSharedAudioLoaded, stopSharedAudio,
  playSharedContinuous, getSharedAudioCurrentTimeMs, seekSharedAudioMs,
  isSharedAudioBuffering, onSharedAudioBufferingChange,
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

  it("stopSharedAudio is a safe no-op when nothing has ever been loaded", () => {
    expect(() => stopSharedAudio()).not.toThrow();
  });

  it("loading a new blob while one is already loaded replaces it without throwing", () => {
    loadSharedAudio(new Blob([new Uint8Array(10)]));
    expect(() => loadSharedAudio(new Blob([new Uint8Array(20)]))).not.toThrow();
    expect(isSharedAudioLoaded()).toBe(true);
  });

  describe("playSharedContinuous", () => {
    it("calls onError (not onEnded) when nothing is loaded", async () => {
      const onEnded = vi.fn();
      const onError = vi.fn();
      await playSharedContinuous(0, 1, { onEnded, onError });
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onEnded).not.toHaveBeenCalled();
    });

    it("seeks to fromMs and starts playing, with no boundary-kill timer of its own", async () => {
      loadSharedAudio(new Blob([new Uint8Array(100)]));
      await playSharedContinuous(2500, 1, {});
      expect(getSharedAudioCurrentTimeMs()).toBeCloseTo(2500, 0);
    });

    it("onEnded fires on real end-of-file (natural onended)", async () => {
      loadSharedAudio(new Blob([new Uint8Array(100)]));
      const onEnded = vi.fn();
      await new Promise((resolve) => {
        playSharedContinuous(0, 1, { onEnded: () => { onEnded(); resolve(); } });
      });
      expect(onEnded).toHaveBeenCalledTimes(1);
    });

    it("stopSharedAudio prevents a stale onEnded from firing after a pause", async () => {
      loadSharedAudio(new Blob([new Uint8Array(100)]));
      const onEnded = vi.fn();
      playSharedContinuous(0, 1, { onEnded });
      await waitFor(5);
      stopSharedAudio(); // pauses in place, invalidates this call's handlers
      await waitFor(30); // long enough for FakeAudio's natural onended to have fired
      expect(onEnded).not.toHaveBeenCalled();
    });

    it("a newer playSharedContinuous call supersedes an older one's onEnded", async () => {
      loadSharedAudio(new Blob([new Uint8Array(100)]));
      const firstEnded = vi.fn();
      const secondEnded = vi.fn();
      playSharedContinuous(0, 1, { onEnded: firstEnded });
      await waitFor(5);
      await new Promise((resolve) => {
        playSharedContinuous(1000, 1, { onEnded: () => { secondEnded(); resolve(); } });
      });
      await waitFor(20);
      expect(secondEnded).toHaveBeenCalledTimes(1);
      expect(firstEnded).not.toHaveBeenCalled();
    });

    it("getSharedAudioCurrentTimeMs returns 0 when nothing has ever been loaded", () => {
      expect(getSharedAudioCurrentTimeMs()).toBe(0);
    });

    it("seekSharedAudioMs updates the playhead without starting playback", () => {
      loadSharedAudio(new Blob([new Uint8Array(100)]));
      seekSharedAudioMs(4200);
      expect(getSharedAudioCurrentTimeMs()).toBeCloseTo(4200, 0);
    });
  });

  describe("buffering state", () => {
    it("is false before anything ever waits", () => {
      loadSharedAudio(new Blob([new Uint8Array(100)]));
      expect(isSharedAudioBuffering()).toBe(false);
    });

    it("tracks the element's real waiting/playing events and notifies subscribers", () => {
      loadSharedAudio(new Blob([new Uint8Array(100)]));
      const el = globalThis.__lastFakeAudio;
      const seen = [];
      const unsubscribe = onSharedAudioBufferingChange((b) => seen.push(b));

      el.onwaiting();
      expect(isSharedAudioBuffering()).toBe(true);

      el.onplaying();
      expect(isSharedAudioBuffering()).toBe(false);

      expect(seen).toEqual([true, false]);
      unsubscribe();
    });

    it("does not notify subscribers when the state doesn't actually change", () => {
      loadSharedAudio(new Blob([new Uint8Array(100)]));
      const el = globalThis.__lastFakeAudio;
      const seen = [];
      const unsubscribe = onSharedAudioBufferingChange((b) => seen.push(b));

      el.onplaying(); // already false -> false, no-op
      expect(seen).toEqual([]);

      el.onwaiting();
      el.onwaiting(); // already true -> true, second call is a no-op
      expect(seen).toEqual([true]);
      el.onplaying(); // reset back to false so buffering state doesn't leak into later tests
      unsubscribe();
    });

    it("unsubscribe stops further notifications", () => {
      loadSharedAudio(new Blob([new Uint8Array(100)]));
      const el = globalThis.__lastFakeAudio;
      const seen = [];
      const unsubscribe = onSharedAudioBufferingChange((b) => seen.push(b));
      unsubscribe();

      el.onwaiting();
      expect(seen).toEqual([]);
    });
  });
});
