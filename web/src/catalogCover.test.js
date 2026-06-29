import { describe, expect, it } from "vitest";
import {
  coverFromPlaybackJson,
  enrichCatalogMetaFromPlayback,
} from "../../worker/_shared/catalog-cover.js";

describe("coverFromPlaybackJson", () => {
  it("finds cover URL embedded in character sprites", () => {
    const url = coverFromPlaybackJson({
      characters: {
        mei: { sprite: "/media/book/anime/char_mei.png?v=1" },
      },
      cover: null,
      scenes: [{ background: "/media/book/anime/cover.png?v=2" }],
    });
    expect(url).toBe("/media/book/anime/cover.png");
  });
});

describe("enrichCatalogMetaFromPlayback", () => {  it("fills missing cover from playback JSON", async () => {
    const env = {
      VAE_PACKS: {
        get: async () => ({
          json: async () => ({
            title: "Test Book",
            cover: "/media/test-book/semi-real/cover.png?v=1",
          }),
        }),
      },
    };
    const meta = { book_id: "test-book", title: "Test Book", cover: null };
    const out = await enrichCatalogMetaFromPlayback(env, "test-book", meta);
    expect(out.cover).toBe("/media/test-book/semi-real/cover.png");
  });

  it("skips R2 read when cover already set", async () => {
    let reads = 0;
    const env = {
      VAE_PACKS: {
        get: async () => {
          reads += 1;
          return { json: async () => ({ cover: "/other.png" }) };
        },
      },
    };
    const meta = { book_id: "x", title: "X", cover: "/existing.png" };
    await enrichCatalogMetaFromPlayback(env, "x", meta);
    expect(reads).toBe(0);
  });

  it("fills missing cover from R2 when playback lacks cover field", async () => {
    const env = {
      VAE_PACKS: {
        get: async (key) => {
          if (key === "books/x.json") {
            return { json: async () => ({ title: "X", scenes: [] }) };
          }
          if (key === "media/x/anime/cover.png") return {};
          return null;
        },
      },
    };
    const meta = { book_id: "x", title: "X", art_style: "anime" };
    const out = await enrichCatalogMetaFromPlayback(env, "x", meta);
    expect(out.cover).toBe("/media/x/anime/cover.png");
  });
});
