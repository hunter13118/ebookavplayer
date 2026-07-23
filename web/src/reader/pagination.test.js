import { describe, it, expect } from "vitest";
import { paginate, pageOfLine } from "./pagination.js";

describe("paginate", () => {
  it("packs sentences greedily into pages that fit the height", () => {
    // heights 30 each, page cap 100 → 3 per page (90), then overflow.
    const pages = paginate([30, 30, 30, 30, 30], 100);
    expect(pages).toEqual([
      { startLine: 0, endLine: 3 },
      { startLine: 3, endLine: 5 },
    ]);
  });

  it("gives a sentence taller than the whole page its own page", () => {
    const pages = paginate([40, 250, 40], 100);
    expect(pages).toEqual([
      { startLine: 0, endLine: 1 },
      { startLine: 1, endLine: 2 },
      { startLine: 2, endLine: 3 },
    ]);
  });

  it("returns no pages for an empty transcript", () => {
    expect(paginate([], 100)).toEqual([]);
  });

  it("puts everything on one page when it all fits", () => {
    expect(paginate([10, 10, 10], 100)).toEqual([{ startLine: 0, endLine: 3 }]);
  });
});

describe("pageOfLine", () => {
  const pages = [
    { startLine: 0, endLine: 3 },
    { startLine: 3, endLine: 5 },
  ];
  it("maps a line index to its page", () => {
    expect(pageOfLine(pages, 0)).toBe(0);
    expect(pageOfLine(pages, 2)).toBe(0);
    expect(pageOfLine(pages, 3)).toBe(1);
    expect(pageOfLine(pages, 4)).toBe(1);
  });
  it("clamps out-of-range indices to the last page", () => {
    expect(pageOfLine(pages, 99)).toBe(1);
  });
  it("returns 0 when not yet paginated", () => {
    expect(pageOfLine([], 5)).toBe(0);
  });
});
