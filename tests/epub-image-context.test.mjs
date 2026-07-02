/**
 * Unit tests — EPUB image extraction carries source spine path + nearby text
 * context per image, so extraction chunks can be told which illustration
 * plates belong to their chapter (see chapter-extract-pipeline.js).
 * Run: npm run test:epub-image-context
 */
import assert from "node:assert";
import { zipSync, strToU8 } from "fflate";
import { extractEpubImages } from "../worker/_shared/epub-images.js";

function buildFixtureEpub() {
  const containerXml = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

  const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf">
  <manifest>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="pic1" href="images/pic1.png" media-type="image/png"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
  </spine>
</package>`;

  const chapter1 = `<?xml version="1.0"?>
<html><body>
  <h1>Chapter 1: Forest Friend</h1>
  <p>Eizo walked into the black forest at dusk, sword in hand.</p>
  <img src="images/pic1.png" alt="illustration"/>
  <p>The trees loomed overhead, silent witnesses to his approach.</p>
</body></html>`;

  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

  return zipSync({
    "META-INF/container.xml": strToU8(containerXml),
    "OEBPS/content.opf": strToU8(opf),
    "OEBPS/chapter1.xhtml": strToU8(chapter1),
    "OEBPS/images/pic1.png": pngBytes,
  });
}

const bytes = buildFixtureEpub();
const result = extractEpubImages(bytes, {});

assert.equal(result.images.length, 1, "should find the one embedded image");
assert.ok(Array.isArray(result.imageMeta), "imageMeta array must be present");
assert.equal(result.imageMeta.length, 1, "imageMeta must align 1:1 with images");

const meta = result.imageMeta[0];
assert.equal(meta.index, 0);
assert.match(meta.sourcePath, /chapter1\.xhtml$/, "sourcePath should point at the spine file the image was found in");
assert.match(meta.textContext, /Eizo/i, "textContext should include nearby narrative text");
assert.match(meta.textContext, /forest|trees/i, "textContext should include surrounding scene description");

console.log("epub-image-context: ok");
