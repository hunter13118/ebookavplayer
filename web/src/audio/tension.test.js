import { describe, expect, it } from "vitest";
import { nextTension } from "./tension.js";

describe("nextTension", () => {
  it("builds on a dramatic high-intensity line", () => {
    const t = nextTension(0, { expression: "angry", intensity: 0.9 });
    expect(t).toBeGreaterThan(0);
  });

  it("decays on a calm/normal line", () => {
    const t = nextTension(0.6, { expression: "normal", intensity: 1 });
    expect(t).toBeLessThan(0.6);
  });

  it("decays when there is no line at all (scene boundary / gap)", () => {
    const t = nextTension(0.6, null);
    expect(t).toBeLessThan(0.6);
  });

  it("does not build on a dramatic but low-intensity line", () => {
    const t = nextTension(0.2, { expression: "sad", intensity: 0.3 });
    expect(t).toBeLessThan(0.2);
  });

  it("clamps to [0, 1]", () => {
    let t = 0;
    for (let i = 0; i < 20; i += 1) t = nextTension(t, { expression: "yell", intensity: 1 });
    expect(t).toBeLessThanOrEqual(1);
    for (let i = 0; i < 20; i += 1) t = nextTension(t, { expression: "normal", intensity: 1 });
    expect(t).toBeGreaterThanOrEqual(0);
  });

  it("freeform expression values normalize before the dramatic check", () => {
    const t = nextTension(0, { expression: "screaming", intensity: 0.9 }); // alias -> yell
    expect(t).toBeGreaterThan(0);
  });
});
