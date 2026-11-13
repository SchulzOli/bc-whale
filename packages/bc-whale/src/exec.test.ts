import assert from "node:assert/strict";
import { it } from "node:test";
import { exec } from "./exec.js";

it("does not spawn work after cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => exec("must-not-exist", [], { signal: controller.signal }), /abort|cancel/i);
});

it("cancels a running process and returns an explicit non-success outcome", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);
  try {
    const result = await exec(process.execPath, ["-e", "setInterval(()=>{},1000)"], { signal: controller.signal, timeoutMs: 5000 });
    assert.equal(result.cancelled, true);
    assert.equal(result.timedOut, false);
    assert.notEqual(result.exitCode, 0);
    assert.ok(result.durationMs < 6000, "cancellation includes up to five seconds of confirmed cleanup");
  } finally { clearTimeout(timer); }
});

it("terminates a child tree holding inherited output pipes on timeout", { timeout: 10000 }, async () => {
  const script = "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setInterval(()=>{},1000)";
  const result = await exec(process.execPath, ["-e", script], { timeoutMs: 500 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
  assert.ok(result.durationMs < 6000);
});
