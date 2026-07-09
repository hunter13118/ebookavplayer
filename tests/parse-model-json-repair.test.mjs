/**
 * Unit tests — parseModelJson's malformed-JSON repair. Local LLMs
 * occasionally emit either a literal, unescaped `"` inside a dialogue value
 * (nested quotation marks are the common trigger) or simply forget a comma
 * between array/object elements — both break plain JSON.parse. See
 * docs/LOCAL_LLM_EXTRACTION.md's troubleshooting table and the "all
 * providers failed" stall this was written to fix.
 * Run: node tests/parse-model-json-repair.test.mjs
 */
import assert from "node:assert";
import { parseModelJson } from "../worker/_shared/freemium-extract.js";

// Well-formed JSON parses cleanly, no repair needed.
{
  const { data, repaired } = parseModelJson('{"scenes": [{"id": "s1", "title": "A quiet forge"}]}');
  assert.strictEqual(repaired, false);
  assert.strictEqual(data.scenes[0].id, "s1");
}

// Trailing comma still gets fixed without needing the quote repair.
{
  const { data, repaired } = parseModelJson('{"scenes": [{"id": "s1"},]}');
  assert.strictEqual(repaired, false);
  assert.strictEqual(data.scenes[0].id, "s1");
}

// A stray unescaped quote inside a dialogue value breaks plain JSON.parse
// but is recoverable via the stray-quote repair.
{
  const raw = '{"lines": [{"speaker": "Eizo", "text": "She said "hello" to me."}]}';
  assert.throws(() => JSON.parse(raw));
  const { data, repaired, snippet } = parseModelJson(raw);
  assert.strictEqual(repaired, true);
  assert.strictEqual(data.lines[0].text, 'She said "hello" to me.');
  assert.ok(snippet && snippet.includes("hello"));
}

// Repair works when the stray quote sits in the middle of a longer object,
// leaving sibling fields (before and after) intact.
{
  const raw = '{"a": "keep me", "b": "he said "hi" back", "c": "keep me too"}';
  const { data, repaired } = parseModelJson(raw);
  assert.strictEqual(repaired, true);
  assert.strictEqual(data.a, "keep me");
  assert.strictEqual(data.b, 'he said "hi" back');
  assert.strictEqual(data.c, "keep me too");
}

// A genuinely missing comma between two object properties (no quote
// involved at all — the model just forgot the separator) — "Expected ','
// or '}' after property value".
{
  const raw = '{"id": "s1" "title": "A quiet forge"}';
  assert.throws(() => JSON.parse(raw));
  const { data, repaired } = parseModelJson(raw);
  assert.strictEqual(repaired, true);
  assert.strictEqual(data.id, "s1");
  assert.strictEqual(data.title, "A quiet forge");
}

// A genuinely missing comma between two array elements — "Expected ',' or
// ']' after array element". This is the shape seen on the second stall
// (chapter 7, chunk 47): position pointed mid-array, not inside a string.
{
  const raw = '{"aliases": ["Eizo" "the blacksmith" "quiet one"]}';
  assert.throws(() => JSON.parse(raw));
  const { data, repaired } = parseModelJson(raw);
  assert.strictEqual(repaired, true);
  assert.deepStrictEqual(data.aliases, ["Eizo", "the blacksmith", "quiet one"]);
}

// Missing-comma repair still preserves untouched sibling fields.
{
  const raw = '{"a": "keep me", "b": ["x" "y"], "c": "keep me too"}';
  const { data, repaired } = parseModelJson(raw);
  assert.strictEqual(repaired, true);
  assert.strictEqual(data.a, "keep me");
  assert.deepStrictEqual(data.b, ["x", "y"]);
  assert.strictEqual(data.c, "keep me too");
}

// A stray quote *inside* an array element (not just object values) —
// regression case: an earlier version of the "valid continuation" check
// didn't treat a following `"` as valid, which meant this legitimately-quote-
// followed-by-quote case above (two adjacent strings) got mis-escaped.
{
  const raw = '{"aliases": ["Ei"zo", "smith"]}';
  const { data, repaired } = parseModelJson(raw);
  assert.strictEqual(repaired, true);
  assert.deepStrictEqual(data.aliases, ['Ei"zo', "smith"]);
}

// Truncated response — generation was cut off mid-structure (missing
// closing brackets, no misplaced character anywhere). This is the real
// failure mode reproduced against the live model: JSON.parse's error
// position lands exactly at the end of the string. Recovered by closing
// what's still open; a dangling, cut-off-mid-string final value (here,
// "title" never got its closing quote) is dropped rather than kept
// half-written, so the scene still comes back usable minus that one field.
{
  const raw = '{"scenes": [{"id": "s1", "title": "unterminate';
  assert.throws(() => JSON.parse(raw));
  const { data, repaired } = parseModelJson(raw);
  assert.strictEqual(repaired, true);
  assert.strictEqual(data.scenes[0].id, "s1");
  assert.strictEqual(data.scenes[0].title, undefined);
}

// Truncation that cuts off cleanly after a complete value (the exact shape
// seen in production: chunk ends right after a fully-closed dialogue line,
// then the structure just stops) — no dangling partial field to drop, just
// unclosed outer brackets to add back.
{
  const raw = '{"scenes": [{"id": "s1", "lines": [{"text": "hello"}]}';
  assert.throws(() => JSON.parse(raw));
  const { data, repaired } = parseModelJson(raw);
  assert.strictEqual(repaired, true);
  assert.strictEqual(data.scenes[0].lines[0].text, "hello");
}

// Genuinely unrecoverable input (no JSON structure at all) still throws —
// the repair shouldn't silently swallow every parse failure.
{
  assert.throws(() => parseModelJson("not json at all, just prose that never had braces"));
}

console.log("parse-model-json-repair.test.mjs: all assertions passed");
