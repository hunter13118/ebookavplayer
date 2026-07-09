/**
 * One-command local ecosystem: worker (wrangler dev) + web (vite dev), with
 * an Ollama reachability check up front. Everything stays on localhost — no
 * Cloudflare Tunnel, no deploy, nothing leaves this machine. Ctrl+C kills
 * both child processes together.
 */
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_PORT = process.env.PORT || "8600";
const WEB_PORT = process.env.WEB_PORT || "5173";
const OLLAMA_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

function log(tag, msg) {
  process.stdout.write(`[${tag}] ${msg}\n`);
}

async function checkOllama() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    log("ollama", `reachable at ${OLLAMA_URL} — ${data.models?.length ?? 0} model(s) pulled`);
    return true;
  } catch (err) {
    log("ollama", `not reachable at ${OLLAMA_URL} (${err.message}) — local extraction providers will fail over to cloud fallbacks`);
    return false;
  }
}

function spawnChild(tag, command, args, opts = {}) {
  // detached: true puts the child in its own process group (pgid === its own
  // pid). `npm run` wraps the real work in a shell (sync-dev-vars.mjs &&
  // wrangler dev), so the direct child is that shell — killing just the
  // shell's pid leaves wrangler/vite running as orphans. Signaling the whole
  // negative-pid process group takes the entire tree down together.
  const child = spawn(command, args, {
    cwd: ROOT, stdio: "pipe", shell: false, detached: true, ...opts,
  });
  child.stdout.on("data", (buf) => {
    for (const line of buf.toString().split("\n")) if (line.trim()) log(tag, line);
  });
  child.stderr.on("data", (buf) => {
    for (const line of buf.toString().split("\n")) if (line.trim()) log(tag, line);
  });
  return child;
}

function killTree(child, signal) {
  if (child.pid == null || child.exitCode != null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function waitForPort(url, label, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  log("start-local", `${label} didn't come up within ${timeoutMs / 1000}s — check its logs above`);
  return false;
}

async function main() {
  await checkOllama();

  log("start-local", `starting worker on :${WORKER_PORT}, web on :${WEB_PORT}`);

  const worker = spawnChild("worker", "npm", ["run", "dev:worker"], {
    env: { ...process.env, PORT: WORKER_PORT },
  });
  const web = spawnChild("web", "npm", ["run", "dev:web"], {
    env: { ...process.env, PORT: WEB_PORT },
  });

  const children = [worker, web];
  let shuttingDown = false;

  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    log("start-local", "shutting down...");
    // SIGINT, not SIGTERM: wrangler dev spawns its own workerd runtime as a
    // separate child process and only tears that down on a graceful SIGINT
    // (the same signal a real Ctrl+C sends) — SIGTERM kills the wrangler
    // node process without giving it the chance, orphaning workerd behind
    // it, still bound to the port.
    for (const child of children) killTree(child, "SIGINT");
    setTimeout(() => {
      for (const child of children) killTree(child, "SIGKILL");
      process.exit(0);
    }, 3000);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  for (const child of children) {
    child.on("exit", (code) => {
      if (shuttingDown) return;
      log("start-local", `a child process exited unexpectedly (code ${code}) — shutting down the rest`);
      shutdown();
    });
  }

  const [workerUp, webUp] = await Promise.all([
    waitForPort(`http://localhost:${WORKER_PORT}/pipeline`, "worker"),
    waitForPort(`http://localhost:${WEB_PORT}/`, "web"),
  ]);

  if (workerUp && webUp) {
    log("start-local", `everything's up — open http://localhost:${WEB_PORT}`);
  } else {
    log("start-local", "one or more services failed to come up in time — see logs above");
  }
}

main();
