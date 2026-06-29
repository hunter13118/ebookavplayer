#!/usr/bin/env node
/**
 * Seed a book into production R2 + KV from local data/books/*.analysis.json
 * (use when you already have a validated extract locally).
 *
 *   node scripts/seed-prod-book.mjs [book_id] [--art-style anime] [--generate]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BUCKET = "vae-packs";
const KV_NS = "77fbb19de2414b7ca3aa3408782b36a8";
const API = "https://hunterthemilkman.com/projects/ebookavplayer/api";

const bookId = process.argv.find((a) => !a.startsWith("-") && a !== process.argv[0] && a !== process.argv[1])
  || "The_Vending_Machine_at_the_Edge_of_the_World";
const artStyle = process.argv.includes("--art-style")
  ? process.argv[process.argv.indexOf("--art-style") + 1]
  : "anime";
const doGenerate = process.argv.includes("--generate");

function wrangler(args) {
  const r = spawnSync("npx wrangler " + args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" "), {
    cwd: path.resolve(ROOT, "../milkman-webapp-portfolio"),
    encoding: "utf8",
    shell: true,
  });
  if (r.status !== 0) {
    throw new Error(`wrangler ${args.join(" ")} failed: ${r.stderr || r.stdout || r.error?.message}`);
  }
  return (r.stdout || "").trim();
}

function r2Put(key, filePath, contentType = "application/json") {
  wrangler([
    "r2", "object", "put", `${BUCKET}/${key}`,
    "--file", filePath,
    "--content-type", contentType,
    "--remote",
  ]);
}

function kvPut(name, value) {
  const tmp = path.join(os.tmpdir(), `vae-kv-${Date.now()}.json`);
  fs.writeFileSync(tmp, typeof value === "string" ? value : JSON.stringify(value));
  try {
    wrangler(["kv", "key", "put", name, "--path", tmp, "--namespace-id", KV_NS, "--remote"]);
  } finally {
    fs.unlinkSync(tmp);
  }
}

async function main() {
  const analysisPath = path.join(ROOT, "data/books", `${bookId}.analysis.json`);
  const statusPath = path.join(ROOT, "data/books", `${bookId}.status.json`);
  const epubPath = path.join(ROOT, "data/uploads", `${bookId}.epub`);

  if (!fs.existsSync(analysisPath)) {
    console.error("Missing", analysisPath);
    process.exit(1);
  }

  const status = fs.existsSync(statusPath)
    ? JSON.parse(fs.readFileSync(statusPath, "utf8"))
    : {};

  const { finalizeAnalysisChapters } = await import("../worker/_shared/chapter-assign.js");
  const { compilePlayback } = await import("../worker/_shared/compile-playback.js");

  let analysis = JSON.parse(fs.readFileSync(analysisPath, "utf8"));
  analysis = finalizeAnalysisChapters(analysis, {});
  analysis.book_id = bookId;

  const playback = compilePlayback(analysis, {
    art_style: artStyle,
    narrator_gender: status.narrator_gender || "male",
  });
  playback.status = "ready";
  playback.stage = doGenerate ? "imaging" : "done";
  playback.progress = doGenerate ? 0.5 : 1;
  playback.art_style = artStyle;
  playback.active_style = artStyle;
  playback.title = analysis.title || bookId;
  playback.author = analysis.author || status.author || "";

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vae-seed-"));
  const axFile = path.join(tmpDir, "analysis.json");
  const pbFile = path.join(tmpDir, "playback.json");
  fs.writeFileSync(axFile, JSON.stringify(analysis, null, 2));
  fs.writeFileSync(pbFile, JSON.stringify(playback, null, 2));

  console.log(`Seeding ${bookId} → production R2/KV…`);
  r2Put(`books/${bookId}.analysis.json`, axFile);
  r2Put(`books/${bookId}.json`, pbFile);

  if (fs.existsSync(epubPath)) {
    r2Put(`uploads/${bookId}.epub`, epubPath, "application/epub+zip");
    console.log("  uploaded EPUB copy for re-extract");
  }

  const index = {
    book_id: bookId,
    title: playback.title,
    author: playback.author,
    status: doGenerate ? "processing" : "ready",
    stage: doGenerate ? "imaging" : "done",
    progress: doGenerate ? 0.5 : 1,
    art_style: artStyle,
    scenes: playback.scenes?.length || 0,
    lines: (playback.scenes || []).reduce((n, s) => n + (s.lines?.length || 0), 0),
  };
  kvPut(`book:${bookId}`, index);
  kvPut("catalog:ids", [bookId]);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log("  KV catalog updated");

  if (doGenerate) {
    console.log("\nQueueing generate-media (anime)…");
    const res = await fetch(`${API}/books/${encodeURIComponent(bookId)}/generate-media`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "all",
        force_all: true,
        art_style: artStyle,
        compare: false,
        diversify: true,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error("generate-media failed:", res.status, body);
      process.exit(1);
    }
    const jobId = body.job_id;
    console.log("imaging job:", jobId);
    for (let i = 0; i < 180; i += 1) {
      await new Promise((r) => setTimeout(r, 5000));
      const st = await fetch(`${API}/ingest/${jobId}`).then((r) => r.json());
      const pct = typeof st.progress === "number" ? `${Math.round(st.progress * 100)}%` : "";
      console.log(`[${i + 1}] ${st.status} ${st.stage || ""} ${pct} ${(st.detail || "").slice(0, 90)}`);
      if (st.status === "done") break;
      if (st.status === "error") {
        console.error("imaging error:", st.detail || st.error);
        process.exit(1);
      }
    }
  }

  const books = await fetch(`${API}/books`).then((r) => r.json());
  console.log("\nProduction catalog:", books);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
