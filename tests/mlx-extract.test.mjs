/**
 * MLX extract provider (docs/LOCAL_LLM_EXTRACTION.md "MLX: tested as an
 * alternative runtime" section) — additive, Apple-Silicon-only local backend,
 * gated behind MLX_BASE_URL exactly like OLLAMA_BASE_URL gates Ollama.
 * Mocks global.fetch so no real mlx_lm.server needs to be running.
 * Run: node tests/mlx-extract.test.mjs
 */
import assert from "node:assert";
import { freemiumExtract } from "../worker/_shared/freemium-extract.js";

const originalFetch = globalThis.fetch;

function mockFetch(handler) {
  globalThis.fetch = async (url, options) => handler(url, options);
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

// Hits mlx_lm.server's OpenAI-compatible endpoint with the default model,
// no real API key, and correctly parses the choices[0].message.content shape.
{
  let seen = null;
  mockFetch(async (url, options) => {
    seen = { url, options };
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"book_id":"b1","scenes":[]}' } }] }),
    };
  });
  const result = await freemiumExtract("chapter text", {
    systemPrompt: "sys prompt",
    preferProvider: "mlx-30b",
    env: { MLX_BASE_URL: "http://localhost:8081" },
  });
  restoreFetch();

  assert.equal(seen.url, "http://localhost:8081/v1/chat/completions");
  assert.equal(seen.options.method, "POST");
  assert.equal(seen.options.headers.authorization, "Bearer not-needed");
  const body = JSON.parse(seen.options.body);
  assert.equal(body.model, "mlx-community/Qwen3-30B-A3B-4bit");
  assert.equal(body.messages[0].content, "sys prompt");
  assert.equal(body.messages[1].content, "chapter text");
  assert.equal(result.provider, "mlx-30b");
  assert.deepEqual(result.data, { book_id: "b1", scenes: [] });
}

// MLX_MODEL_30B env override and a trailing slash on MLX_BASE_URL are respected.
{
  let seen = null;
  mockFetch(async (url, options) => {
    seen = { url, options };
    return { ok: true, json: async () => ({ choices: [{ message: { content: "{}" } }] }) };
  });
  await freemiumExtract("t", {
    systemPrompt: "s",
    preferProvider: "mlx-30b",
    env: { MLX_BASE_URL: "http://localhost:9999/", MLX_MODEL_30B: "custom-model" },
  });
  restoreFetch();

  assert.equal(seen.url, "http://localhost:9999/v1/chat/completions");
  assert.equal(JSON.parse(seen.options.body).model, "custom-model");
}

console.log("mlx-extract: all assertions passed");
