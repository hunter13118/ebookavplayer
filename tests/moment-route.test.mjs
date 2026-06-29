/**
 * Edge route for POST /books/:id/moments/generate — must not 503 when edge bindings present.
 * Run: node tests/moment-route.test.mjs
 */
import assert from "node:assert";
import { handleEbookavplayerApi } from "../worker/worker.js";
import { lineAtIndex, momentDescription, patchAnalysisLine } from "../worker/_shared/moment-inserts.js";
import { patchPlaybackMediaUrl } from "../worker/_shared/media-versions.js";

const API = "/projects/ebookavplayer/api";

function makeEnv({ books = {} } = {}) {
  const packs = new Map();
  for (const [k, v] of Object.entries(books)) {
    packs.set(k, {
      json: async () => JSON.parse(v),
      text: async () => v,
      arrayBuffer: async () => new TextEncoder().encode(v).buffer,
    });
  }
  const jobs = new Map();
  const queue = [];
  return {
    VAE_PACKS: {
      get: async (k) => packs.get(k) || null,
      put: async (k, v) => {
        const text = typeof v === "string" ? v : new TextDecoder().decode(v);
        packs.set(k, {
          json: async () => JSON.parse(text),
          text: async () => text,
          arrayBuffer: async () => new TextEncoder().encode(text).buffer,
        });
      },
    },
    VAE_JOBS: {
      get: async (k) => jobs.get(k) || null,
      put: async (k, v) => { jobs.set(k, v); },
    },
    VAE_JOBS_QUEUE: {
      send: async (msg) => { queue.push(msg); },
    },
    _queue: queue,
    _jobs: jobs,
  };
}

function post(path, body, env) {
  const url = `https://edge.test${API}${path}`;
  const req = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleEbookavplayerApi(req, env, {});
}

// moment-inserts helpers
{
  const analysis = {
    book_id: "b1",
    characters: [{ id: "hero", name: "Hero" }],
    scenes: [{
      id: "s1",
      title: "Gate",
      location: "Castle gate",
      lines: [{ character_id: "hero", text: "I will fight!", kind: "dialogue", expression: "angry" }],
    }],
  };
  const loc = lineAtIndex(analysis, 0);
  assert.ok(loc);
  const desc = momentDescription(analysis, loc.scene, loc.line, { lineIdx: 0 });
  assert.match(desc, /Full-screen story moment/);
  const patched = patchAnalysisLine(analysis, 0, { ...loc.line, visual_moment: true });
  assert.equal(patched.scenes[0].lines[0].visual_moment, true);
}

// patchPlaybackMediaUrl sets illustration_url for inserts
{
  const env = makeEnv({
    books: {
      "books/b2.json": JSON.stringify({
        scenes: [{ id: "s1", lines: [{ idx: 3, text: "Hello there" }] }],
      }),
    },
  });
  await patchPlaybackMediaUrl(env, "b2", "inserts", "3", "/media/b2/semi-real/insert_3.png?v=1");
  const pb = await env.VAE_PACKS.get("books/b2.json").then((o) => o.json());
  assert.equal(pb.inserts["3"], "/media/b2/semi-real/insert_3.png?v=1");
  assert.equal(pb.scenes[0].lines[0].illustration_url, "/media/b2/semi-real/insert_3.png?v=1");
  assert.equal(pb.scenes[0].lines[0].visual_moment, true);
}

// route: missing book → 404 (not 503)
{
  const env = makeEnv();
  const res = await post("/books/nope/moments/generate", { line_idx: 0 }, env);
  assert.equal(res.status, 404, "missing book should 404");
}

// route: edge enabled → 200 queued (not 503)
{
  const env = makeEnv({
    books: {
      "books/demo.analysis.json": JSON.stringify({
        book_id: "demo",
        title: "Demo",
        characters: [],
        scenes: [{ id: "s1", lines: [{ character_id: "narrator", text: "Hi", kind: "narration" }] }],
      }),
    },
  });
  const res = await post("/books/demo/moments/generate", { line_idx: 0, tweak_script: false }, env);
  const raw = await res.text();
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${raw}`);
  const data = JSON.parse(raw);
  assert.ok(data.job_id);
  assert.equal(data.line_idx, 0);
  assert.equal(env._queue.length, 1);
  assert.equal(env._queue[0].kind, "moment-generate");
}

// route: no edge bindings → falls through to proxy 503
{
  const env = {};
  const res = await post("/books/demo/moments/generate", { line_idx: 0 }, env);
  assert.equal(res.status, 503);
  const err = await res.json();
  assert.match(err.error, /VAE_API_ORIGIN/);
}

console.log("moment-route.test.mjs: ok");
