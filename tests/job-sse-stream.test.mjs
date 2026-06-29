import assert from "node:assert";
import { jobFingerprint } from "../worker/_shared/job-sse-stream.js";

{
  const a = { status: "processing", progress: 0.7, debug_log: [{ ts: "1", msg: "start" }] };
  const b = { status: "processing", progress: 0.7, debug_log: [{ ts: "1", msg: "start" }] };
  const c = { status: "processing", progress: 0.71, debug_log: [{ ts: "1", msg: "start" }] };
  assert.equal(jobFingerprint(a), jobFingerprint(b));
  assert.notEqual(jobFingerprint(a), jobFingerprint(c));
}

console.log("job-sse-stream.test.mjs — all passed");
