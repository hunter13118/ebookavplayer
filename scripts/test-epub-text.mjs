import { unzipSync, zipSync } from "fflate";
import { extractEpubText } from "../worker/_shared/epub-text.js";

function makeEpub() {
  const files = {
    "mimetype": new TextEncoder().encode("application/epub+zip"),
    "META-INF/container.xml": new TextEncoder().encode(
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    ),
    "OEBPS/content.opf": new TextEncoder().encode(
      `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>The Vending Machine</dc:title><dc:creator>Test Author</dc:creator></metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml"/>
<item id="ch1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>
<item id="after" href="Text/afterword.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine><itemref idref="ch1"/><itemref idref="after"/></spine></package>`,
    ),
    "OEBPS/nav.xhtml": new TextEncoder().encode("<html><body>nav</body></html>"),
    "OEBPS/Text/ch1.xhtml": new TextEncoder().encode(
      "<html><body><p>Chapter one has enough text here to pass the minimum length filter easily.</p></body></html>",
    ),
    "OEBPS/Text/afterword.xhtml": new TextEncoder().encode(
      "<html><body><p>Afterword text that should come second in spine order not first alphabetically.</p></body></html>",
    ),
  };
  return zipSync(files);
}

const bytes = makeEpub();
const out = extractEpubText(bytes);
if (out.opf_path !== "OEBPS/content.opf") throw new Error(`bad opf: ${out.opf_path}`);
if (out.title !== "The Vending Machine") throw new Error(`bad title: ${out.title}`);
if (out.author !== "Test Author") throw new Error(`bad author: ${out.author}`);
if (!out.body_text.includes("Chapter one")) throw new Error("missing ch1");
if (!out.body_text.includes("## Chapter 1:")) throw new Error("missing chapter marker");
if (out.chapter_count !== 2) throw new Error(`expected 2 chapters, got ${out.chapter_count}`);
if (out.body_text.indexOf("Chapter one") >= out.body_text.indexOf("Afterword")) {
  throw new Error("spine order wrong");
}
console.log("epub-text ok", { title: out.title, chars: out.chars, chapters: out.chapter_count });
