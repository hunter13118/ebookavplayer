import { describe, expect, it, vi, beforeEach } from "vitest";
import { mediaUrl, mediaImageSrc, parseArtStyleFromMediaUrl, resolveCompareArtStyle } from "./media.js";
import * as packBridge from "./offline/packBridge.js";
import * as api from "./api.js";

describe("mediaUrl", () => {
  beforeEach(() => {
    vi.spyOn(packBridge, "getActiveOfflinePackId").mockReturnValue(null);
    vi.spyOn(api, "apiBase").mockReturnValue("");
  });

  it("strips cache-bust query from /media paths", () => {
    expect(mediaUrl("/media/book/semi-real/cover.png?v=1730000000"))
      .toBe("/media/book/semi-real/cover.png");
  });

  it("preserves cache-bust query for img src via mediaImageSrc", () => {
    vi.mocked(api.apiBase).mockReturnValue("/projects/ebookavplayer/api");
    expect(mediaImageSrc("/media/book/semi-real/insert_0.png?v=1730000000"))
      .toBe("/projects/ebookavplayer/api/media/book/semi-real/insert_0.png?v=1730000000");
  });

  it("prefixes apiBase for embedded portfolio media paths", () => {
    vi.mocked(api.apiBase).mockReturnValue("/projects/ebookavplayer/api");
    expect(mediaUrl("/media/book/anime/insert_0.png?v=1"))
      .toBe("/projects/ebookavplayer/api/media/book/anime/insert_0.png");
  });

  it("strips query from absolute URLs", () => {
    expect(mediaUrl("https://cdn.example/cover.png?token=abc"))
      .toBe("https://cdn.example/cover.png");
  });
});

describe("parseArtStyleFromMediaUrl", () => {
  it("reads style folder from media paths", () => {
    expect(parseArtStyleFromMediaUrl("/media/book/anime/insert_27.png?v=1")).toBe("anime");
    expect(parseArtStyleFromMediaUrl("/media/book/semi-real/cover.png")).toBe("semi-real");
    expect(parseArtStyleFromMediaUrl("gradient:abc")).toBeNull();
  });
});

describe("resolveCompareArtStyle", () => {
  it("prefers URL path over book defaults", () => {
    expect(resolveCompareArtStyle(
      { art_style: "semi-real" },
      { after_url: "/media/book/anime/insert_0.png" },
    )).toBe("anime");
  });

  it("falls back to book art_style when URL missing", () => {
    expect(resolveCompareArtStyle({ art_style: "anime" }, {})).toBe("anime");
  });
});
