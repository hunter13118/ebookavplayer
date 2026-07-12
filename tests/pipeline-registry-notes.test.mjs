/**
 * Regression test — publicView() must actually surface STAGE_META's `note`
 * field to the frontend. Run: node tests/pipeline-registry-notes.test.mjs
 *
 * Bug: STAGE_META entries (ollama-7b, local_sd, gemini_image, etc.) carried
 * rich descriptive `note` text, but publicView()'s per-item mapping never
 * copied it into the returned object — so even though the data existed
 * server-side, the AI Pipeline menu never had it to show. Fixed alongside
 * adding image-gen model/i2i-capability notes for gemini_image, local_sd
 * (all three local model profiles), and the freemium sub-providers.
 */
import assert from "node:assert";
import { publicView } from "../worker/_shared/pipeline-registry.js";

const view = await publicView({});
const imageItems = Object.fromEntries(view.lanes.image.items.map((i) => [i.id, i]));

assert.ok(imageItems.local_sd.note, "local_sd must carry a note");
assert.match(imageItems.local_sd.note, /sdxl-turbo/);
assert.match(imageItems.local_sd.note, /animagine-xl/);
assert.match(imageItems.local_sd.note, /sd15-anime-lcm/i);
assert.match(imageItems.local_sd.note, /IP-Adapter/i, "should call out which profiles support i2i");

assert.ok(imageItems.gemini_image.note, "gemini_image must carry a note");
assert.match(imageItems.gemini_image.note, /reference/i);

assert.ok(imageItems.freemium_image.note, "freemium_image must carry a note");

const freemiumItems = Object.fromEntries(
  view.lanes.image_freemium_character.items.map((i) => [i.id, i]),
);
assert.ok(freemiumItems.huggingface.note);
assert.match(freemiumItems.huggingface.note, /no reference-image conditioning/i);
assert.ok(freemiumItems["pollinations-anon"].note);
assert.match(freemiumItems["pollinations-anon"].note, /i2i/i);

// An item with no note in STAGE_META (e.g. plain "gemini" text-extract
// stage) must resolve to null, not undefined/a crash.
assert.equal(
  view.lanes.extract.items.find((i) => i.id === "gemini").note,
  null,
);

console.log("pipeline-registry-notes.test.mjs: ok");
