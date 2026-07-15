import { describe, expect, it } from "vitest";
import { classifyAmbience } from "./ambientClassifier.js";

describe("ambientClassifier", () => {
  it("detects tavern from location", () => {
    expect(classifyAmbience({ location: "The Rusty Anchor Tavern" })).toBe("tavern");
  });

  it("detects forest from location", () => {
    expect(classifyAmbience({ location: "Black Forest" })).toBe("forest");
  });

  it("detects rain from title", () => {
    expect(classifyAmbience({ title: "Caught in the Storm", location: "city streets" })).toBe("rain");
  });

  it("detects wind from location", () => {
    expect(classifyAmbience({ location: "the windy cliffside" })).toBe("wind");
  });

  it("returns null when nothing matches", () => {
    expect(classifyAmbience({ title: "Chapter 2", location: "blacksmith workshop" })).toBeNull();
  });

  it("returns null for an empty/missing scene", () => {
    expect(classifyAmbience(null)).toBeNull();
    expect(classifyAmbience({})).toBeNull();
  });
});
