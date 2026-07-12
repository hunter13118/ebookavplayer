import { describe, expect, it } from "vitest";
import { listIllustrationPlates } from "./illustrationCatalog.js";

const book = {
  cover_illustration_ref: 0,
  illustration_urls: { 0: "/media/x/illustrations/img_000.png", 1: "/media/x/illustrations/img_001.png" },
};

describe("illustrationCatalog", () => {
  it("lists plates in index order", () => {
    const plates = listIllustrationPlates(book);
    expect(plates).toHaveLength(2);
    expect(plates[0].index).toBe(0);
    expect(plates[0].label).toContain("cover");
  });
});
