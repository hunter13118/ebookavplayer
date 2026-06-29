import { describe, expect, it } from "vitest";
import { artSlotHasMedia, summarizeArtChecklist } from "./artChecklist.js";

describe("artChecklist", () => {
  it("detects /media/ URLs as filled", () => {
    expect(artSlotHasMedia("/media/book/anime/char_x.png")).toBe(true);
    expect(artSlotHasMedia("sprite:gradient:120,160")).toBe(false);
    expect(artSlotHasMedia("gradient:120,160")).toBe(false);
  });

  it("summarizes filled slots", () => {
    const items = [
      { key: "cover", preview: "/media/x/anime/cover.png" },
      { key: "char:a", preview: "sprite:gradient:1,2" },
    ];
    const s = summarizeArtChecklist(items);
    expect(s.filled).toBe(1);
    expect(s.total).toBe(2);
    expect(s.items.find((r) => r.key === "cover")?.filled).toBe(true);
  });
});
