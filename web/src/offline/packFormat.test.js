import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  blobKey, validateManifest, tierLabel, TIER_VISUAL, TIER_AUDIOBOOK,
} from "./packFormat.js";

describe("packFormat", () => {
  it("validates manifest", () => {
    const m = validateManifest({
      format: "vae-offline-pack",
      format_version: 1,
      book_id: "demo",
      pack_id: "demo@anime@visual",
    });
    expect(m.book_id).toBe("demo");
  });

  it("rejects wrong format", () => {
    expect(() => validateManifest({ format: "nope" })).toThrow(/not a vae-offline-pack/);
  });

  it("rejects unsupported version", () => {
    expect(() => validateManifest({
      format: "vae-offline-pack",
      format_version: 99,
      book_id: "x",
      pack_id: "x@s@v",
    })).toThrow(/unsupported pack format version/);
  });

  it("namespaces blob keys", () => {
    expect(blobKey("a@b@c", "vae/media/x.png")).toBe("a@b@c::vae/media/x.png");
  });

  it("labels tiers", () => {
    expect(tierLabel(TIER_VISUAL)).toMatch(/script \+ art/i);
    expect(tierLabel(TIER_AUDIOBOOK)).toMatch(/offline/i);
  });
});
