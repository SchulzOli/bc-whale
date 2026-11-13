import assert from "node:assert/strict";
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { zipSync, strToU8 } from "fflate";
import { analyzeCpuProfile, analyzeProfileFile, analyzeProfileFileAsync } from "./profile-analysis.js";

const frame = (functionName: string, scriptId = "Page_50101") => ({
  functionName, scriptId, url: "al-preview://test", lineNumber: 1, columnNumber: 0,
});
const profile = () => ({
  nodes: [
    { id: 1, callFrame: frame("RunWorkload"), children: [2, 3] },
    { id: 2, callFrame: frame("DoubleValue", "CodeUnit_50100"), children: [] },
    { id: 3, callFrame: frame("IdleTime"), children: [] },
  ],
  samples: [1, 2, 3, 2], timeDeltas: [1000, 2000, 4000, 3000],
  startTime: 0, endTime: 10000,
});

test("self/inclusive time uses microseconds, excludes idle and does not invent memory", () => {
  const result = analyzeCpuProfile(profile(), "activity");
  assert.equal(result.sampleCount, 4);
  assert.equal(result.sampledDurationMs, 10);
  assert.equal(result.idleMs, 4);
  assert.deepEqual(result.hotspots.map(h => [h.functionName, h.selfMs, h.inclusiveMs]), [
    ["DoubleValue", 5, 5], ["RunWorkload", 1, 6],
  ]);
  assert.equal(result.sessionMemory, undefined);
  assert.match(result.warnings.join(" "), /sparse/i);
});

test("recursive identical frames count inclusive time once per sample", () => {
  const p = profile();
  p.nodes[1].callFrame = frame("RunWorkload");
  const result = analyzeCpuProfile({ ...p, totalMemoryUsed: 2957, totalObjectCount: 37 }, "recursive");
  assert.equal(result.hotspots[0].selfMs, 6);
  assert.equal(result.hotspots[0].inclusiveMs, 6);
  assert.deepEqual(result.sessionMemory, { bytes: 2957, objects: 37, display: "2.89 KiB" });
});

test("rejects malformed, cyclic and inconsistent CPU samples rather than returning misleading time", () => {
  assert.throws(() => analyzeCpuProfile({ ...profile(), timeDeltas: [1] }, "bad"), /length/i);
  assert.throws(() => analyzeCpuProfile({ ...profile(), samples: [99], timeDeltas: [1] }, "bad"), /unknown/i);
  assert.throws(() => analyzeCpuProfile({ ...profile(), timeDeltas: [-1, 2, 3, 4] }, "bad"), /timeDeltas/i);
  const cyclic = profile();
  cyclic.nodes[1].children = [1];
  assert.throws(() => analyzeCpuProfile(cyclic, "bad"), /cycle/i);
  const duplicate = profile();
  duplicate.nodes[1].id = 1;
  assert.throws(() => analyzeCpuProfile(duplicate, "bad"), /duplicate/i);
});

test("analyzes ZIP overview and CPU evidence locally, never extracts archive paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "bc-whale-profiles-"));
  try {
    const file = join(dir, "profiles.zip");
    writeFileSync(file, zipSync({
      "../activity.alcpuprofile": strToU8(JSON.stringify(profile())),
      "performance-profiles-overview.json": strToU8(JSON.stringify([{
        activityId: "activity", activityDescription: "Run workload",
        activityDurationMs: 20, sampledAlCallsDurationMs: 6,
        sqlStatementCount: 0, sqlCallDurationMs: 0, httpCallCount: 0, httpCallDurationMs: 0,
      }])),
    }));
    const result = analyzeProfileFile(file);
    assert.equal(result.succeeded, true);
    assert.equal(result.profiles.length, 1);
    assert.equal(result.activities[0].activityDurationMs, 20);
    assert.equal(result.activities[0].sqlStatementCount, 0);
    assert.equal(result.profiles[0].hotspots[0].functionName, "DoubleValue");
    assert.equal(JSON.parse(readFileSync(result.reportFile, "utf8")).sourceSha256.length, 64);
    assert.match(result.summary, /DoubleValue/);
    assert.match(result.warnings.join(" "), /sensitive/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("empty profiles are explicitly unsuccessful capture evidence and invalid archives throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "bc-whale-profiles-"));
  try {
    const file = join(dir, "empty.alcpuprofile");
    writeFileSync(file, JSON.stringify({ nodes: [], samples: [], timeDeltas: [], startTime: 0, endTime: 0 }));
    assert.equal(analyzeProfileFile(file).succeeded, false);
    writeFileSync(file, "not json");
    assert.throws(() => analyzeProfileFile(file));
    const zip = join(dir, "empty.zip");
    writeFileSync(zip, zipSync({ "irrelevant.txt": strToU8("ignored") }));
    assert.throws(() => analyzeProfileFile(zip), /no.*profile/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("analysis cannot overwrite its source through a hardlinked report path", () => {
  const dir = mkdtempSync(join(tmpdir(), "bc-whale-profiles-"));
  try {
    const file = join(dir, "source.alcpuprofile"), reportFile = join(dir, "report.json");
    const original = JSON.stringify(profile());
    writeFileSync(file, original);
    linkSync(file, reportFile);
    assert.throws(() => analyzeProfileFile(file, { reportFile }), /overwrite|source/i);
    assert.equal(readFileSync(file, "utf8"), original);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("worker analysis returns real evidence and terminates on cancellation without writing a report", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bc-whale-profiles-"));
  try {
    const file = join(dir, "source.alcpuprofile");
    writeFileSync(file, JSON.stringify(profile()));
    assert.equal((await analyzeProfileFileAsync(file)).profiles[0].hotspots[0].selfMs, 5);
    const controller = new AbortController();
    const reportFile = join(dir, "cancelled.json");
    const pending = analyzeProfileFileAsync(file, { signal: controller.signal, reportFile });
    controller.abort(new Error("Analysis cancelled"));
    await assert.rejects(pending, /cancelled/i);
    assert.equal(existsSync(reportFile), false);
    writeFileSync(file, "invalid json");
    await assert.rejects(analyzeProfileFileAsync(file));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
