/**
 * Trailing junk (a publisher newsletter/ad page after the real story ends)
 * isn't front matter — isFrontMatter() only catches short/untitled pages,
 * and a long-enough or plausibly-titled back-matter blurb would otherwise
 * become a fake final "chapter" sent through real LLM extraction. See
 * splitBackMatter() in epub-text.js.
 * Run: node tests/epub-back-matter.test.mjs
 */
import assert from "node:assert";
import { zipSync, strToU8 } from "fflate";
import { extractEpubText } from "../worker/_shared/epub-text.js";

function page(title, bodyHtml) {
  return `<?xml version="1.0"?><html><head><title>${title}</title></head><body>${bodyHtml}</body></html>`;
}

function buildFixtureEpub({ trailingTitle, trailingBody }) {
  const containerXml = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

  const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf">
  <manifest>
    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="tail" href="tail.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="cover"/>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="tail"/>
  </spine>
</package>`;

  const cover = page("Cover", '<img src="cover.jpg" alt="Cover"/>');
  const ch1 = page(
    "Chapter 1: Into the Forest",
    `<h1>Chapter 1: Into the Forest</h1><p>${"Eizo walked into the black forest at dusk, sword drawn. ".repeat(6)}</p>`,
  );
  const ch2 = page(
    "Chapter 2: The Clearing",
    `<h1>Chapter 2: The Clearing</h1><p>${"The trees finally gave way to a wide, moonlit clearing. ".repeat(6)}</p>`,
  );
  const tail = page(trailingTitle, `<p>${trailingBody}</p>`);

  return zipSync({
    "META-INF/container.xml": strToU8(containerXml),
    "OEBPS/content.opf": strToU8(opf),
    "OEBPS/cover.xhtml": strToU8(cover),
    "OEBPS/chapter1.xhtml": strToU8(ch1),
    "OEBPS/chapter2.xhtml": strToU8(ch2),
    "OEBPS/tail.xhtml": strToU8(tail),
  });
}

// A long, plausibly-titled trailing ad page — long enough that isFrontMatter's
// text-length check alone wouldn't catch it, and titled generically enough
// ("Newsletter") that it doesn't look chapter-like either.
{
  const bytes = buildFixtureEpub({
    trailingTitle: "Newsletter",
    trailingBody: "Sign up for our newsletter to hear about new releases! ".repeat(5),
  });
  const parsed = extractEpubText(bytes);

  assert.equal(parsed.chapters.length, 2, "the newsletter page must not become a fake 3rd chapter");
  assert.equal(parsed.chapters[0].title, "Chapter 1: Into the Forest");
  assert.equal(parsed.chapters[1].title, "Chapter 2: The Clearing");
  assert.equal(parsed.backMatterChapters.length, 1);
  assert.equal(parsed.backMatterChapters[0].title, "Newsletter");
  assert.match(parsed.backMatterChapters[0].spine_path, /tail\.xhtml$/);
  // Discarded from the text sent to extraction, same as front matter.
  assert.ok(!parsed.body_text.includes("Sign up for our newsletter"));
}

// A trailing page that DOES look like real content (an actual numbered
// chapter, or an Epilogue) must never be treated as back matter.
{
  const bytes = buildFixtureEpub({
    trailingTitle: "Epilogue: What Came After",
    trailingBody: "Years later, Eizo returned to the clearing one last time. ".repeat(5),
  });
  const parsed = extractEpubText(bytes);

  assert.equal(parsed.chapters.length, 3, "a real Epilogue must stay a real chapter");
  assert.equal(parsed.chapters[2].title, "Epilogue: What Came After");
  assert.equal(parsed.backMatterChapters.length, 0);
}

// splitBackMatter never empties a book down to zero real chapters, even if
// every trailing page looks like junk.
{
  const bytes = buildFixtureEpub({ trailingTitle: "Ad Page", trailingBody: "Buy our other books! ".repeat(5) });
  const parsed = extractEpubText(bytes);
  assert.ok(parsed.chapters.length >= 1, "at least one real chapter must always survive");
}

console.log("epub-back-matter.test.mjs: ok");
