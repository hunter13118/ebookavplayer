/**
 * Unit tests — matchIllustrationsToChapters, the fix for illustration plates
 * silently going unmatched on real light-novel EPUBs. Confirmed against a
 * real J-Novel Club EPUB (My Quiet Blacksmith Life, Vol. 6): illustration
 * plates live on their own dedicated spine pages ("insert1.xhtml",
 * "Color1.xhtml", "bonus1.xhtml", ...) sitting *between* chapter files in
 * spine order, not embedded inside a chapter's own file — so the original
 * exact spine_path-equality match only matched 1 of 14 plates. This fixture
 * mirrors that exact interleaved-plate-page spine shape.
 * Run: npm run test:illustration-chapter-matching
 */
import assert from "node:assert";
import { zipSync, strToU8 } from "fflate";
import { extractEpubText } from "../worker/_shared/epub-text.js";
import { extractEpubImages } from "../worker/_shared/epub-images.js";
import { matchIllustrationsToChapters } from "../worker/_shared/chapter-extract-pipeline.js";

function buildFixtureEpub() {
  const containerXml = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

  const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf">
  <manifest>
    <item id="prologue" href="prologue.xhtml" media-type="application/xhtml+xml"/>
    <item id="insert1" href="insert1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="insert2" href="insert2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="bonus1" href="bonus1.xhtml" media-type="application/xhtml+xml"/>
    <item id="pic1" href="images/pic1.png" media-type="image/png"/>
    <item id="pic2" href="images/pic2.png" media-type="image/png"/>
    <item id="pic3" href="images/pic3.png" media-type="image/png"/>
  </manifest>
  <spine>
    <itemref idref="prologue"/>
    <itemref idref="insert1"/>
    <itemref idref="ch1"/>
    <itemref idref="insert2"/>
    <itemref idref="ch2"/>
    <itemref idref="bonus1"/>
  </spine>
</package>`;

  const prose = (title, body) => `<?xml version="1.0"?>
<html><body><h1>${title}</h1><p>${body}</p></body></html>`;

  // A plate page: just an <img>, no real prose — the shape that makes it get
  // filtered out of `chapters` by buildChaptersFromSpine's text-length check.
  const platePage = (src) => `<?xml version="1.0"?>
<html><body><img src="${src}" alt="plate"/></body></html>`;

  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

  return zipSync({
    "META-INF/container.xml": strToU8(containerXml),
    "OEBPS/content.opf": strToU8(opf),
    "OEBPS/prologue.xhtml": strToU8(prose("Prologue", "A quiet morning in the forge, ash and ember settling on the anvil as Eizo began his work for the day ahead.")),
    "OEBPS/insert1.xhtml": strToU8(platePage("images/pic1.png")),
    "OEBPS/chapter1.xhtml": strToU8(prose("Chapter 1: Forest Friend", "Eizo walked into the black forest at dusk, sword in hand, searching for the source of the strange sound.")),
    "OEBPS/insert2.xhtml": strToU8(platePage("images/pic2.png")),
    "OEBPS/chapter2.xhtml": strToU8(prose("Chapter 2: The Meeting", "Kuro stood at the edge of the clearing, watching the blacksmith approach with cautious curiosity.")),
    "OEBPS/bonus1.xhtml": strToU8(platePage("images/pic3.png")),
    "OEBPS/images/pic1.png": pngBytes,
    "OEBPS/images/pic2.png": pngBytes,
    "OEBPS/images/pic3.png": pngBytes,
  });
}

const bytes = buildFixtureEpub();
const parsed = extractEpubText(bytes);
const epubExtract = extractEpubImages(bytes, {});

// Sanity: the plate pages should NOT have made it into `chapters` (too
// little prose text) — this is exactly the precondition that broke the old
// exact spine_path match.
assert.equal(parsed.chapters.length, 3, "prologue, chapter1, chapter2 — plate pages filtered out");
assert.ok(parsed.orderedPaths.length > parsed.chapters.length, "orderedPaths keeps the plate pages chapters filtered out");

const { byChapterPos } = matchIllustrationsToChapters(parsed.orderedPaths, parsed.chapters, epubExtract.imageMeta);

// insert1 sits between prologue and chapter1 — attaches to chapter1 (the
// chapter it precedes).
const ch1Pos = parsed.chapters.findIndex((c) => /chapter1\.xhtml$/.test(c.spine_path));
assert.ok(byChapterPos.get(ch1Pos)?.length === 1, "insert1's plate should attach to chapter1");

// insert2 sits between chapter1 and chapter2 — attaches to chapter2.
const ch2Pos = parsed.chapters.findIndex((c) => /chapter2\.xhtml$/.test(c.spine_path));
assert.ok(byChapterPos.get(ch2Pos)?.length === 1, "insert2's plate should attach to chapter2");

// bonus1's own page never had real prose, so it was never a `chapters`
// candidate for splitBackMatter to pop in the first place (empty
// backMatterChapters here) — falls through to the old "no following
// chapter, stays unmatched" behavior, unchanged.
const totalMatched = [...byChapterPos.values()].reduce((n, arr) => n + arr.length, 0);
assert.equal(totalMatched, 2, "only the two plates with a following chapter should match; trailing back-matter plate stays unmatched");

// Front/back-matter bucketing (new): a plate BEFORE the first real chapter
// buckets as front matter instead of folding into chapter 0, and a plate at
// or after a REAL popped-back-matter chapter (e.g. a Newsletter page —
// epub-text.js's splitBackMatter) buckets as back matter instead of being
// silently dropped.
{
  const frontImageMeta = [{ index: 0, sourcePath: "OEBPS/prologue-cover.xhtml", textContext: "" }];
  const fakeOrderedPaths = ["OEBPS/prologue-cover.xhtml", ...parsed.orderedPaths, "OEBPS/newsletter.xhtml"];
  const fakeBackMatterChapters = [{ title: "Newsletter", spine_path: "OEBPS/newsletter.xhtml" }];
  const backImageMeta = [{ index: 1, sourcePath: "OEBPS/newsletter.xhtml", textContext: "" }];

  const result = matchIllustrationsToChapters(
    fakeOrderedPaths, parsed.chapters, [...frontImageMeta, ...epubExtract.imageMeta, ...backImageMeta],
    fakeBackMatterChapters,
  );
  assert.equal(result.frontMatter.length, 1, "plate before chapter 0 buckets as front matter");
  assert.equal(result.frontMatter[0].index, 0);
  assert.equal(result.backMatter.length, 1, "plate at/after a popped back-matter chapter buckets as back matter");
  assert.equal(result.backMatter[0].index, 1);
  // The two real interleaved plates still match their chapters as before —
  // front/back bucketing doesn't disturb the existing per-chapter logic.
  const stillMatched = [...result.byChapterPos.values()].reduce((n, arr) => n + arr.length, 0);
  assert.equal(stillMatched, 2);
}

console.log("illustration-chapter-matching: ok");
