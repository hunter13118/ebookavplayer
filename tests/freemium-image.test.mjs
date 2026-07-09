/**
 * Unit tests — image provider chain, prompt composition, generateImage routing.
 * Run: npm run test:freemium-image
 */
import assert from "node:assert";
import {
  artStyleKey,
  cloudflareAiRunUrl,
  composeImagePrompt,
  filterImageProviderChain,
  generateImage,
  generateImageIsolated,
} from "../worker/_shared/freemium-image.js";
import { computeImagingProgress, waitingOnProvider } from "../worker/_shared/imaging-progress-ui.js";

// composeImagePrompt
{
  const p = composeImagePrompt("silver-haired mage", { subjectType: "character", style: "anime" });
  assert.match(p, /transparent background/i);
  assert.match(p, /silver-haired mage/);
  assert.match(p, /anime/i);
}

{
  const p = composeImagePrompt("moonlit forest", { subjectType: "background", style: "realistic" });
  assert.match(p, /environment art/i);
  assert.doesNotMatch(p, /transparent background/i);
}

// artStyleKey — exact-match alias table (not loose substring matching)
{
  assert.equal(artStyleKey("anime"), "anime");
  assert.equal(artStyleKey("semi-real"), "realistic");
  assert.equal(artStyleKey("semi-realistic"), "realistic");
  assert.equal(artStyleKey("realistic"), "realistic");
  assert.equal(artStyleKey("real"), "realistic");
  assert.equal(artStyleKey("pixel"), "pixel");
  assert.equal(artStyleKey("pixel-art"), "pixel");
  assert.equal(artStyleKey("cartoon"), "comic");
  assert.equal(artStyleKey("comic"), "comic");
  assert.equal(artStyleKey("neutral"), "neutral");
  assert.equal(artStyleKey("ANIME"), "anime", "case-insensitive");
  assert.equal(artStyleKey("watercolor storybook illustration"), "custom");
  // Loose substring matching used to wrongly bucket "unrealistic" into "realistic" —
  // exact match must not do that.
  assert.equal(artStyleKey("unrealistic sketch"), "custom");
}

// composeImagePrompt — a custom (non-bucket) style string is used verbatim,
// not silently discarded into the generic "neutral" template.
{
  const p = composeImagePrompt("a lighthouse", { subjectType: "background", style: "watercolor storybook illustration" });
  assert.match(p, /Art style: watercolor storybook illustration\.$/);
  assert.doesNotMatch(p, /clean digital illustration/);
}

// composeImagePrompt — no style option at all still falls back to the neutral template.
{
  const p = composeImagePrompt("a lighthouse", { subjectType: "background" });
  assert.match(p, /clean digital illustration/);
}

// filterImageProviderChain — anon then seed when token is set; seed skipped without token
{
  const chain = ["pollinations-anon", "pollinations-seed", "huggingface", "cloudflare"];
  assert.deepEqual(
    filterImageProviderChain(chain, { pollinationsToken: "sk_test" }),
    ["pollinations-anon", "pollinations-seed", "huggingface", "cloudflare"],
  );
  assert.deepEqual(
    filterImageProviderChain(chain, {}),
    ["pollinations-anon", "huggingface", "cloudflare"],
  );
}

// progress bar — provider wait must not show 100% from step ratio
{
  assert.equal(
    computeImagingProgress(
      { status: "processing", progress: 0.99, step_index: 1, step_total: 1, detail: "Generating character · mei via pollinations-anon" },
      { lastProgress: 0.5 },
    ),
    0.99,
  );
  assert.ok(
    computeImagingProgress(
      { status: "processing", progress: 0.4, step_index: 1, step_total: 1, detail: "Generating via pollinations-seed" },
      { lastProgress: 0.3 },
    ) < 0.99,
  );
  assert.equal(waitingOnProvider("Generating character · mei via pollinations-anon"), true);
}

// cloudflareAiRunUrl — literal @cf/ path (encodeURIComponent breaks routing)
{
  const url = cloudflareAiRunUrl("acct123");
  assert.match(url, /\/ai\/run\/@cf\/black-forest-labs\/flux-1-schnell$/);
  assert.doesNotMatch(url, /%40|%2F/);
}

// generateImage — cloudflare REST uses unencoded model path
{
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9, ...Array(900).fill(0)]);
  const b64 = Buffer.from(jpeg).toString("base64");
  let calledUrl = "";
  const env = {
    EXTRACT_SKIP_GEMINI: "true",
    CLOUDFLARE_ACCOUNT_ID: "acct123",
    CLOUDFLARE_API_TOKEN: "tok",
    __fetch: async (url) => {
      calledUrl = String(url);
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => ({ result: { image: b64 } }),
      };
    },
  };
  const result = await generateImageIsolated("cloudflare", "portrait test", {
    env,
    subjectType: "background",
  });
  assert.equal(result.provider, "cloudflare");
  assert.match(calledUrl, /\/ai\/run\/@cf\/black-forest-labs\/flux-1-schnell$/);
  assert.doesNotMatch(calledUrl, /%40|%2F/);
}

