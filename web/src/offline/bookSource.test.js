import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mergeCatalog,
  fetchBook,
  fetchLocalCatalog,
  fetchCatalogMerged,
  importOfflinePackFiles,
  coverFromPackRecord,
  needsOfflineCache,
  TIER_AUDIOBOOK,
  TIER_VISUAL,
} from "./bookSource.js";
import { buildTestPackZip, minimalBook } from "./testPackFixtures.js";
import { importPackZip, buildPackZipBytes } from "./packIo.js";
import { clearAllPacksForTests, getInstalledPack, savePackRecord } from "./packStore.js";

vi.mock("../api.js", () => ({
  apiUrl: (p) => p,
  fetchBook: vi.fn(async (id) => ({ book_id: id, title: "Remote", scenes: [] })),
  fetchCatalog: vi.fn(async () => [{ book_id: "remote", title: "Remote", progress: 1, status: "ready" }]),
}));

import { fetchBook as fetchBookRemote, fetchCatalog } from "../api.js";

describe("bookSource", () => {
  beforeEach(async () => {
    await clearAllPacksForTests();
    vi.clearAllMocks();
  });

  it("mergeCatalog preserves server cover when local pack has none", async () => {
    const book = minimalBook({ book_id: "merged", title: "Merged" });
    delete book.cover;
    await importPackZip(buildTestPackZip({ book }));
    const merged = await mergeCatalog([{
      book_id: "merged",
      title: "Merged",
      cover: "/media/merged/semi-real/cover.png?v=1",
      progress: 1,
      status: "ready",
    }]);
    const hit = merged.find((e) => e.book_id === "merged");
    expect(hit.offline_pack).toBe(true);
    expect(hit.cover).toBe("/media/merged/semi-real/cover.png?v=1");
  });

  it("coverFromPackRecord reads cover from media index", () => {
    const cover = coverFromPackRecord({
      book: {},
      media_index: { "/media/x/semi-real/cover.png": "vae/media/files/x/semi-real/cover.png" },
    });
    expect(cover).toBe("/media/x/semi-real/cover.png");
  });

  it("ensureBookCached skips when pack exists", async () => {
    await importPackZip(buildTestPackZip());
    const { ensureBookCached } = await import("./bookSource.js");
    const rec = await ensureBookCached("pack-test");
    expect(rec.book_id).toBe("pack-test");
  });

  it("mergeCatalog combines server and local entries, server title wins", async () => {
    const book = minimalBook({ book_id: "merged", title: "Merged Local" });
    await importPackZip(buildTestPackZip({ book }));
    fetchCatalog.mockResolvedValueOnce([
      { book_id: "merged", title: "Merged Remote", progress: 1, status: "ready" },
      { book_id: "remote-only", title: "Remote Only", progress: 1, status: "ready" },
    ]);
    const merged = await mergeCatalog(await fetchCatalog());
    const hit = merged.find((e) => e.book_id === "merged");
    expect(hit.offline_pack).toBe(true);
    expect(hit.server_available).toBe(true);
    // Server is authoritative for title — a locally-cached offline pack's
    // title is a snapshot from whenever it was last built, and must never
    // mask a server-side rename (see the regression test below for the
    // specific bug this covers).
    expect(hit.title).toBe("Merged Remote");
    expect(merged.some((e) => e.book_id === "remote-only")).toBe(true);
  });

  it("mergeCatalog: a server-side rename is never masked by a stale locally-cached title", async () => {
    // Regression test for a real bug found live: renaming a book via the UI
    // appeared to "not persist" because mergeCatalog let the offline pack's
    // stale cached title (from whenever it was last built) win over the
    // fresh server title on every catalog refresh — including the one that
    // fires immediately after the rename itself.
    const book = minimalBook({ book_id: "renamed-book", title: "Old Title Before Rename" });
    await importPackZip(buildTestPackZip({ book }));
    fetchCatalog.mockResolvedValueOnce([
      { book_id: "renamed-book", title: "New Title After Rename", progress: 1, status: "ready" },
    ]);
    const merged = await mergeCatalog(await fetchCatalog());
    const hit = merged.find((e) => e.book_id === "renamed-book");
    expect(hit.title).toBe("New Title After Rename");
  });

  it("fetchLocalCatalog lists installed packs", async () => {
    await importPackZip(buildTestPackZip());
    const local = await fetchLocalCatalog();
    expect(local).toHaveLength(1);
    expect(local[0].offline_pack).toBe(true);
  });

  it("fetchBook prefers server playback when local pack exists", async () => {
    await importPackZip(buildTestPackZip());
    fetchBookRemote.mockResolvedValueOnce({
      book_id: "pack-test",
      title: "Remote Fresh",
      scenes: [{ id: "s1", lines: [{ idx: 0, illustration_url: "/media/pack-test/anime/insert_0.png" }] }],
      inserts: { "0": "/media/pack-test/anime/insert_0.png" },
    });
    const book = await fetchBook("pack-test");
    expect(book.title).toBe("Remote Fresh");
    expect(book.inserts["0"]).toContain("insert_0.png");
    expect(book.offline_pack.tier).toBe("visual");
    expect(fetchBookRemote).toHaveBeenCalledWith("pack-test", {});
  });

  it("fetchBook keeps local pack content while remote is still processing (formal extraction not compiled yet)", async () => {
    // Regression: an m4b-first upload's local pack already has full transcript
    // lines the moment STT finishes, but the server-side /ingest-text job
    // (scenes/characters extraction) can take much longer. While it's still
    // running, GET /books/:id returns a near-empty stub ({error, book_id,
    // status:"processing"} — no scenes at all). Spreading that over the local
    // pack used to erase the transcript, permanently showing "Preparing this
    // book..." even though the device already had readable content.
    await importPackZip(buildTestPackZip());
    fetchBookRemote.mockResolvedValueOnce({
      book_id: "pack-test",
      status: "processing",
    });
    const book = await fetchBook("pack-test");
    expect(book.title).toBe("Pack Test Book");
    expect(book.scenes?.length).toBeGreaterThan(0);
    expect(book.status).toBe("ready");
  });

  it("fetchBook keeps an m4b-first local transcript when formal extraction has STALLED, not just while processing", async () => {
    // Regression: formal extraction doesn't only sit at status "processing"
    // while it works — it can also stall out (e.g. a missing/misconfigured
    // provider key) and settle at status "partial"/"error" with zero
    // chapters_ready, indefinitely. That used to fall through to "spread the
    // remote over local", replacing the m4b-first pack's real transcript
    // with the stalled extraction's near-empty scenes.
    await savePackRecord({
      pack_id: "m4b-pack-test::m4b-first",
      book_id: "m4b-pack-test",
      title: "M4B First Book",
      author: "",
      tier: TIER_VISUAL,
      style: null,
      audio_engine: null,
      manifest: { format: "vae-offline-pack", format_version: 1, book_id: "m4b-pack-test" },
      book: minimalBook({ book_id: "m4b-pack-test", title: "M4B First Book" }),
      voices: {},
      media_index: {},
      audio_manifest: [],
      blob_paths: [],
      pack_origin: "m4b-first",
      installed_at: 0,
      size_bytes: 0,
    });
    fetchBookRemote.mockResolvedValueOnce({
      book_id: "m4b-pack-test",
      status: "partial",
      stage: "extracting",
      chapters_ready: 0,
      total_chapters: 12,
      scenes: [],
    });
    const book = await fetchBook("m4b-pack-test");
    expect(book.title).toBe("M4B First Book");
    expect(book.scenes?.length).toBeGreaterThan(0);
  });

  it("fetchBook prefers the remote copy once an m4b-first book's formal extraction has produced real chapters", async () => {
    await savePackRecord({
      pack_id: "m4b-pack-ready::m4b-first",
      book_id: "m4b-pack-ready",
      title: "M4B First Book",
      author: "",
      tier: TIER_VISUAL,
      style: null,
      audio_engine: null,
      manifest: { format: "vae-offline-pack", format_version: 1, book_id: "m4b-pack-ready" },
      book: minimalBook({ book_id: "m4b-pack-ready", title: "M4B First Book" }),
      voices: {},
      media_index: {},
      audio_manifest: [],
      blob_paths: [],
      pack_origin: "m4b-first",
      installed_at: 0,
      size_bytes: 0,
    });
    fetchBookRemote.mockResolvedValueOnce({
      book_id: "m4b-pack-ready",
      title: "Formally Extracted",
      status: "partial",
      chapters_ready: 3,
      total_chapters: 12,
      scenes: [{ id: "s1", lines: [] }],
    });
    const book = await fetchBook("m4b-pack-ready");
    expect(book.title).toBe("Formally Extracted");
  });

  it("fetchBook preferLocal skips server", async () => {
    await importPackZip(buildTestPackZip());
    const book = await fetchBook("pack-test", { preferLocal: true });
    expect(book.title).toBe("Pack Test Book");
    expect(fetchBookRemote).not.toHaveBeenCalled();
  });

  it("fetchBook falls back to remote when no local pack", async () => {
    const book = await fetchBook("remote-id");
    expect(book.title).toBe("Remote");
    expect(fetchBookRemote).toHaveBeenCalledWith("remote-id", {});
  });

  it("fetchCatalogMerged falls back to local on server error", async () => {
    await importPackZip(buildTestPackZip());
    fetchCatalog.mockRejectedValueOnce(new Error("offline"));
    const list = await fetchCatalogMerged();
    expect(list.some((e) => e.book_id === "pack-test")).toBe(true);
  });

  async function mockPackBuildFetch(zipBytes, { jobId = "job-1" } = {}) {
    const buf = zipBytes instanceof ArrayBuffer
      ? zipBytes
      : zipBytes.buffer.slice(zipBytes.byteOffset, zipBytes.byteOffset + zipBytes.byteLength);
    global.fetch = vi.fn(async (url, opts) => {
      const u = String(url);
      if (u.includes("/pack/build") && opts?.method === "POST") {
        return { ok: true, json: async () => ({ job_id: jobId, status: "building" }) };
      }
      if (u.includes(`/pack/build/${jobId}/file`)) {
        return { ok: true, arrayBuffer: async () => buf };
      }
      if (u.includes(`/pack/build/${jobId}`)) {
        return { ok: true, json: async () => ({ job_id: jobId, status: "done", ready: true, progress: 1 }) };
      }
      throw new Error(`unexpected fetch ${u}`);
    });
  }

  it("downloadOfflinePack uses async build for audiobook tier", async () => {
    const zip = buildTestPackZip({ tier: TIER_AUDIOBOOK, withAudio: true });
    await mockPackBuildFetch(zip);
    const { downloadOfflinePack } = await import("./bookSource.js");
    const rec = await downloadOfflinePack("pack-test", { tier: TIER_AUDIOBOOK });
    expect(rec.tier).toBe(TIER_AUDIOBOOK);
  });

  it("downloadOfflinePack uses async build for visual tier", async () => {
    const book = {
      book_id: "pack-test",
      title: "Pack Test Book",
      author: "Tester",
      art_style: "semi-real",
      scenes: [{ id: "s1", lines: [{ idx: 0, text: "Hi" }] }],
    };
    const { bytes } = await import("../../../worker/_shared/pack-build-edge.js").then((m) =>
      m.buildPackOnEdge({ env: {}, book, tier: TIER_VISUAL, style: "semi-real" }),
    );
    await mockPackBuildFetch(bytes, { jobId: "job-visual" });
    const { downloadOfflinePack } = await import("./bookSource.js");
    const rec = await downloadOfflinePack("pack-test", { tier: TIER_VISUAL });
    expect(rec.tier).toBe(TIER_VISUAL);
    expect(rec.book_id).toBe("pack-test");
    const calls = global.fetch.mock.calls.map(([u]) => String(u));
    expect(calls.some((u) => u.includes("/pack/build") && !u.includes("/pack?"))).toBe(true);
    expect(calls.some((u) => u.includes("/pack?"))).toBe(false);
  });

  it("importOfflinePackFiles imports multiple packs and skips bad names", async () => {
    const zipA = buildTestPackZip({ book: minimalBook({ book_id: "batch-a", title: "Batch A" }) });
    const zipB = buildTestPackZip({ book: minimalBook({ book_id: "batch-b", title: "Batch B" }) });
    const fileA = { name: "a.vaepack", arrayBuffer: async () => zipA.buffer.slice(zipA.byteOffset, zipA.byteOffset + zipA.byteLength) };
    const fileB = { name: "b.vaepack", arrayBuffer: async () => zipB.buffer.slice(zipB.byteOffset, zipB.byteOffset + zipB.byteLength) };
    const fileSkip = { name: "notes.txt", arrayBuffer: async () => new ArrayBuffer(0) };
    const out = await importOfflinePackFiles([fileA, fileSkip, fileB]);
    expect(out.imported).toHaveLength(2);
    expect(out.skipped).toEqual(["notes.txt"]);
    expect((await fetchLocalCatalog()).some((e) => e.book_id === "batch-a")).toBe(true);
    expect((await fetchLocalCatalog()).some((e) => e.book_id === "batch-b")).toBe(true);
  });

  it("buildPackZipBytes round-trips installed pack", async () => {
    const rec = await importPackZip(buildTestPackZip({ withMedia: true }));
    const bytes = await buildPackZipBytes(rec);
    await clearAllPacksForTests();
    const again = await importPackZip(bytes);
    const stored = await getInstalledPack(again.pack_id);
    expect(stored.book.title).toBe("Pack Test Book");
    expect(stored.blob_paths.length).toBeGreaterThan(0);
  });

  describe("needsOfflineCache", () => {
    it("a still-processing book never needs a cache build, even with no offline_pack yet", () => {
      expect(needsOfflineCache({ status: "processing", offline_pack: null })).toBe(false);
    });

    it("a partial (paused, not actively running) book still gets cached normally", () => {
      expect(needsOfflineCache({ status: "partial", offline_pack: null })).toBe(true);
    });

    it("a ready book with no offline pack yet needs one", () => {
      expect(needsOfflineCache({ status: "ready", offline_pack: null })).toBe(true);
    });

    it("already has an offline pack -> no build needed regardless of status", () => {
      expect(needsOfflineCache({ status: "ready", offline_pack: { pack_id: "x" } })).toBe(false);
      expect(needsOfflineCache({ status: "processing", offline_pack: { pack_id: "x" } })).toBe(false);
    });

    it("not from a cloud connection (server_available: false) -> no build needed", () => {
      expect(needsOfflineCache({ status: "ready", offline_pack: null, server_available: false })).toBe(false);
    });

    it("e2eNoCache flag suppresses caching regardless of status", () => {
      expect(needsOfflineCache({ status: "ready", offline_pack: null }, { e2eNoCache: true })).toBe(false);
    });
  });
});
