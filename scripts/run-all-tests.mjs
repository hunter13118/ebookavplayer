#!/usr/bin/env node
// Runs every tests/*.test.mjs in its own process so one file's crash doesn't
// hide the rest, then reports a single pass/fail summary. Add a new
// tests/*.test.mjs file and it's picked up automatically — no script wiring
// needed.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const testsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tests");
const files = readdirSync(testsDir)
  .filter((f) => f.endsWith(".test.mjs"))
  .sort();

let failed = 0;
for (const file of files) {
  const full = path.join(testsDir, file);
  const result = spawnSync(process.execPath, [full], { stdio: "inherit" });
  if (result.status !== 0) {
    failed += 1;
    console.error(`✗ ${file}`);
  }
}

console.log(`\n${files.length - failed}/${files.length} test files passed`);
if (failed > 0) {
  console.error(`${failed} test file(s) failed`);
  process.exit(1);
}
