#!/usr/bin/env node
/** Quick probe: two back-to-back pollinations-anon requests (same as sequential regen). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { composeImagePrompt, generateImageIsolated, generateImage } from "../worker/_shared/freemium-image.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

const env = { ...process.env, GEMINI_API_KEY: "", EXTRACT_SKIP_GEMINI: "true" };
const prompt = composeImagePrompt("test character portrait, blue hair mage", {
  subjectType: "character",
  style: "anime",
});

async function one(label, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    console.log(
      `${label} OK  provider=${r.provider} model=${r.model} bytes=${r.bytes.length} ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
    return true;
  } catch (e) {
    console.log(`${label} FAIL ${String(e.message || e).slice(0, 160)} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return false;
  }
}

console.log("=== Isolated pollinations-anon x2 ===");
await one("A", () => generateImageIsolated("pollinations-anon", prompt, { env, seed: 111, subjectType: "character" }));
await one("B", () => generateImageIsolated("pollinations-anon", prompt, { env, seed: 222, subjectType: "character" }));

console.log("\n=== Full freemium chain x2 (no pin) ===");
await one("A", () => generateImage(prompt, { env, seed: 333, subjectType: "character" }));
await one("B", () => generateImage(prompt, { env, seed: 444, subjectType: "character" }));

console.log("\n=== Full chain x2 with pollinations-anon pin (old behavior) ===");
await one("A", () => generateImage(prompt, { env, seed: 555, subjectType: "character", preferProvider: null }));
await one("B", () => generateImage(prompt, { env, seed: 666, subjectType: "character", preferProvider: "pollinations-anon" }));
