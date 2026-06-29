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

console.log("freemium-image.test.mjs — all passed");
