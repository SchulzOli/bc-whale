import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { zipSync, strToU8 } from "fflate";
import { scheduleProfile, collectProfile, readCapture, type ProfileClient } from "./profiling.js";
import { exec } from "./exec.js";

const scheduleId = "11111111-1111-4111-8111-111111111111";
const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const cpu = { nodes: [{ id: 1, callFrame: { functionName: "RunWorkload", scriptId: "Page_50101", url: "al-preview://test", lineNumber: 0, columnNumber: 0 } }], samples: [1], timeDeltas: [1000], startTime: 0, endTime: 1000 };
const blob = Buffer.from(zipSync({ "activity.alcpuprofile": strToU8(JSON.stringify(cpu)) })).toString("base64");
const metadata = (count: number) => ({ scheduleId, targetSessionId: 10, capturedActivityCount: count, profilesOverview: [] });
const proxy = { command: "unused", args: [], cwd: ".", env: {} };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bc-whale-capture-"));
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let closed = 0, attempts = 0;
  const client: ProfileClient = {
    async call(name, args) {
      calls.push({ name, args });
      if (name === "schedule_profiling") return text({
        scheduleId, targetSessionId: 10, startedAtUtc: "2026-11-06T10:00:00Z",
        windowEndUtc: "2026-11-06T10:05:00Z", nextStep: "Reproduce the slow scenario now.",
      });
      if (++attempts === 1) return text(metadata(0));
      return { content: [...text(metadata(1)).content, { type: "resource", resource: { uri: "alprofile://schedule/test", mimeType: "application/zip", blob } }] };
    },
    async read() { throw new Error("Unexpected resource read"); },
    async close() { closed++; },
  };
  const options = { root, target: "test", targetFingerprint: "fingerprint", proxy, sessionId: 10, authorizedSession: true, timeoutMs: 2000, connect: async () => client };
  return { root, calls, client, options, closed: () => closed, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("scheduling persists only non-secret identity and returns the official next step", async () => {
  const f = fixture();
  try {
    const r = await scheduleProfile(f.options);
    assert.equal(r.succeeded, true);
    assert.equal(r.nextStep, "Reproduce the slow scenario now.");
    const state = readCapture(f.root, r.id);
    assert.equal(state.scheduleId, scheduleId);
    assert.equal(state.sessionId, 10);
    assert.equal(f.calls[0].args.targetSessionId, 10);
    assert.ok(!readFileSync(r.captureFile, "utf8").includes("env"));
    assert.equal(f.closed(), 1);
  } finally { f.cleanup(); }
});

test("collection retries the same disabled schedule, archives and analyzes nonempty evidence", async () => {
  const f = fixture();
  try {
    const scheduled = await scheduleProfile(f.options);
    const r = await collectProfile({ ...f.options, id: scheduled.id, retryIntervalMs: 1 });
    assert.equal(r.succeeded, true);
    assert.equal(r.attempts, 2);
    assert.equal(r.analysis?.profiles[0].hotspots[0].functionName, "RunWorkload");
    assert.equal(readCapture(f.root, r.id).status, "collected");
    assert.ok(r.archiveFile && readFileSync(r.archiveFile).length > 0);
    assert.deepEqual(f.calls.slice(1).map(c => [c.name, c.args]), [
      ["stop_schedule_and_get_profiles", { scheduleId, targetSessionId: 10 }],
      ["stop_schedule_and_get_profiles", { scheduleId, targetSessionId: 10 }],
    ]);
    assert.equal(f.closed(), 2);
  } finally { f.cleanup(); }
});

test("empty collection hits one total deadline, never claims success, and remains recollectable", async () => {
  const f = fixture();
  try {
    const scheduled = await scheduleProfile(f.options);
    f.client.call = async () => text(metadata(0));
    const r = await collectProfile({ ...f.options, id: scheduled.id, timeoutMs: 35, retryIntervalMs: 5 });
    assert.equal(r.succeeded, false);
    assert.equal(r.timedOut, true);
    assert.equal(readCapture(f.root, r.id).status, "pending");
    assert.match(r.warning ?? "", /same schedule/i);
    assert.equal(f.closed(), 2);
  } finally { f.cleanup(); }
});

test("authorization and target mismatches fail before connecting; capture IDs cannot escape storage", async () => {
  const f = fixture();
  try {
    await assert.rejects(scheduleProfile({ ...f.options, authorizedSession: false }), /authoriz/i);
    await assert.rejects(scheduleProfile({ ...f.options, sessionId: 0 }), /session/i);
    const scheduled = await scheduleProfile(f.options);
    await assert.rejects(collectProfile({ ...f.options, id: scheduled.id, targetFingerprint: "different" }), /target/i);
    assert.throws(() => readCapture(f.root, "..\\escape"), /capture/i);
    assert.equal(f.closed(), 1);
  } finally { f.cleanup(); }
});

test("MCP failures and malformed positive captures surface errors rather than retrying or succeeding", async () => {
  const f = fixture();
  try {
    const scheduled = await scheduleProfile(f.options);
    f.client.call = async () => ({ isError: true, content: [{ type: "text", text: "Permission denied" }] });
    const failed = await collectProfile({ ...f.options, id: scheduled.id });
    assert.equal(failed.succeeded, false);
    assert.match(failed.error ?? "", /Permission denied/);
    f.client.call = async () => text(metadata(1));
    const invalid = await collectProfile({ ...f.options, id: scheduled.id });
    assert.equal(invalid.succeeded, false);
    assert.match(invalid.error ?? "", /artifact|archive|resource/i);
  } finally { f.cleanup(); }
});

test("cancellation returns promptly even if a proxy call ignores the signal, then closes the client", async () => {
  const f = fixture();
  try {
    const scheduled = await scheduleProfile(f.options);
    f.client.call = async () => new Promise(() => {});
    const signal = AbortSignal.timeout(30);
    const start = Date.now();
    const r = await collectProfile({ ...f.options, id: scheduled.id, signal });
    assert.equal(r.succeeded, false);
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - start < 1000);
    assert.equal(f.closed(), 2);
  } finally { f.cleanup(); }
});

