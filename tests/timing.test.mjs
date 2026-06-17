// Pure timing logic test (run with: node tests/timing.test.mjs)
import assert from "node:assert";
import { readFileSync } from "node:fs";
// load timing.js as CJS by stripping `export`
const src = readFileSync(new URL("../web/src/audio/timing.js", import.meta.url), "utf8")
  .replace(/export function/g, "function") +
  "\nexport {estimateDurationSec,revealedCount,isCheckpoint,stageLayout};";
const mod = await import("data:text/javascript," + encodeURIComponent(src));
const { estimateDurationSec, revealedCount, isCheckpoint, stageLayout } = mod;

assert.ok(estimateDurationSec("a b c d e", 1) > 0);
assert.ok(estimateDurationSec("a b c d e", 2) < estimateDurationSec("a b c d e", 1));
assert.equal(revealedCount("hello", 0, 1), 0);
assert.equal(revealedCount("hello", 5, 1), 5);
assert.equal(isCheckpoint(39, 40), true);
assert.equal(isCheckpoint(38, 40), false);
assert.equal(isCheckpoint(5, 0), false);
const present = [{character_id:"a"},{character_id:"b"},{character_id:"c"},{character_id:"d"}];
const laid = stageLayout(present, "c", 2);
assert.equal(laid.find(p=>p.character_id==="c").spotlight, true);
assert.ok(laid.some(p=>p.dim), "group scene dims extras");
const pair = stageLayout(present.slice(0,2), "a", 2);
assert.ok(!pair.some(p=>p.dim), "1:1 scene dims nobody");
console.log("timing.test.mjs: all assertions passed");
