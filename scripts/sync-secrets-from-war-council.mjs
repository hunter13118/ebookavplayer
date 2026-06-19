/**
 * Thin wrapper — canonical hub is war-council/scripts/sync-workspace-secrets.mjs
 *
 *   node scripts/sync-secrets-from-war-council.mjs
 *   node scripts/sync-secrets-from-war-council.mjs --cloud
 */
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const hub = process.env.WAR_COUNCIL_ROOT
  ? resolve(process.env.WAR_COUNCIL_ROOT, "scripts/sync-workspace-secrets.mjs")
  : resolve(dirname(fileURLToPath(import.meta.url)), "../../war-council/scripts/sync-workspace-secrets.mjs");

const args = ["node", hub, ...process.argv.slice(2)];
const r = spawnSync(args[0], args.slice(1), { stdio: "inherit", shell: true });
process.exit(r.status ?? 1);