test("resource-only responses are read before proxy shutdown and identity mismatches are rejected", async () => {
  const f = fixture();
  try {
    const scheduled = await scheduleProfile(f.options);
    f.client.call = async () => text({ ...metadata(1), resourceUri: `alprofile://schedule/${scheduleId}_10_host` });
    f.client.read = async uri => {
      assert.match(uri, /^alprofile:/);
      return { contents: [{ uri, mimeType: "application/zip", blob }] };
    };
    assert.equal((await collectProfile({ ...f.options, id: scheduled.id })).succeeded, true);
    f.client.call = async () => text({ ...metadata(1), targetSessionId: 11 });
    const mismatch = await collectProfile({ ...f.options, id: scheduled.id });
    assert.equal(mismatch.succeeded, false);
    assert.match(mismatch.error ?? "", /identity|session/i);
  } finally { f.cleanup(); }
});

test("scheduling storage failure leaves no deadline handle keeping the CLI alive", { timeout: 8000 }, async () => {
  const f = fixture();
  try {
    const file = join(f.root, "not-a-directory");
    writeFileSync(file, "blocked");
    const code = `import {scheduleProfile} from ${JSON.stringify(new URL("./profiling.js", import.meta.url).href)};
try { await scheduleProfile(${JSON.stringify({ ...f.options, root: file, connect: undefined, timeoutMs: 4000 })}); }
catch(e) { console.log(e.message); process.exitCode=1; }`;
    const result = await exec(process.execPath, ["--input-type=module", "-e", code], { timeoutMs: 6500, stream: false });
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /ENOTDIR|EEXIST/);
    assert.ok(result.durationMs < 2500, `Storage failure held the process for ${result.durationMs}ms`);
  } finally { f.cleanup(); }
});

test("recollection preserves earlier collection evidence instead of overwriting its ZIP and metadata", async () => {
  const f = fixture();
  try {
    const scheduled = await scheduleProfile(f.options);
    const first = await collectProfile({ ...f.options, id: scheduled.id, retryIntervalMs: 1 });
    const second = await collectProfile({ ...f.options, id: scheduled.id });
    assert.equal(first.succeeded && second.succeeded, true);
    assert.notEqual(first.archiveFile, second.archiveFile);
    assert.ok(first.archiveFile && existsSync(first.archiveFile));
    assert.ok(second.archiveFile && existsSync(second.archiveFile));
  } finally { f.cleanup(); }
});
