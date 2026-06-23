#!/usr/bin/env node
/**
 * Upload generic stock sprites (m00–m11, f00–f11) to R2 at media/stock/.
 * Run once per bucket, or after regenerating data/media/stock via build_stock_assets.py.
 *
 *   node scripts/upload_stock_to_r2.mjs [--bucket vae-packs]
 */
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const STOCK_DIR = join(ROOT, "data", "media", "stock");
const bucket = process.argv.includes("--bucket")
  ? process.argv[process.argv.indexOf("--bucket") + 1]
  : "vae-packs";

async function main() {
  const files = (await readdir(STOCK_DIR)).filter((f) => f.endsWith(".png"));
  if (!files.length) {
    console.error(`No PNGs in ${STOCK_DIR} — run: python scripts/build_stock_assets.py`);
    process.exit(1);
  }
  for (const name of files.sort()) {
    const local = join(STOCK_DIR, name);
    const key = `media/stock/${name}`;
    const r = spawnSync(
      "npx",
      ["wrangler", "r2", "object", "put", `${bucket}/${key}`, "--file", local, "--content-type", "image/png"],
      { cwd: ROOT, stdio: "inherit", shell: true },
    );
    if (r.status !== 0) process.exit(r.status ?? 1);
    console.log(`uploaded ${key}`);
  }
  console.log(`done — ${files.length} stock sprites in R2 bucket ${bucket}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