// generateImage — Workers AI binding is last in freemium chain (after HTTP providers fail)
{
  const attempts = [];
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const env = {
    EXTRACT_SKIP_GEMINI: "true",
    AI: {
      run: async () => jpeg,
    },
    __fetch: async (url) => {
      if (String(url).includes("pollinations")) {
        throw new Error("pollinations unavailable");
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  };
  const result = await generateImage("portrait test", {
    env,
    subjectType: "background",
    onAttempt: (p) => attempts.push(p),
  });
  assert.equal(result.provider, "workers-ai");
  assert.deepEqual(attempts, ["pollinations-anon", "workers-ai"]);
}

// generateImage — pollinations wins before Workers AI when both are available
{
  const attempts = [];
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
  const env = {
    EXTRACT_SKIP_GEMINI: "true",
    AI: {
      run: async () => {
        throw new Error("Workers AI should not run when pollinations succeeds");
      },
    },
    __fetch: async (url) => {
      if (String(url).includes("pollinations")) {
        return {
          ok: true,
          status: 200,
          headers: { get: (h) => (h === "content-type" ? "image/png" : null) },
          arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  };
  const result = await generateImage("portrait test", {
    env,
    subjectType: "background",
    onAttempt: (p) => attempts.push(p),
  });
  assert.equal(result.provider, "pollinations-anon");
  assert.deepEqual(attempts, ["pollinations-anon"]);
}

// generateImage — falls through pollinations when no AI binding
{
  const attempts = [];
  let fetchCalls = 0;
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
  const env = {
    EXTRACT_SKIP_GEMINI: "true",
    POLLINATIONS_TOKEN: "sk_test",
    __fetch: async (url) => {
      fetchCalls += 1;
      if (String(url).includes("pollinations")) {
        return {
          ok: true,
          status: 200,
          headers: { get: (h) => (h === "content-type" ? "image/png" : null) },
          arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  };
  const result = await generateImage("portrait test", {
    env,
    subjectType: "background",
    onAttempt: (p) => attempts.push(p),
  });
  assert.equal(result.provider, "pollinations-anon");
  assert.deepEqual(attempts, ["pollinations-anon"], "anon runs before seed in chain");
  assert.ok(fetchCalls >= 1);
}

// generateImage — an explicit preferProvider for a *top-level* tier (local_sd,
// not a freemium_image sub-chain member) jumps that tier to the front, even
// though the default tier order puts it last (gemini_image → freemium_image →
// local_sd). Regression guard for the gap where preferProvider only reordered
// within runFreemiumChain and silently had no effect on gemini_image/local_sd.
{
  const attempts = [];
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
  const env = {
    EXTRACT_SKIP_GEMINI: "true",
    LOCAL_IMAGE_URL: "http://127.0.0.1:7860",
    __fetch: async (url) => {
      if (String(url).includes("7860")) {
        return {
          ok: true,
          status: 200,
          headers: { get: (h) => (h === "content-type" ? "image/png" : null) },
          arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
        };
      }
      throw new Error(`unexpected fetch ${url} — local_sd should have been tried first`);
    },
  };
  const result = await generateImage("portrait test", {
    env,
    subjectType: "background",
    preferProvider: "local_sd",
    onAttempt: (p) => attempts.push(p),
  });
  assert.equal(result.provider, "local_sd");
  assert.deepEqual(attempts, ["local_sd"], "preferProvider jumps local_sd ahead of gemini_image/freemium_image");
}

// generateImage — preferring a freemium_image sub-chain member (e.g. huggingface)
// still reorders *within* that tier as before (no regression from the new
// top-level reordering).
{
  const attempts = [];
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
  const env = {
    EXTRACT_SKIP_GEMINI: "true",
    HF_TOKEN: "hf_test",
    __fetch: async (url) => {
      if (String(url).includes("huggingface") || String(url).includes("hf.space")) {
        return {
          ok: true,
          status: 200,
          headers: { get: (h) => (h === "content-type" ? "image/png" : null) },
          arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  };
  const result = await generateImage("portrait test", {
    env,
    subjectType: "background",
    preferProvider: "huggingface",
    onAttempt: (p) => attempts.push(p),
  }).catch((e) => ({ error: e }));
  // Either it succeeds via huggingface, or fails for an unrelated reason (network
  // shape mismatch) — what we're actually asserting is that huggingface was the
  // *first* attempt, i.e. freemium_image was correctly jumped to the front.
  assert.equal(attempts[0], "huggingface", "preferring a freemium member still tries it first");
  void result;
}

// generateImage — reference-backed generation (referenceImages set) used to
// be a completely separate code path that only ever tried gemini_image then
// pollinations-i2i, ignoring the pipeline config entirely and throwing hard
// if neither worked — even when local_sd (which can't use references, but
// can still generate) was configured and available. Regression guard:
// confirmed against a real local-only setup (no GEMINI_API_KEY, no
// PUBLIC_MEDIA_ORIGIN) that every reference-backed generation failed 100%
// of the time despite local_sd being fully configured and reachable.
{
  const attempts = [];
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
  const refBytes = new Uint8Array([1, 2, 3, 4]).buffer;
  const env = {
    EXTRACT_SKIP_GEMINI: "true",
    LOCAL_IMAGE_URL: "http://127.0.0.1:7860",
    __fetch: async (url) => {
      if (String(url).includes("7860")) {
        return {
          ok: true,
          status: 200,
          headers: { get: (h) => (h === "content-type" ? "image/png" : null) },
          arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
        };
      }
      throw new Error(`unexpected fetch ${url} — should have fallen through to local_sd`);
    },
  };
  const result = await generateImage("portrait test", {
    env,
    subjectType: "character",
    referenceImages: [refBytes],
    onAttempt: (p) => attempts.push(p),
  });
  assert.equal(result.provider, "local_sd", "falls through to local_sd, unreferenced, instead of hard-failing");
}

// generateImage — reference-backed generation still respects a saved
// pipeline order that puts local_sd *first*, ahead of gemini_image. Before
// the fix, local_sd was structurally unreachable on this path no matter
// what the pipeline config said — this proves it's now actually consulted.
{
  const attempts = [];
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
  const refBytes = new Uint8Array([1, 2, 3, 4]).buffer;
  const env = {
    EXTRACT_SKIP_GEMINI: "true",
    LOCAL_IMAGE_URL: "http://127.0.0.1:7860",
    GEMINI_API_KEY: "fake_key_should_never_be_used",
    __fetch: async (url) => {
      if (String(url).includes("7860")) {
        return {
          ok: true,
          status: 200,
          headers: { get: (h) => (h === "content-type" ? "image/png" : null) },
          arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
        };
      }
      throw new Error(`unexpected fetch ${url} — local_sd is pinned first, gemini_image should not be tried`);
    },
  };
  const result = await generateImage("portrait test", {
    env,
    subjectType: "character",
    preferProvider: "local_sd",
    referenceImages: [refBytes],
    onAttempt: (p) => attempts.push(p),
  });
  assert.equal(result.provider, "local_sd");
  assert.deepEqual(attempts, ["local_sd"], "pinning local_sd first is respected even for reference-backed generation");
}

// generateImage — local_sd now actually sends reference_image_b64/model,
// previously it only ever sent {prompt} even when a reference and/or a
// configured LOCAL_IMAGE_MODEL were available. Confirms the request body
// local-image-server/server.py's /generate actually expects for IP-Adapter
// conditioning (see docs/LOCAL_IMAGE_GEN.md).
{
  let sentBody = null;
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
  const refBytes = new Uint8Array([1, 2, 3, 4]).buffer;
  const env = {
    EXTRACT_SKIP_GEMINI: "true",
    LOCAL_IMAGE_URL: "http://127.0.0.1:7860",
    LOCAL_IMAGE_MODEL: "animagine-xl",
    __fetch: async (url, opts) => {
      sentBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        headers: { get: (h) => (h === "content-type" ? "image/png" : null) },
        arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
      };
    },
  };
  await generateImage("portrait test", {
    env,
    subjectType: "character",
    preferProvider: "local_sd",
    referenceImages: [refBytes],
  });
  assert.equal(sentBody.model, "animagine-xl", "LOCAL_IMAGE_MODEL sent explicitly per-request");
  assert.equal(typeof sentBody.reference_image_b64, "string", "reference image sent as base64");
  assert.ok(sentBody.reference_image_b64.length > 0);
}

// ...and when there's no reference or configured model, the request body
// stays minimal (no regression for the plain-background-generation case).
{
  let sentBody = null;
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
  const env = {
    EXTRACT_SKIP_GEMINI: "true",
    LOCAL_IMAGE_URL: "http://127.0.0.1:7860",
    __fetch: async (url, opts) => {
      sentBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        headers: { get: (h) => (h === "content-type" ? "image/png" : null) },
        arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
      };
    },
  };
  await generateImage("background test", { env, subjectType: "background", preferProvider: "local_sd" });
  assert.deepEqual(Object.keys(sentBody), ["prompt"]);
}

console.log("freemium-image.test.mjs — all passed");
