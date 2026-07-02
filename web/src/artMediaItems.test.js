import { describe, expect, it } from "vitest";
import { listArtMediaItems, listArtMediaGroups, selectionToGenerateBody } from "./artMediaItems.js";

function makeBook() {
  return {
    cover: null,
    art_style: "anime",
    characters: {
      eizo: { name: "Eizo", importance: "primary", sprite: null, chapter: 0 },
      samya: { name: "Samya", importance: "secondary", sprite: null, chapter: 1 },
      narrator: { name: "Narrator" },
    },
    chapters: [
      { index: 0, title: "Forest Friend" },
      { index: 1, title: "Treasure Hunt" },
    ],
    scenes: [
      {
        id: "s0", chapter: 0, title: "Forest", background: null,
        present: [{ character_id: "eizo" }],
        lines: [{ character_id: "eizo", text: "hi" }],
      },
      {
        id: "s1", chapter: 1, title: "Market", background: null,
        present: [{ character_id: "samya" }],
        lines: [{ character_id: "samya", text: "hey" }],
      },
    ],
  };
}

describe("artMediaItems", () => {
  it("carries each character's chapter (not hardcoded 0)", () => {
    const items = listArtMediaItems(makeBook());
    const eizo = items.find((it) => it.key === "char:eizo");
    const samya = items.find((it) => it.key === "char:samya");
    expect(eizo.chapter).toBe(0);
    expect(samya.chapter).toBe(1);
  });

  it("groups characters by chapter alongside backgrounds, not in one flat list", () => {
    const groups = listArtMediaGroups(makeBook());
    const groupIds = groups.map((g) => g.id);
    // No single flat "characters" group anymore.
    expect(groupIds).not.toContain("characters");

    const ch0 = groups.find((g) => g.id === "chapter-0");
    const ch1 = groups.find((g) => g.id === "chapter-1");
    expect(ch0.items.some((it) => it.key === "char:eizo")).toBe(true);
    expect(ch0.items.some((it) => it.key === "bg:s0")).toBe(true);
    expect(ch1.items.some((it) => it.key === "char:samya")).toBe(true);
    expect(ch1.items.some((it) => it.key === "bg:s1")).toBe(true);
    // A character should not leak into a different chapter's group.
    expect(ch0.items.some((it) => it.key === "char:samya")).toBe(false);
  });

  it("falls back legacy (chapterless) characters into one group without crashing", () => {
    const book = makeBook();
    delete book.characters.eizo.chapter;
    delete book.characters.samya.chapter;
    const groups = listArtMediaGroups(book);
    // Legacy books (no per-character chapter data) degrade to chapter 0 bucket.
    const ch0 = groups.find((g) => g.id === "chapter-0");
    expect(ch0.items.some((it) => it.key === "char:eizo")).toBe(true);
    expect(ch0.items.some((it) => it.key === "char:samya")).toBe(true);
  });

  it("selectionToGenerateBody uses the book's stored style by default", () => {
    const book = makeBook();
    const items = listArtMediaItems(book);
    const body = selectionToGenerateBody([items[0].key], items, book);
    expect(body.art_style).toBe("anime");
  });

  it("selectionToGenerateBody prefers a styleOverride from the art-style picker", () => {
    const book = makeBook();
    const items = listArtMediaItems(book);
    const body = selectionToGenerateBody([items[0].key], items, book, { styleOverride: "watercolor storybook" });
    expect(body.art_style).toBe("watercolor storybook");
  });
});
