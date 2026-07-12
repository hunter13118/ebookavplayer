/**
 * Worker sprite background purge tests.
 */
import assert from "node:assert";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import {
  detectEdgeBackgroundColor,
  imageNeedsBackgroundPurge,
  maybePurgeSpriteBackground,
  purgeSpriteBackground,
} from "../worker/_shared/sprite-bg-purge.js";
import { ensureCharacterSpriteTransparency } from "../worker/_shared/freemium-image.js";

function rgbaImage(w, h, fillRgb, alpha = 255) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    data[o] = fillRgb[0];
    data[o + 1] = fillRgb[1];
    data[o + 2] = fillRgb[2];
    data[o + 3] = alpha;
  }
  return { data, width: w, height: h };
}

function putRgb(img, x, y, rgb) {
  const i = (y * img.width + x) * 4;
  img.data[i] = rgb[0];
  img.data[i + 1] = rgb[1];
  img.data[i + 2] = rgb[2];
  img.data[i + 3] = 255;
}

function pngBytes(img) {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data);
  return new Uint8Array(PNG.sync.write(png));
}

function jpegBytes(img) {
  return jpeg.encode(img, 95).data;
}

function readRgba(bytes) {
  const png = PNG.sync.read(Buffer.from(bytes));
  return { data: png.data, width: png.width, height: png.height };
}

// detect edge gray
{
  const img = rgbaImage(40, 40, [200, 200, 200]);
  for (let x = 15; x < 25; x++) {
    for (let y = 15; y < 25; y++) putRgb(img, x, y, [50, 50, 150]);
  }
  const { bg, dominance } = detectEdgeBackgroundColor(img.data, img.width, img.height);
  assert.deepEqual(bg, [192, 192, 192]);
  assert.ok(dominance > 0.9);
}

// auto gray purge
{
  const img = rgbaImage(32, 32, [180, 180, 180]);
  for (let x = 10; x < 22; x++) {
    for (let y = 10; y < 22; y++) putRgb(img, x, y, [200, 40, 40]);
  }
  const { bytes, meta } = purgeSpriteBackground(jpegBytes(img), {
    tolerance: 20,
    softness: 0,
    contentType: "image/jpeg",
  });
  const out = readRgba(bytes);
  assert.ok(out.data[(16 * out.width + 16) * 4 + 3] > 200);
  assert.equal(out.data[3], 0);
  assert.deepEqual(meta.background_rgb, [176, 176, 176]);
  assert.equal(meta.auto_detected, true);
}

// skip transparent png
{
  const img = rgbaImage(32, 32, [255, 255, 255], 0);
  for (let x = 8; x < 24; x++) {
    for (let y = 8; y < 24; y++) putRgb(img, x, y, [200, 40, 40]);
  }
  assert.equal(maybePurgeSpriteBackground(pngBytes(img), "image/png"), null);
}

// feather edges
{
  const img = rgbaImage(20, 20, [255, 255, 255]);
  putRgb(img, 10, 10, [100, 100, 100]);
  putRgb(img, 5, 5, [238, 238, 238]);
  const { bytes, meta } = purgeSpriteBackground(pngBytes(img), {
    bgColor: [255, 255, 255],
    tolerance: 10,
    softness: 10,
    minEdgeDominance: 0,
    contentType: "image/png",
  });
  const out = readRgba(bytes);
  assert.equal(out.data[(10 * out.width + 10) * 4 + 3], 255);
  assert.equal(out.data[3], 0);
  const featherA = out.data[(5 * out.width + 5) * 4 + 3];
  assert.ok(featherA > 0 && featherA < 255);
  assert.ok(meta.pixels_feathered >= 1);
}

// preserve enclosed island
{
  const img = rgbaImage(32, 32, [255, 255, 255]);
  for (let x = 8; x < 24; x++) {
    for (let y = 8; y < 24; y++) putRgb(img, x, y, [200, 40, 40]);
  }
  putRgb(img, 16, 16, [255, 255, 255]);
  const { bytes, meta } = purgeSpriteBackground(pngBytes(img), {
    bgColor: [255, 255, 255],
    tolerance: 10,
    softness: 0,
    minEdgeDominance: 0,
    contentType: "image/png",
  });
  const out = readRgba(bytes);
  assert.equal(out.data[3], 0);
  assert.equal(out.data[(16 * out.width + 16) * 4 + 3], 255);
  assert.ok(meta.pixels_preserved_islands >= 1);
}

assert.equal(imageNeedsBackgroundPurge(jpegBytes(rgbaImage(8, 8, [255, 255, 255])), "image/jpeg"), true);

// ensureCharacterSpriteTransparency — regression for a no-op "forced" retry.
// It used to retry purgeSpriteBackground with the EXACT SAME options as the
// first pass, so a border with no single dominant color (edge_dominance
// below minEdgeDominance — e.g. a noisy/textured backdrop, confirmed live on
// local_sd/animagine-xl) failed identically on both passes and silently gave
// up, leaving the sprite un-purged. Build a border that jitters around gray
// 128 (spread across several quantize(16) buckets, so no bucket reaches the
// strict 0.35 dominance the first pass requires) but stays within the
// loosened retry's wider tolerance (40) — the fix's retry should still
// succeed where the identical-options retry would not have.
{
  const w = 40, h = 40;
  const img = rgbaImage(w, h, [128, 128, 128]);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const onBorder = x < 2 || y < 2 || x >= w - 2 || y >= h - 2;
      if (!onBorder) continue;
      const jitter = ((x * 7 + y * 13) % 61) - 30; // spread ±30 around 128
      const v = Math.max(0, Math.min(255, 128 + jitter));
      putRgb(img, x, y, [v, v, v]);
    }
  }
  for (let x = 15; x < 25; x++) {
    for (let y = 15; y < 25; y++) putRgb(img, x, y, [220, 30, 30]); // clearly distinct "subject"
  }

  const { dominance } = detectEdgeBackgroundColor(img.data, img.width, img.height, { border: 2, quantizeStep: 16 });
  assert.ok(dominance < 0.35, `test setup: expected noisy border below strict dominance, got ${dominance}`);

  const result = { bytes: pngBytes(img), contentType: "image/png", provider: "local_sd" };
  const out = ensureCharacterSpriteTransparency(result, {});
  assert.equal(out.background_purged, true, "loosened retry succeeds where an identical-options retry would not");
  const outRgba = readRgba(out.bytes);
  // border pixel now transparent
  assert.equal(outRgba.data[(1 * outRgba.width + 1) * 4 + 3], 0);
  // subject block still opaque
  assert.equal(outRgba.data[(20 * outRgba.width + 20) * 4 + 3], 255);
}

console.log("sprite-bg-purge.test.mjs: all assertions passed");
