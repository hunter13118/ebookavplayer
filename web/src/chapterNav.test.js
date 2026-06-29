import { describe, expect, it } from "vitest";
import { sampleBook } from "./sampleBook.js";
import {
  buildChapterIndex,
  chapterAtLine,
  chapterRelativeIndex,
  charactersForChapter,
  chapterLineCount,
  chapterLabel,
} from "./chapterNav.js";

describe("chapterNav", () => {
  const chapters = buildChapterIndex(sampleBook.scenes);

  it("builds chapter index from scenes", () => {
    expect(chapters.length).toBeGreaterThan(0);
    expect(chapters[0].chapter).toBe(1);
    expect(chapterLineCount(chapters[0])).toBeGreaterThan(0);
  });

  it("maps line index to chapter", () => {
    const ch = chapterAtLine(chapters, 0);
    expect(ch?.chapter).toBe(1);
  });

  it("computes relative slide index within chapter", () => {
    const { relIndex, chapterTotal } = chapterRelativeIndex(chapters, 0);
    expect(relIndex).toBe(0);
    expect(chapterTotal).toBeGreaterThan(0);
  });

  it("lists characters present in a chapter", () => {
    const chars = [{ id: "elara", name: "Elara" }, { id: "garrick", name: "Garrick" }];
    const inCh = charactersForChapter(chapters, 1, chars);
    expect(inCh.some((c) => c.id === "elara")).toBe(true);
  });

  it("uses epub chapter titles in labels", () => {
    const ch = chapters[0];
    expect(chapterLabel(ch, [{ chapter: 1, title: "The Silver Gate" }]))
      .toBe("Ch. 1: The Silver Gate");
  });
});
