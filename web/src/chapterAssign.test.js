import { describe, expect, it } from "vitest";
import {
  assignChaptersFromEpub,
  formatSettingTitle,
  finalizeAnalysisChapters,
  renormalizeChapters,
} from "../../worker/_shared/chapter-assign.js";

describe("chapter-assign", () => {
  it("renormalizes non-contiguous chapter numbers", () => {
    const out = renormalizeChapters({
      scenes: [
        { id: "s1", chapter: 3, lines: [{ text: "One" }] },
        { id: "s2", chapter: 4, lines: [{ text: "Two" }] },
      ],
    });
    expect(out.scenes.map((s) => s.chapter)).toEqual([1, 2]);
  });

  it("assigns scenes to epub chapters by anchor text", () => {
    const analysis = {
      scenes: [
        { id: "s1", chapter: 1, title: "Start", lines: [{ text: "Alpha opened the gate quietly." }] },
        { id: "s2", chapter: 1, title: "Later", lines: [{ text: "Beta crossed the river at dawn." }] },
      ],
    };
    const epubChapters = [
      { index: 1, title: "Chapter One", text: "Alpha opened the gate quietly. Much more prose here." },
      { index: 2, title: "Chapter Two", text: "Beta crossed the river at dawn. End." },
    ];
    const out = assignChaptersFromEpub(analysis, epubChapters);
    expect(out.scenes.map((s) => s.chapter)).toEqual([1, 2]);
  });

  it("formats setting-style scene titles", () => {
    expect(formatSettingTitle({
      title: "Chapter 3: The Journey",
      location: "forest",
      background_desc: "A dark forest at night with mist between the trees.",
    })).toMatch(/Forest/i);
    expect(formatSettingTitle({
      title: "Castle Gate at Dusk",
      location: "castle gate",
    })).toBe("Castle Gate at Dusk");
  });

  it("finalize stores chapter meta and normalizes titles", () => {
    const out = finalizeAnalysisChapters({
      scenes: [{
        id: "s1",
        chapter: 1,
        title: "Chapter 1: Arrival",
        location: "rooftop",
        background_desc: "City rooftop at sunset.",
        lines: [{ text: "Hello." }],
      }],
    }, {
      epubChapters: [
        { index: 1, title: "Arrival", text: "Hello." },
        { index: 2, title: "Departure", text: "Goodbye." },
      ],
    });
    expect(out.chapters?.length).toBe(2);
    expect(out.scenes[0].title).not.toMatch(/^Chapter/i);
  });
});
