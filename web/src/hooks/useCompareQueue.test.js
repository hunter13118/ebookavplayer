import { describe, expect, it, beforeEach } from "vitest";

const compareStorageKey = (bookId) => `vae-compare-lock:${bookId}`;

function writeCompareSession(bookId, data) {
  if (!bookId) return;
  if (!data) sessionStorage.removeItem(compareStorageKey(bookId));
  else sessionStorage.setItem(compareStorageKey(bookId), JSON.stringify(data));
}

function readCompareSession(bookId) {
  try {
    const raw = sessionStorage.getItem(compareStorageKey(bookId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

describe("compare session storage", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("persists locked compare until explicitly cleared", () => {
    const item = {
      kind: "characters",
      key: "mei",
      before_url: "/old.png",
      after_url: "/new.png",
      label: "Mei",
      jobId: "job-1",
    };
    writeCompareSession("book-a", {
      jobId: "job-1",
      lockedCompare: item,
      waitQueue: [],
      queueRemaining: 0,
      seen: ["job-1:characters:mei"],
      awaitingUserChoice: true,
    });

    const restored = readCompareSession("book-a");
    expect(restored.lockedCompare.key).toBe("mei");
    expect(restored.awaitingUserChoice).toBe(true);

    writeCompareSession("book-a", null);
    expect(readCompareSession("book-a")).toBeNull();
  });

  it("does not share compare state across books", () => {
    writeCompareSession("book-a", { jobId: "j1", awaitingUserChoice: true, lockedCompare: { key: "mei" } });
    writeCompareSession("book-b", { jobId: "j2", awaitingUserChoice: true, lockedCompare: { key: "elara" } });
    expect(readCompareSession("book-a").lockedCompare.key).toBe("mei");
    expect(readCompareSession("book-b").lockedCompare.key).toBe("elara");
  });
});
