import { describe, expect, it } from "vitest";
import {
  listIllustrationPlates,
  plateAssignmentMap,
  characterIllustrationRefs,
} from "./illustrationCatalog.js";

const book = {
  cover_illustration_ref: 0,
  illustration_urls: { 0: "/media/x/illustrations/img_000.png", 1: "/media/x/illustrations/img_001.png" },
  characters: {
    mei: { name: "Mei", illustration_ref: 1 },
    narrator: { name: "Narrator" },
  },
};

describe("illustrationCatalog", () => {
  it("lists plates in index order", () => {
    const plates = listIllustrationPlates(book);
    expect(plates).toHaveLength(2);
    expect(plates[0].index).toBe(0);
    expect(plates[0].label).toContain("cover");
  });

  it("maps plate usage", () => {
    const map = plateAssignmentMap(book);
    expect(map.get(0)).toEqual(["Cover"]);
    expect(map.get(1)).toEqual(["Mei"]);
  });

  it("exports character refs", () => {
    expect(characterIllustrationRefs(book)).toEqual({ mei: 1 });
  });
});
