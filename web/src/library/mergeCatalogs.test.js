import { describe, expect, it } from "vitest";
import { mergeCatalogEntries, mergeCatalogsBySource } from "./mergeCatalogs.js";

describe("mergeCatalogEntries", () => {
  it("overlays a pending entry not yet on the server list", () => {
    const merged = mergeCatalogEntries([], [{ book_id: "a", title: "A", progress: 0 }]);
    expect(merged.map((b) => b.book_id)).toEqual(["a"]);
  });

  it("prefers server fields but keeps the max progress", () => {
    const merged = mergeCatalogEntries(
      [{ book_id: "a", title: "A", progress: 0.4 }],
      [{ book_id: "a", title: "A (pending)", progress: 0.7 }],
    );
    expect(merged[0].progress).toBe(0.7);
    expect(merged[0].title).toBe("A");
  });
});

describe("mergeCatalogsBySource", () => {
  it("tags entries with connection_id/connection_kind", () => {
    const merged = mergeCatalogsBySource([
      { connection: { id: "offline", kind: "offline" }, entries: [{ book_id: "a", title: "A" }] },
      { connection: { id: "server", kind: "server" }, entries: [{ book_id: "b", title: "B" }] },
    ]);
    expect(merged).toEqual([
      { book_id: "a", title: "A", connection_id: "offline", connection_kind: "offline" },
      { book_id: "b", title: "B", connection_id: "server", connection_kind: "server" },
    ]);
  });

  it("keeps the same book_id on two backends as two distinct entries", () => {
    const merged = mergeCatalogsBySource([
      { connection: { id: "server", kind: "server" }, entries: [{ book_id: "a", title: "A" }] },
      { connection: { id: "tunnel-1", kind: "remote" }, entries: [{ book_id: "a", title: "A" }] },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.map((e) => e.connection_id).sort()).toEqual(["server", "tunnel-1"]);
  });

  it("dedupes within a single connection's own entries by book_id", () => {
    const merged = mergeCatalogsBySource([
      {
        connection: { id: "server", kind: "server" },
        entries: [
          { book_id: "a", title: "A v1" },
          { book_id: "a", title: "A v2" },
        ],
      },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe("A v2");
  });
});
