import { describe, expect, it } from "vitest";
import { slotXForIndex, stageLayout, sleepTimerRemainingMs } from "./timing.js";

describe("slotXForIndex", () => {
  it("uses preset positions for 1–3 sprites", () => {
    expect(slotXForIndex(0, 1)).toBe(50);
    expect(slotXForIndex(0, 2)).toBe(32);
    expect(slotXForIndex(1, 2)).toBe(68);
    expect(slotXForIndex(1, 3)).toBe(50);
  });
});

describe("stageLayout", () => {
  const present = [
    { character_id: "a" },
    { character_id: "b" },
    { character_id: "c" },
    { character_id: "d" },
  ];

  it("spotlights speaker and dims extras in group scenes", () => {
    const laid = stageLayout(present, "c", 2);
    expect(laid.find((p) => p.character_id === "c").spotlight).toBe(true);
    expect(laid.some((p) => p.dim)).toBe(true);
  });

  it("keeps stable sort order regardless of speaker", () => {
    const asSpeaker = stageLayout(present, "a", 2).map((p) => p.character_id);
    const csSpeaker = stageLayout(present, "c", 2).map((p) => p.character_id);
    expect(asSpeaker).toEqual(["a", "b", "c", "d"]);
    expect(csSpeaker).toEqual(["a", "b", "c", "d"]);
  });

  it("assigns stable slotX per character_id index", () => {
    const trio = present.slice(0, 3);
    const laid = stageLayout(trio, "c", 2);
    expect(laid[0].slotX).toBe(22);
    expect(laid[2].slotX).toBe(78);
    const again = stageLayout(trio, "a", 2);
    expect(again[2].slotX).toBe(78);
  });

  it("does not dim anyone in a 1:1 scene", () => {
    const pair = stageLayout(present.slice(0, 2), "a", 2);
    expect(pair.some((p) => p.dim)).toBe(false);
  });
});

describe("sleepTimerRemainingMs", () => {
  it("is null when the timer is off (0/falsy minutes)", () => {
    expect(sleepTimerRemainingMs(1000, 0, 2000)).toBeNull();
    expect(sleepTimerRemainingMs(1000, null, 2000)).toBeNull();
  });

  it("is null when the timer hasn't been started", () => {
    expect(sleepTimerRemainingMs(null, 5, 2000)).toBeNull();
  });

  it("returns the full duration right when started", () => {
    expect(sleepTimerRemainingMs(1000, 1, 1000)).toBe(60_000);
  });

  it("counts down as time elapses", () => {
    expect(sleepTimerRemainingMs(1000, 1, 1000 + 30_000)).toBe(30_000);
  });

  it("clamps at 0 once elapsed (never negative)", () => {
    expect(sleepTimerRemainingMs(1000, 1, 1000 + 90_000)).toBe(0);
  });
});
