import assert from "node:assert";
import { unzipSync } from "fflate";
import { buildPackManifest, validatePackManifest } from "../worker/_shared/pack-manifest.js";
import { buildPackOnEdge, TIER_VISUAL } from "../worker/_shared/pack-build-edge.js";

const MANIFEST_NAME = "vae/manifest.json";

{
  const m = buildPackManifest({
    bookId: "demo-book",
    title: "Demo",
    author: "Author",
    tier: "visual",
    style: "semi-real",
    lineCount: 3,
    mediaCount: 2,
  });
  assert.equal(m.format, "vae-offline-pack");
  assert.equal(m.format_version, 1);
  assert.equal(m.pack_id, "demo-book@semi-real@visual");
  assert.equal(m.book_id, "demo-book");
  assert.equal(m.title, "Demo");
  validatePackManifest(m);
}

{
  const book = {
    book_id: "edge-pack-test",
    title: "Edge Pack",
    author: "QA",
    art_style: "semi-real",
    scenes: [{
      id: "s1",
      lines: [{ idx: 0, text: "Hello.", character_id: "narrator" }],
    }],
  };
  const { bytes, manifest } = await buildPackOnEdge({
    env: {},
    book,
    tier: TIER_VISUAL,
    style: "semi-real",
  });
  validatePackManifest(manifest);

  const entries = unzipSync(bytes);
  assert.ok(entries[MANIFEST_NAME], "zip must contain manifest");
  const fromZip = JSON.parse(new TextDecoder().decode(entries[MANIFEST_NAME]));
  validatePackManifest(fromZip);
  assert.equal(fromZip.pack_id, "edge-pack-test@semi-real@visual");
  assert.equal(fromZip.format_version, 1);
  assert.notEqual(fromZip.version, 1, "legacy wrong key must not be used");
}

{
  const book = {
    book_id: "cover-infer",
    title: "Cover Infer",
    art_style: "semi-real",
    scenes: [{
      id: "s1",
      background: "/media/cover-infer/semi-real/cover.png?v=99",
      lines: [{ idx: 0, text: "Hi" }],
    }],
  };
  const { bytes } = await buildPackOnEdge({ env: {}, book, tier: TIER_VISUAL, style: "semi-real" });
  const entries = unzipSync(bytes);
  const bookJson = JSON.parse(new TextDecoder().decode(entries["vae/book.json"]));
  assert.match(bookJson.cover, /\/cover\.png$/);
  assert.ok(!bookJson.cover.includes("?"), "cover URL should not include query string");
}

{
  const book = { book_id: "resume-edge", title: "Resume", scenes: [{ id: "s1", lines: [{ idx: 0, text: "Hi" }] }] };
  const env = {
    VAE_JOBS: {
      get: async (key) => (key === "progress:resume-edge"
        ? JSON.stringify({ line: 5, sceneId: "s1", chapter: 0, total: 20 })
        : null),
    },
  };
  const { bytes } = await buildPackOnEdge({ env, book, tier: TIER_VISUAL, style: "semi-real" });
  const bookJson = JSON.parse(new TextDecoder().decode(unzipSync(bytes)["vae/book.json"]));
  assert.equal(bookJson.resume.line, 5);
}

console.log("pack-build-edge.test.mjs — all passed");
