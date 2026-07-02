/**
 * Unit tests — extraction prompt continuity context: known characters
 * (cross-chunk identity) and nearby illustration plates (so the model can
 * set illustration_ref on the character/scene it actually belongs to).
 * Run: npm run test:freemium-extract-prompt
 */
import assert from "node:assert";
import { buildUserPrompt } from "../worker/_shared/freemium-extract.js";

// No continuity context — prompt has neither section.
{
  const p = buildUserPrompt("b1", "Title", "Author", "text", null, 1);
  assert.doesNotMatch(p, /KNOWN CHARACTERS/);
  assert.doesNotMatch(p, /ILLUSTRATION PLATES/);
}

// Known characters section renders id/name/aliases/description.
{
  const p = buildUserPrompt("b1", "Title", "Author", "text", 1, 3, [
    { id: "eizo", name: "Eizo", aliases: ["the blacksmith"], description: "quiet protagonist, runs a forge" },
  ]);
  assert.match(p, /KNOWN CHARACTERS/);
  assert.match(p, /id=eizo/);
  assert.match(p, /aka \[the blacksmith\]/);
  assert.match(p, /quiet protagonist/);
}

// Illustration plates section renders index + nearby text context.
{
  const p = buildUserPrompt("b1", "Title", "Author", "text", 1, 3, null, [
    { index: 3, textContext: "Eizo walked into the black forest at dusk" },
  ]);
  assert.match(p, /ILLUSTRATION PLATES/);
  assert.match(p, /index=3/);
  assert.match(p, /black forest/);
}

// Both sections can be present together, in a stable order (characters then plates).
{
  const p = buildUserPrompt("b1", "Title", "Author", "text", 1, 3,
    [{ id: "eizo", name: "Eizo" }],
    [{ index: 0, textContext: "a forge glowing in the dark" }]);
  const charIdx = p.indexOf("KNOWN CHARACTERS");
  const plateIdx = p.indexOf("ILLUSTRATION PLATES");
  assert.ok(charIdx >= 0 && plateIdx >= 0 && charIdx < plateIdx);
}

console.log("freemium-extract-prompt: ok");
