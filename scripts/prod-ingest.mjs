#!/usr/bin/env node
/**
 * POST an EPUB to production edge ingest and poll until done.
 * Usage: node scripts/prod-ingest.mjs [path/to/book.epub] [--api URL]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const API = process.argv.includes("--api")
  ? process.argv[process.argv.indexOf("--api") + 1]
  : "https://hunterthemilkman.com/projects/ebookavplayer/api";

const epubArg = process.argv.find((a) => a.endsWith(".epub"));
const epubPath = epubArg
  ? path.resolve(epubArg)
  : path.join(ROOT, "data/uploads/The_Vending_Machine_at_the_Edge_of_the_World.epub");

if (!fs.existsSync(epubPath)) {
  console.error("EPUB not found:", epubPath);
  process.exit(1);
}

const name = path.basename(epubPath);
const bytes = fs.readFileSync(epubPath);

const fd = new FormData();
fd.append("file", new Blob([bytes], { type: "application/epub+zip" }), name);
fd.append("art_style", "anime");
fd.append("narrator_gender", "male");
fd.append("generate_art", "true");
fd.append("dry_run", "false");

console.log(`POST ${API}/ingest (${(bytes.length / 1024).toFixed(0)} KB) → ${name}`);
const res = await fetch(`${API}/ingest`, { method: "POST", body: fd });
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error("ingest failed:", res.status, body);
  process.exit(1);
}
console.log("queued:", body);

const jobId = body.job_id;
if (!jobId) process.exit(1);

for (let i = 0; i < 120; i += 1) {
  await new Promise((r) => setTimeout(r, 5000));
  const st = await fetch(`${API}/ingest/${jobId}`).then((r) => r.json());
  const pct = typeof st.progress === "number" ? `${Math.round(st.progress * 100)}%` : "";
  console.log(`[${i + 1}] ${st.status} ${st.stage || ""} ${pct} ${(st.detail || "").slice(0, 100)}`);
  if (st.status === "done") {
    const books = await fetch(`${API}/books`).then((r) => r.json());
    console.log("\ncatalog:", books.map((b) => `${b.book_id} (${b.status})`).join(", ") || "(empty)");
    process.exit(0);
  }
  if (st.status === "error") {
    console.error("ingest error:", st.detail || st.error);
    process.exit(1);
  }
}
console.error("timed out waiting for ingest");
process.exit(2);
