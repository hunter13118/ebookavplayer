import { describe, expect, it } from "vitest";
import { sceneDisplayTitle } from "./sceneLabels.js";

describe("sceneLabels", () => {
  it("prefers evocative title over chapter heading", () => {
    expect(sceneDisplayTitle({
      title: "The Gate at Dusk",
      location: "castle gate",
    })).toBe("The Gate at Dusk");
  });

  it("builds setting label from location and mood", () => {
    const label = sceneDisplayTitle({
      title: "Chapter 2",
      location: "forest",
      background_desc: "Deep woods at night, fireflies drifting.",
    });
    expect(label.toLowerCase()).toContain("forest");
  });
});
