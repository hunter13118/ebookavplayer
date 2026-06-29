/** POST a minimal EPUB to local edge ingest and print job id + status. */
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const API = process.argv[2] || "http://127.0.0.1:8600/projects/ebookavplayer/api";

const body = "<html><body><p>" + "The rooftop was locked. Mei found a vending machine. ".repeat(200) + "</p></body></html>";
const files = {
  mimetype: new TextEncoder().encode("application/epub+zip"),
  "META-INF/container.xml": new TextEncoder().encode(
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  ),
  "OEBPS/content.opf": new TextEncoder().encode(
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>The Vending Machine at the Edge of the World</dc:title><dc:creator>Anonymous</dc:creator></metadata>
<manifest><item id="ch1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="ch1"/></spine></package>`,
  ),
  "OEBPS/Text/ch1.xhtml": new TextEncoder().encode(body),
};

const out = resolve(dirname(fileURLToPath(import.meta.url)), "../smoke_out/test-vending.epub");
writeFileSync(out, zipSync(files));

const fd = new FormData();
fd.append("file", new Blob([zipSync(files)], { type: "application/epub+zip" }), "The_Vending_Machine_at_the_Edge_of_the_World.epub");
fd.append("art_style", "semi-real");
fd.append("generate_art", "true");
fd.append("dry_run", "false");

const res = await fetch(`${API}/ingest`, { method: "POST", body: fd });
const json = await res.json();
console.log("ingest", res.status, json);

if (!json.job_id) process.exit(1);

for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const st = await fetch(`${API}/ingest/${json.job_id}`).then((r) => r.json());
  console.log(`[${i}]`, st.status, st.stage, st.progress, st.detail?.slice?.(0, 80) || st.detail);
  if (st.status === "done" || st.status === "error") {
    process.exit(st.status === "done" ? 0 : 1);
  }
}
process.exit(2);
