import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import {
  matchArtPackFilename,
  planArtPackUpload,
  readArtPackFromZip,
  suggestedArtFilename,
  slugifyName,
} from "./byoArtPack.js";

const book = {
  book_id: "test-book",
  characters: {
    "mei-asano": { name: "Mei Asano" },
    narrator: { name: "Narrator" },
  },
  scenes: [
    { id: "scene-0001", title: "Gate", lines: [{ idx: 0 }, { idx: 27 }] },
  ],
};

describe("byoArtPack", () => {
  it("suggests worker-aligned filenames", () => {
    expect(suggestedArtFilename({ kind: "cover", id: "cover" })).toBe("cover.png");
    expect(suggestedArtFilename({ kind: "characters", id: "mei-asano" })).toBe("char_mei-asano.png");
    expect(suggestedArtFilename({ kind: "backgrounds", id: "scene-0001" })).toBe("bg_scene-0001.png");
  });

  it("matches standard names", () => {
    expect(matchArtPackFilename("cover.png", book)?.kind).toBe("cover");
    expect(matchArtPackFilename("char_mei-asano.png", book)?.key).toBe("mei-asano");
    expect(matchArtPackFilename("bg_scene-0001.jpg", book)?.kind).toBe("backgrounds");
    expect(matchArtPackFilename("insert_27.webp", book)?.kind).toBe("inserts");
    expect(matchArtPackFilename("moment_0.png", book)?.key).toBe("0");
  });

  it("matches character by slugified name", () => {
    expect(matchArtPackFilename("char_mei-asano.png", book)?.key).toBe("mei-asano");
    expect(slugifyName("Mei Asano")).toBe("mei-asano");
  });

  it("reads zip and plans uploads", async () => {
    const zip = zipSync({
      "cover.png": new Uint8Array([1, 2, 3]),
      "char_mei-asano.png": new Uint8Array([4, 5]),
      "readme.txt": new Uint8Array([9]),
    });
    const file = new File([zip], "pack.zip", { type: "application/zip" });
    const entries = await readArtPackFromZip(file);
    expect(entries).toHaveLength(2);
    const plan = planArtPackUpload(book, entries);
    expect(plan.matched).toHaveLength(2);
    expect(plan.unmatched).toHaveLength(0);
  });

  it("flags unrecognized files", () => {
    const plan = planArtPackUpload(book, [{
      path: "random.png",
      file: new File([new Uint8Array([1])], "random.png", { type: "image/png" }),
    }]);
    expect(plan.matched).toHaveLength(0);
    expect(plan.unmatched).toHaveLength(1);
  });
});
