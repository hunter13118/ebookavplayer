import { describe, expect, it, beforeEach } from "vitest";
import { isJobStillRunning } from "./useCompareQueue.js";

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

describe("isJobStillRunning", () => {
  it("is running when we're still subscribed and no terminal status has arrived", () => {
    expect(isJobStillRunning("job1", null)).toBe(true);
    expect(isJobStillRunning("job1", { status: "processing" })).toBe(true);
  });

  it("is NOT running once the backend reports done or error, even with an empty local queue", () => {
    // This is the actual bug: resolving a fast item (cover) before a slower
    // one (a character) finishes must not be mistaken for "job over" —
    // otherwise the session tears down and later results get silently dropped.
    expect(isJobStillRunning("job1", { status: "done" })).toBe(false);
    expect(isJobStillRunning("job1", { status: "error" })).toBe(false);
  });

  it("is NOT running once we've unsubscribed (streamJobId cleared)", () => {
    expect(isJobStillRunning(null, { status: "processing" })).toBe(false);
  });
});
