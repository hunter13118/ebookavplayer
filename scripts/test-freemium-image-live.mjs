#!/usr/bin/env node
/**
 * Live image provider smoke tests — run BEFORE deploy.
 *
 * Usage:
 *   node scripts/test-freemium-image-live.mjs --preflight          # Pollinations gate (default)
 *   node scripts/test-freemium-image-live.mjs --preflight --all    # + workers-ai if AI binding
 *   node scripts/test-freemium-image-live.mjs --provider pollinations-anon
 *   node scripts/test-freemium-image-live.mjs --remote-health
 *
 * Loads ebookavplayer/.env when present (does not override existing env).
 * Requires network. Exit 1 if required providers fail.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { composeImagePrompt, generateImage, generateImageIsolated } from "../worker/_shared/freemium-image.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.resolve(root, "smoke_out/freemium_probe");

const MIN_IMAGE_BYTES = 800;
const LIVE_TIMEOUT_MS = 120_000;

const args = new Set(process.argv.slice(2));
const providerFilter = (() => {
  const i = process.argv.indexOf("--provider");
  return i >= 0 ? process.argv[i + 1] : null;
})();

const PROMPT = composeImagePrompt("small blue owl on a book, test illustration", {
  subjectType: "character",
  style: "neutral",
});

function loadDotEnv() {
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === "") {
      process.env[key] = val;
    }
  }
}

function envFromProcess() {
  return {
    ...process.env,
    EXTRACT_SKIP_GEMINI: "true",
    AI: globalThis.__WRANGLER_AI__ || null,
  };
}

function validateImageResult(result, label) {
  if (!result?.bytes?.length) throw new Error(`${label}: empty response`);
  if (result.bytes.length < MIN_IMAGE_BYTES) {
    throw new Error(`${label}: image too small (${result.bytes.length} bytes)`);
  }
  const ct = result.contentType || "";
  if (!ct.startsWith("image/")) {
    throw new Error(`${label}: bad content-type ${ct || "(missing)"}`);
  }
}

function saveResult(result, tag) {
  fs.mkdirSync(outDir, { recursive: true });
  const ext = (result.contentType || "").includes("jpeg") ? "jpg" : "png";
  const outPath = path.join(outDir, `live_${tag}_${Date.now()}.${ext}`);
  fs.writeFileSync(outPath, result.bytes);
  return outPath;
}

/** Isolated provider run — disables faster tiers so we hit the target API. */
async function runProvider(providerId, baseEnv) {
  const attempts = [];
  const started = Date.now();

  const testEnv = {
    ...baseEnv,
    AI: providerId === "workers-ai" ? baseEnv.AI : null,
    GEMINI_API_KEY: providerId === "gemini_image" ? baseEnv.GEMINI_API_KEY : "",
    POLLINATIONS_TOKEN: providerId === "pollinations-anon" ? "" : baseEnv.POLLINATIONS_TOKEN,
  };

  const timer = setTimeout(() => {
    console.warn(`  … still waiting on ${providerId} (${Math.round((Date.now() - started) / 1000)}s)`);
  }, 15_000);

  try {
    const result = await generateImageIsolated(providerId, PROMPT, {
      env: testEnv,
      subjectType: "character",
      seed: 42,
      onAttempt: (p) => {
        attempts.push(p);
        console.log(`  → ${p}`);
      },
    });
    validateImageResult(result, providerId);
    const outPath = saveResult(result, providerId);
    const ms = Date.now() - started;
    return {
      provider: providerId,
      ok: true,
      model: result.model,
      bytes: result.bytes.length,
      ms,
      attempts,
      outPath,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function remoteHealth() {
  const base = process.env.VAE_LIVE_URL || "https://hunterthemilkman.com/projects/ebookavplayer/api";
  const res = await fetch(`${base}/health`);
  if (!res.ok) throw new Error(`health HTTP ${res.status}`);
  const h = await res.json();
  console.log("Remote health:", {
    gemini: h.gemini,
    job_events: h.job_events,
    freemium_keys: h.freemium_keys,
  });
  return h;
}

async function runPreflight(baseEnv) {
  const plan = ["pollinations-anon"];
  if (baseEnv.POLLINATIONS_TOKEN) {
    plan.push("pollinations-seed");
  } else {
    console.log("Note: POLLINATIONS_TOKEN not set — skipping pollinations-seed live test");
  }
  if (args.has("--all") && baseEnv.AI) {
    plan.push("workers-ai");
  }

  console.log("\nPreflight plan:", plan.join(" → "));
  const rows = [];

  for (const pid of plan) {
    console.log(`\n▶ Live test: ${pid}`);
    try {
      const row = await runProvider(pid, baseEnv);
      rows.push(row);
      console.log(`  ✓ ${pid} OK — ${row.bytes} bytes in ${(row.ms / 1000).toFixed(1)}s → ${row.outPath}`);
    } catch (e) {
      rows.push({ provider: pid, ok: false, error: String(e.message || e) });
      console.error(`  ✗ ${pid} FAIL — ${e.message || e}`);
    }
  }

  const failed = rows.filter((r) => !r.ok);
  console.log("\n── Summary ──");
  for (const r of rows) {
    if (r.ok) {
      console.log(`  ✓ ${r.provider.padEnd(20)} ${(r.ms / 1000).toFixed(1)}s  ${r.bytes} bytes`);
    } else {
      console.log(`  ✗ ${r.provider.padEnd(20)} ${r.error}`);
    }
  }

  if (failed.length) {
    throw new Error(`Preflight failed: ${failed.map((f) => f.provider).join(", ")}`);
  }
  console.log("\nPreflight passed — safe to deploy.");
  return rows;
}

async function main() {
  loadDotEnv();
  console.log("Live freemium image probe");
  console.log("Prompt length:", PROMPT.length);

  if (args.has("--remote-health")) {
    await remoteHealth();
    if (!args.has("--preflight") && !args.has("--local") && !providerFilter) return;
  }

  const baseEnv = envFromProcess();

  if (providerFilter) {
    if (!["workers-ai", "pollinations-anon", "pollinations-seed", "gemini_image"].includes(providerFilter)) {
      throw new Error(`Unknown --provider ${providerFilter}`);
    }
    const row = await runProvider(providerFilter, baseEnv);
    console.log("OK", row);
    return;
  }

  if (args.has("--local") && !args.has("--preflight")) {
    const row = await runProvider("workers-ai", baseEnv);
    console.log("OK", row);
    return;
  }

  // Default: preflight Pollinations before deploy
  await runPreflight(baseEnv);
}

main().catch((e) => {
  console.error("\nFAIL:", e.message || e);
  process.exit(1);
});
