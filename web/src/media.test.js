import { describe, expect, it, vi, beforeEach } from "vitest";
import { mediaUrl, mediaImageSrc, spriteVisual, parseArtStyleFromMediaUrl, resolveCompareArtStyle } from "./media.js";
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

describe("spriteVisual", () => {
  beforeEach(() => {
    vi.spyOn(packBridge, "getActiveOfflinePackId").mockReturnValue(null);
    vi.spyOn(api, "apiBase").mockReturnValue("/projects/ebookavplayer/api");
  });

  // Regression: ArtCompareSheet.jsx's character-thumbnail path used to wrap
  // spriteVisual(url).url in mediaImageSrc() again — but spriteVisual
  // already resolves the URL through mediaUrl() (which itself prepends the
  // API base). Re-wrapping it double-prepended the base, producing paths
  // like "/projects/x/api/projects/x/api/media/..." that 503 — every
  // character-art comparison thumbnail in the compare modal broke, live,
  // confirmed via network logs, regardless of whether the underlying R2
  // asset actually existed. Fixed by using spriteVisual's url directly, the
  // same pattern Sprite.jsx and ReplaceArtSheet.jsx already use.
  it("returns an already-apiBase-prefixed url — callers must NOT run it through mediaImageSrc again", () => {
    const v = spriteVisual("/media/book/anime/char_lucy.png?v=1");
    expect(v.type).toBe("image");
    expect(v.url).toBe("/projects/ebookavplayer/api/media/book/anime/char_lucy.png");

    // Demonstrates exactly the bug that was fixed: re-wrapping double-prepends.
    const doubleWrapped = mediaImageSrc(v.url);
    expect(doubleWrapped).not.toBe(v.url);
    expect(doubleWrapped.match(/\/projects\/ebookavplayer\/api/g)?.length).toBe(2);
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
