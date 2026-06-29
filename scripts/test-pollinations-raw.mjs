#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (fs.existsSync(path.join(root, ".env"))) {
  for (const line of fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}

const token = process.env.POLLINATIONS_TOKEN || "";
const prompt = "small blue owl test";
const model = "flux";

async function hit(label, seed, useToken) {
  let u = `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?model=${model}&nologo=true&seed=${seed}`;
  const headers = useToken && token ? { authorization: `Bearer ${token}` } : {};
  const t0 = Date.now();
  const res = await fetch(u, { headers });
  const ct = res.headers.get("content-type") || "";
  const ms = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${label} HTTP ${res.status} ct=${ct.slice(0, 30)} ${ms}s token=${Boolean(useToken && token)}`);
  if (!res.ok) {
    const text = (await res.text()).slice(0, 120);
    if (text) console.log("  body:", text.replace(/\s+/g, " "));
  }
}

console.log("token set:", Boolean(token));
await hit("anon A", 111, false);
await hit("anon B", 222, false);
await hit("seed A", 333, true);
await hit("seed B", 444, true);
