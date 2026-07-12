/**
 * applySelectionStockOverride — an explicit scope:"selected" regen must
 * override the stock-sprite heuristic for the chosen characters, so a
 * deliberately-picked stock character (e.g. Eizo, a protagonist with few
 * attributed lines) gets a real generated portrait instead of a pooled sprite.
 * Run: node tests/selection-stock-override.test.mjs
 */
import assert from "node:assert";
import { applySelectionStockOverride } from "../worker/_shared/edge-imaging.js";

const plan = () => ({
  toGenerate: [{ id: "aria" }],
  fromStock: [{ id: "eizo" }, { id: "bystander" }],
  lineCounts: { aria: 40, eizo: 1 },
  totalLines: 41,
});

// selected id in fromStock → promoted into toGenerate, removed from fromStock
{
  const out = applySelectionStockOverride(plan(), { scope: "selected", character_ids: ["eizo"] });
  assert.deepStrictEqual(out.toGenerate.map((c) => c.id), ["aria", "eizo"]);
  assert.deepStrictEqual(out.fromStock.map((c) => c.id), ["bystander"]);
  // untouched fields preserved
  assert.strictEqual(out.totalLines, 41);
}

// selecting an already-custom character is a no-op on the pools
{
  const out = applySelectionStockOverride(plan(), { scope: "selected", character_ids: ["aria"] });
  assert.deepStrictEqual(out.toGenerate.map((c) => c.id), ["aria"]);
  assert.deepStrictEqual(out.fromStock.map((c) => c.id), ["eizo", "bystander"]);
}

// non-selected scopes never override the heuristic
for (const filter of [null, undefined, { scope: "all" }, { scope: "characters" }]) {
  const out = applySelectionStockOverride(plan(), filter);
  assert.deepStrictEqual(out.fromStock.map((c) => c.id), ["eizo", "bystander"]);
}

// selected with empty/absent character_ids → no promotion
{
  const out = applySelectionStockOverride(plan(), { scope: "selected", character_ids: [] });
  assert.deepStrictEqual(out.fromStock.map((c) => c.id), ["eizo", "bystander"]);
}

// input plan is not mutated (pure)
{
  const p = plan();
  applySelectionStockOverride(p, { scope: "selected", character_ids: ["eizo"] });
  assert.deepStrictEqual(p.fromStock.map((c) => c.id), ["eizo", "bystander"], "input must not mutate");
}

console.log("selection-stock-override: all assertions passed");
