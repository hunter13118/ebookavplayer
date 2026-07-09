import { describe, expect, it } from "vitest";
import { spotlightCharacterId } from "./lineKinds.js";

describe("spotlightCharacterId", () => {
  it("keeps the prior dialogue speaker lit through a kind=delivery tag", () => {
    const lines = [
      { kind: "dialogue", character_id: "mira", text: "It is cold," },
      { kind: "delivery", character_id: "narrator", text: "sang Mira" },
    ];
    expect(spotlightCharacterId(lines, 1)).toBe("mira");
  });

  it("keeps the speaker lit through a short interrupted-dialogue narration tag (Phase 4)", () => {
    const lines = [
      { kind: "dialogue", character_id: "kuro", text: "Whatever you wish for," },
      { kind: "narration", character_id: "narrator", text: "he said quietly." },
      { kind: "dialogue", character_id: "kuro", text: "The coin only summoned me." },
    ];
    expect(spotlightCharacterId(lines, 1)).toBe("kuro");
  });

  it("resets to idle for a long narration paragraph even between same-speaker dialogue", () => {
    const lines = [
      { kind: "dialogue", character_id: "kuro", text: "Whatever you wish for," },
      {
        kind: "narration",
        character_id: "narrator",
        text: "He paused for a long moment, looking out over the valley and remembering everything that had happened since the day they first arrived at the gate, wondering if any of it had truly mattered.",
      },
      { kind: "dialogue", character_id: "kuro", text: "The coin only summoned me." },
    ];
    expect(spotlightCharacterId(lines, 1)).toBe(null);
  });

  it("resets to idle when the narration tag sits between two DIFFERENT speakers", () => {
    const lines = [
      { kind: "dialogue", character_id: "kuro", text: "Hello," },
      { kind: "narration", character_id: "narrator", text: "said Kuro." },
      { kind: "dialogue", character_id: "mei", text: "Hi." },
    ];
    expect(spotlightCharacterId(lines, 1)).toBe(null);
  });

  it("returns the line's own character_id for an ordinary dialogue line", () => {
    const lines = [{ kind: "dialogue", character_id: "mei", text: "Hi." }];
    expect(spotlightCharacterId(lines, 0)).toBe("mei");
  });

  it("returns null for a plain narrator narration line", () => {
    const lines = [{ kind: "narration", character_id: "narrator", text: "Rain fell." }];
    expect(spotlightCharacterId(lines, 0)).toBe(null);
  });
});
