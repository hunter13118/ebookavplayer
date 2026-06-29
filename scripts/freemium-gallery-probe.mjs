#!/usr/bin/env node
/**
 * Hit every freemium image provider with the SAME prompt; write results.md + gallery.html.
 *
 *   npm run test:freemium-gallery
 *   node scripts/freemium-gallery-probe.mjs --prompt "dark magician girl eating ramen"
 *
 * Output: smoke_out/freemium_probe/runs/<timestamp>/
 *   results.json  results.md  gallery.html  images/*.png|jpg
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { composeImagePrompt, generateImage, generateImageIsolated, huggingfaceAvailable } from "../worker/_shared/freemium-image.js";
import { geminiImageAvailable } from "../worker/_shared/gemini-image.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const probeRoot = path.resolve(root, "smoke_out/freemium_probe");

const MIN_BYTES = 800;

const ISOLATED_PROVIDERS = [
  "gemini_image",
  "workers-ai",
  "cloudflare",
  "pollinations-anon",
  "pollinations-seed",
];

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
    if (process.env[key] == null || process.env[key] === "") process.env[key] = val;
  }
}

function parseArgs() {
  const out = { subject: "character", style: "neutral" };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--prompt" && argv[i + 1]) {
      out.description = argv[++i];
    } else if (argv[i] === "--subject" && argv[i + 1]) {
      out.subject = argv[++i];
    } else if (argv[i] === "--style" && argv[i + 1]) {
      out.style = argv[++i];
    }
  }
  return out;
}

function extForContentType(ct) {
  if (!ct) return ".bin";
  if (ct.includes("jpeg") || ct.includes("jpg")) return ".jpg";
  if (ct.includes("png")) return ".png";
  if (ct.includes("webp")) return ".webp";
  return ".bin";
}

function envForProvider(providerId, baseEnv) {
  return {
    ...baseEnv,
    EXTRACT_SKIP_GEMINI: "true",
    AI: providerId === "workers-ai" ? baseEnv.AI : null,
    GEMINI_API_KEY: providerId === "gemini_image" ? baseEnv.GEMINI_API_KEY : "",
    POLLINATIONS_TOKEN: providerId === "pollinations-anon" ? "" : baseEnv.POLLINATIONS_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: providerId === "cloudflare" ? baseEnv.CLOUDFLARE_ACCOUNT_ID : baseEnv.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: providerId === "cloudflare" ? baseEnv.CLOUDFLARE_API_TOKEN : baseEnv.CLOUDFLARE_API_TOKEN,
    HF_TOKEN: baseEnv.HF_TOKEN,
    FAL_KEY: baseEnv.FAL_KEY || baseEnv.FAL_AI_API_KEY,
  };
}

function providerSkipReason(providerId, baseEnv) {
  if (providerId === "workers-ai" && !baseEnv.AI) {
    return "edge-only: Workers AI needs env.AI binding (deployed portfolio worker or globalThis.__WRANGLER_AI__ in wrangler dev)";
  }
  if (providerId === "gemini_image" && !geminiImageAvailable(baseEnv)) {
    return "GEMINI_API_KEY not set";
  }
  if (providerId === "cloudflare" && (!baseEnv.CLOUDFLARE_ACCOUNT_ID || !baseEnv.CLOUDFLARE_API_TOKEN)) {
    return "CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not set";
  }
  if (providerId === "pollinations-seed" && !baseEnv.POLLINATIONS_TOKEN) {
    return "POLLINATIONS_TOKEN not set";
  }
  if (providerId === "huggingface" && !huggingfaceAvailable(baseEnv)) {
    return "HF_TOKEN or FAL_KEY not set";
  }
  return null;
}

async function runOne(providerId, prompt, baseEnv) {
  const skip = providerSkipReason(providerId, baseEnv);
  if (skip) {
    return { provider: providerId, ok: false, skipped: true, error: skip, ms: 0 };
  }

  const started = Date.now();
  const attempts = [];
  try {
    const result = await generateImageIsolated(providerId, prompt, {
      env: envForProvider(providerId, baseEnv),
      subjectType: "character",
      seed: 42,
      onAttempt: (p) => attempts.push(p),
    });
    if (!result?.bytes?.length || result.bytes.length < MIN_BYTES) {
      throw new Error(`bad image (${result?.bytes?.length || 0} bytes)`);
    }
    return {
      provider: providerId,
      ok: true,
      model: result.model,
      winner: result.provider,
      bytes: result.bytes.length,
      contentType: result.contentType,
      imageBytes: result.bytes,
      attempts,
      ms: Date.now() - started,
    };
  } catch (e) {
    return {
      provider: providerId,
      ok: false,
      error: String(e.message || e).slice(0, 300),
      attempts,
      ms: Date.now() - started,
    };
  }
}

async function runCascade(prompt, baseEnv, { label, disableAi, disableGemini }) {
  const started = Date.now();
  const attempts = [];
  try {
    const result = await generateImage(prompt, {
      env: {
        ...baseEnv,
        AI: disableAi ? null : baseEnv.AI,
        GEMINI_API_KEY: disableGemini ? "" : baseEnv.GEMINI_API_KEY,
      },
      subjectType: "character",
      seed: 42,
      onAttempt: (p) => attempts.push(p),
    });
    return {
      provider: label,
      ok: true,
      winner: result.provider,
      model: result.model,
      bytes: result.bytes.length,
      contentType: result.contentType,
      imageBytes: result.bytes,
      attempts,
      ms: Date.now() - started,
    };
  } catch (e) {
    return {
      provider: label,
      ok: false,
      error: String(e.message || e).slice(0, 300),
      attempts,
      ms: Date.now() - started,
    };
  }
}

function writeGallery(runDir, rows, meta) {
  const imagesDir = path.join(runDir, "images");
  fs.mkdirSync(imagesDir, { recursive: true });

  for (const row of rows) {
    if (!row.ok || !row.imageBytes) continue;
    const ext = extForContentType(row.contentType);
    const safe = row.provider.replace(/[^a-z0-9_-]+/gi, "_");
    row.imageFile = `images/${safe}${ext}`;
    fs.writeFileSync(path.join(runDir, row.imageFile), row.imageBytes);
    delete row.imageBytes;
  }

  fs.writeFileSync(path.join(runDir, "results.json"), JSON.stringify({ meta, rows }, null, 2));

  const md = [];
  md.push("# Freemium image gallery probe");
  md.push("");
  md.push(`**When:** ${meta.when}`);
  md.push(`**Prompt:** ${meta.promptDescription}`);
  md.push("");
  md.push(`> ${meta.promptFull.slice(0, 500)}${meta.promptFull.length > 500 ? "…" : ""}`);
  md.push("");
  md.push("Open **[gallery.html](./gallery.html)** to compare all images side-by-side.");
  md.push("");
  md.push("| Provider | Status | Time | Bytes | Model | Notes |");
  md.push("|----------|--------|------|-------|-------|-------|");
  for (const r of rows) {
    const status = r.skipped ? "skip" : r.ok ? "ok" : "fail";
    const notes = r.skipped || !r.ok ? (r.error || "") : (r.attempts?.join(" → ") || "");
    md.push(`| ${r.provider} | ${status} | ${(r.ms / 1000).toFixed(1)}s | ${r.bytes || "—"} | ${r.model || r.winner || "—"} | ${notes.replace(/\|/g, "\\|")} |`);
  }
  md.push("");
  for (const r of rows) {
    if (!r.ok || !r.imageFile) continue;
    md.push(`## ${r.provider}`);
    md.push("");
    md.push(`![${r.provider}](${r.imageFile})`);
    md.push("");
    md.push(`- **Model:** ${r.model || r.winner || "—"}`);
    md.push(`- **Time:** ${(r.ms / 1000).toFixed(1)}s · **Size:** ${r.bytes} bytes`);
    md.push("");
  }
  fs.writeFileSync(path.join(runDir, "results.md"), md.join("\n"));

  const cards = rows.map((r) => {
    if (r.ok && r.imageFile) {
      return `
      <article class="card ok">
        <header><strong>${esc(r.provider)}</strong><span class="badge ok">ok · ${(r.ms / 1000).toFixed(1)}s</span></header>
        <div class="thumb"><img src="${esc(r.imageFile)}" alt="${esc(r.provider)}" loading="lazy" /></div>
        <p class="meta">${esc(r.model || r.winner || "")} · ${r.bytes} bytes</p>
        <p class="chain">${esc((r.attempts || []).join(" → "))}</p>
      </article>`;
    }
    const cls = r.skipped ? "skip" : "fail";
    return `
      <article class="card ${cls}">
        <header><strong>${esc(r.provider)}</strong><span class="badge ${cls}">${cls}</span></header>
        <div class="thumb empty">${r.skipped ? "skipped" : "failed"}</div>
        <p class="meta err">${esc(r.error || "unknown error")}</p>
      </article>`;
  }).join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Freemium gallery · ${esc(meta.when)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f1117; color: #e8eaef; padding: 24px; }
    h1 { font-size: 1.25rem; margin-bottom: 8px; }
    .sub { color: #9aa3b2; font-size: 0.85rem; margin-bottom: 20px; max-width: 900px; line-height: 1.45; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
    .card { background: #1a1d29; border: 1px solid #2a3040; border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; }
    .card header { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; font-size: 0.85rem; border-bottom: 1px solid #2a3040; }
    .badge { font-size: 0.7rem; padding: 2px 8px; border-radius: 999px; text-transform: uppercase; letter-spacing: 0.04em; }
    .badge.ok { background: #1e3a2f; color: #7dffb2; }
    .badge.fail { background: #3a1e1e; color: #ff8a8a; }
    .badge.skip { background: #2a2a1e; color: #d4c86a; }
    .thumb { aspect-ratio: 3/4; background: repeating-conic-gradient(#2a3040 0% 25%, #222633 0% 50%) 50% / 16px 16px; display: flex; align-items: center; justify-content: center; }
    .thumb img { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
    .thumb.empty { color: #6b7280; font-size: 0.85rem; }
    .meta, .chain { font-size: 0.75rem; color: #9aa3b2; padding: 8px 12px; }
    .chain { border-top: 1px solid #2a3040; color: #6b7280; }
    .err { color: #ff8a8a; }
    a { color: #7eb6ff; }
  </style>
</head>
<body>
  <h1>Freemium image providers — same prompt</h1>
  <p class="sub">${esc(meta.promptDescription)}<br/><a href="results.md">results.md</a></p>
  <div class="grid">${cards}</div>
</body>
</html>`;
  fs.writeFileSync(path.join(runDir, "gallery.html"), html);

  fs.writeFileSync(path.join(probeRoot, "latest.txt"), runDir);
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function main() {
  loadDotEnv();
  const args = parseArgs();
  const description = args.description || "young woman with dark hair, gentle smile, visual novel portrait";
  const prompt = composeImagePrompt(description, {
    subjectType: args.subject,
    style: args.style,
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = path.join(probeRoot, "runs", stamp);
  fs.mkdirSync(runDir, { recursive: true });

  const baseEnv = { ...process.env, EXTRACT_SKIP_GEMINI: "true", AI: globalThis.__WRANGLER_AI__ || null };
  const meta = {
    when: new Date().toISOString(),
    promptDescription: description,
    promptFull: prompt,
    subject: args.subject,
    style: args.style,
  };

  console.log("Freemium gallery probe");
  console.log("Run dir:", runDir);
  console.log("Description:", description);
  console.log("Prompt length:", prompt.length);
  console.log("");

  const rows = [];
  for (const pid of ISOLATED_PROVIDERS) {
    console.log(`▶ ${pid}…`);
    const row = await runOne(pid, prompt, baseEnv);
    rows.push(row);
    if (row.skipped) console.log(`  ⊘ skip: ${row.error}`);
    else if (row.ok) console.log(`  ✓ ${row.bytes} bytes in ${(row.ms / 1000).toFixed(1)}s (${row.winner})`);
    else console.log(`  ✗ ${row.error}`);
  }

  console.log("▶ cascade (production order, no Workers AI)…");
  const cascadeRow = await runCascade(prompt, baseEnv, {
    label: "cascade (no workers-ai)",
    disableAi: true,
    disableGemini: false,
  });
  rows.push(cascadeRow);
  if (cascadeRow.ok) {
    console.log(`  ✓ cascade → ${cascadeRow.winner} in ${(cascadeRow.ms / 1000).toFixed(1)}s`);
  } else {
    console.log(`  ✗ ${cascadeRow.error}`);
  }

  console.log("▶ huggingface…");
  const hfRow = await runOne("huggingface", prompt, baseEnv);
  rows.push(hfRow);
  if (hfRow.skipped) console.log(`  ⊘ skip: ${hfRow.error}`);
  else if (hfRow.ok) console.log(`  ✓ ${hfRow.bytes} bytes in ${(hfRow.ms / 1000).toFixed(1)}s (${hfRow.winner})`);
  else console.log(`  ✗ ${hfRow.error}`);

  writeGallery(runDir, rows, meta);

  const ok = rows.filter((r) => r.ok).length;
  const fail = rows.filter((r) => !r.ok && !r.skipped).length;
  console.log("");
  console.log(`Done: ${ok} ok, ${fail} failed, ${rows.length - ok - fail} skipped`);
  console.log(`results.md  → ${path.join(runDir, "results.md")}`);
  console.log(`gallery.html → ${path.join(runDir, "gallery.html")}`);
}

main().catch((e) => {
  console.error("FAIL:", e.message || e);
  process.exit(1);
});
