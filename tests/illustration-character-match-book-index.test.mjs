/**
 * Regression test — handleIllustrationCharacterMatchMessage must reset the
 * book index's status/stage/progress on completion, not just clear
 * active_job_id. Run: node tests/illustration-character-match-book-index.test.mjs
 *
 * Bug (found live, 2026-07-10): the book index (env.VAE_JOBS `book:{id}`
 * record) is a separate snapshot from the ingest job record. It only gets
 * synced to "processing/matching/NN%" mid-run via ensureImagingLockFresh's
 * progress-sync path (imaging-lock.js), which persists that snapshot to KV.
 * The consumer's completion path used to call
 * `putBookIndex(env, book_id, { active_job_id: null })` — clearing the lock
 * pointer directly instead of going through the same reconcile path — so
 * status/stage/progress/detail stayed stuck at the last mid-run snapshot
 * forever. Confirmed live: GET /books kept showing "matching · 15%" for a
 * book whose match job had actually finished, because active_job_id being
 * null meant ensureImagingLockFresh's self-heal branch never ran again.
 */
import assert from "node:assert";
import { zipSync, strToU8 } from "fflate";
import { handleIllustrationCharacterMatchMessage } from "../worker/queue/illustration-character-match-consumer.js";

function buildNoImagesEpub() {
  const containerXml = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
  const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf">
  <manifest>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="ch1"/></spine>
</package>`;
  const chapter = `<?xml version="1.0"?>
<html><body><h1>Chapter 1</h1><p>${"A quiet morning at the forge. ".repeat(20)}</p></body></html>`;
  return zipSync({
    "META-INF/container.xml": strToU8(containerXml),
    "OEBPS/content.opf": strToU8(opf),
    "OEBPS/chapter1.xhtml": strToU8(chapter),
  });
}

function fakeEnv({ analysis, epubBytes }) {
  const packs = new Map();
  const jobs = new Map();
  packs.set(`books/book1.analysis.json`, { json: async () => analysis });
  packs.set(`uploads/book1.epub`, { arrayBuffer: async () => epubBytes.buffer });
  return {
    VAE_PACKS: {
      get: async (key) => packs.get(key) || null,
      put: async (key, val) => { packs.set(key, { json: async () => JSON.parse(val), text: async () => val }); },
    },
    VAE_JOBS: {
      get: async (key) => (jobs.has(key) ? JSON.stringify(jobs.get(key)) : null),
      put: async (key, val) => { jobs.set(key, JSON.parse(val)); },
    },
    _jobs: jobs,
  };
}

// A book with no illustration plates at all — the earliest exit path
// ("No plates to match against known chapters"). Must still reset the book
// index, not just leave it however it was before the job ran.
{
  const analysis = { characters: [{ id: "mei", name: "Mei" }] };
  const epubBytes = buildNoImagesEpub();
  const env = fakeEnv({ analysis, epubBytes });

  // Seed a stale mid-run snapshot, exactly like the real bug's symptom —
  // this is what a *previous* run's progress-sync left behind.
  env._jobs.set("book:book1", {
    book_id: "book1", status: "processing", stage: "matching", progress: 0.15,
    detail: "Matching 13 plate(s) to characters", active_job_id: "old-job",
  });

  const acked = { called: false };
  await handleIllustrationCharacterMatchMessage(
    { body: { job_id: "job1", book_id: "book1", opts: {} }, ack: () => { acked.called = true; } },
    env,
  );

  assert.ok(acked.called, "message is acked");
  const bookIndex = JSON.parse(await env.VAE_JOBS.get("book:book1"));
  assert.equal(bookIndex.status, "ready", "book index status resets to ready, not stuck on 'processing'");
  assert.equal(bookIndex.stage, "done");
  assert.equal(bookIndex.progress, 1);
  assert.equal(bookIndex.active_job_id, null, "lock pointer cleared");
}

console.log("illustration-character-match-book-index.test.mjs: ok");
