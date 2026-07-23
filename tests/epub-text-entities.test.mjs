/**
 * stripHtml() must decode HTML entities, not leave them as literal
 * "&#160;"-style text — harmless when only an LLM ever reads the extracted
 * text (silently normalizes past it), but directly visible to a reader once
 * mechanical-script.js shows this text verbatim with no LLM pass in between.
 * Found against a real book's Epilogue page: a numeric-entity gap between
 * two paragraphs leaked through as literal "&#160;" in the mechanical
 * script's output before this fix.
 * Run: node tests/epub-text-entities.test.mjs
 */
import assert from "node:assert";
import { zipSync, strToU8 } from "fflate";
import { extractEpubText } from "../worker/_shared/epub-text.js";

function buildFixtureEpub(bodyHtml) {
  const containerXml = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
  const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf">
  <manifest><item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="ch1"/></spine>
</package>`;
  const chapter1 = `<?xml version="1.0"?><html><body><h1>Chapter 1: Test</h1>${bodyHtml}</body></html>`;
  return zipSync({
    "META-INF/container.xml": strToU8(containerXml),
    "OEBPS/content.opf": strToU8(opf),
    "OEBPS/chapter1.xhtml": strToU8(chapter1),
  });
}

// Numeric decimal entity (&#160; non-breaking space) and named entities
// (&mdash;, &hellip;, &rsquo;) all decode to their real characters, not
// literal "&#160;"-style text.
{
  const bytes = buildFixtureEpub(
    "<p>A gap here&#160;&#160;then more.</p><p>An em&mdash;dash and an ellipsis&hellip; and a curly quote&rsquo;s mark.</p>",
  );
  const parsed = extractEpubText(bytes);
  const text = parsed.chapters[0].text;
  assert.ok(!text.includes("&#160;"), `entity leaked through literally: ${text}`);
  assert.ok(!text.includes("&mdash;"));
  assert.ok(!text.includes("&hellip;"));
  assert.ok(!text.includes("&rsquo;"));
  assert.ok(text.includes("em—dash"), "named entity decoded to its real character");
  assert.ok(text.includes("ellipsis…"), "named entity decoded to its real character");
  assert.ok(text.includes("quote’s"), "named entity decoded to its real character");
}

// Hex numeric entity (&#x2019; — right single quote) also decodes.
{
  const bytes = buildFixtureEpub("<p>It&#x2019;s a hex entity test with enough words to count as a real chapter.</p>");
  const parsed = extractEpubText(bytes);
  assert.ok(parsed.chapters[0].text.includes("It’s"));
}

// A malformed/unknown entity is left alone rather than throwing or mangling
// surrounding text.
{
  const bytes = buildFixtureEpub("<p>Not a real entity: &notarealentity; but still readable text around it here.</p>");
  const parsed = extractEpubText(bytes);
  assert.ok(parsed.chapters[0].text.includes("&notarealentity;"));
  assert.ok(parsed.chapters[0].text.includes("still readable text"));
}

console.log("epub-text-entities.test.mjs: ok");
