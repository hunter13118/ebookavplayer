import { describe, it, expect } from "vitest";
import { nextGalleryIndex } from "./ArtGallery.jsx";

describe("nextGalleryIndex", () => {
  it("advances to the next index while more images remain", () => {
    expect(nextGalleryIndex(0, 3)).toBe(1);
    expect(nextGalleryIndex(1, 3)).toBe(2);
  });

  it("returns -1 once the last image has been shown/skipped", () => {
    expect(nextGalleryIndex(2, 3)).toBe(-1);
  });

  it("returns -1 immediately for a single-image gallery", () => {
    expect(nextGalleryIndex(0, 1)).toBe(-1);
  });
});
