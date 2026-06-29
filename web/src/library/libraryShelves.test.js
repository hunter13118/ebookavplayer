import { describe, expect, it, beforeEach } from "vitest";
import {
  filterByShelf, sortLibraryItems, assignBookToShelf, getShelfAssignments,
  SORT_TITLE, SORT_AUTHOR, ALL_SHELF_ID,
} from "./libraryShelves.js";

describe("libraryShelves", () => {
  const items = [
    { book_id: "b", title: "Bravo", author: "Zed", progress: 0.2 },
    { book_id: "a", title: "Alpha", author: "Amy", progress: 0.9 },
  ];

  beforeEach(() => {
    localStorage.clear();
  });

  it("sorts by title", () => {
    const out = sortLibraryItems(items, SORT_TITLE);
    expect(out.map((x) => x.book_id)).toEqual(["a", "b"]);
  });

  it("sorts by author", () => {
    const out = sortLibraryItems(items, SORT_AUTHOR);
    expect(out[0].author).toBe("Amy");
  });

  it("filters custom shelf", () => {
    assignBookToShelf("a", "reading");
    const out = filterByShelf(items, "reading");
    expect(out).toHaveLength(1);
    expect(out[0].book_id).toBe("a");
    expect(filterByShelf(items, ALL_SHELF_ID)).toHaveLength(2);
  });
});
