import assert from "node:assert/strict";
import { it } from "node:test";
import { assertUpgradeApps, assertInstalledApps, assertTestSelection, runValidationStages } from "./validation.js";

const app = { id: "11111111-1111-1111-1111-111111111111", name: "Probe", publisher: "Validation", version: "1.0.0.0" };
const next = { ...app, version: "1.1.0.0" };

it("requires identical nonempty unique app identities and strictly increasing versions", () => {
  assert.doesNotThrow(() => assertUpgradeApps([app], [next]));
  for (const candidate of [[], [app], [{ ...next, publisher: "Other" }], [next, next], [{ ...next, version: "bad" }]]) {
    assert.throws(() => assertUpgradeApps([app], candidate));
  }
  assert.throws(() => assertUpgradeApps([], []));
  assert.throws(() => assertUpgradeApps([app, app], [next]));
});

it("requires installed identity and exact version; published-only or duplicate installed records fail", () => {
  assert.doesNotThrow(() => assertInstalledApps([app], [app]));
  assert.throws(() => assertInstalledApps([app], []));
  assert.throws(() => assertInstalledApps([next], [app]));
  assert.throws(() => assertInstalledApps([app], [{ ...app, publisher: "Other" }]));
  assert.throws(() => assertInstalledApps([app], [app, app]));
});

it("runs stages in order and persists each transition before reporting success", async () => {
  const calls: string[] = [];
  const saved: string[][] = [];
  const report = await runValidationStages([
    { name: "baseline", run: async () => { calls.push("baseline"); return { status: "passed", evidence: { version: app.version } }; } },
    { name: "seed", run: async () => { calls.push("seed"); return { status: "passed" }; } },
    { name: "upgrade", run: async () => { calls.push("upgrade"); return { status: "passed" }; } },
  ], (r) => { saved.push(r.stages.map((s) => s.status)); });
  assert.equal(report.succeeded, true);
  assert.deepEqual(calls, ["baseline", "seed", "upgrade"]);
  assert.deepEqual(saved[0], ["not-run", "not-run", "not-run"]);
  assert.deepEqual(saved.at(-1), ["passed", "passed", "passed"]);
  assert.deepEqual(report.stages[0].evidence, { version: app.version });
});

for (const status of ["failed", "blocked"] as const) {
  it(`preserves ${status} evidence and does not run later stages`, async () => {
    let touched = false;
    const report = await runValidationStages([
      { name: "prepare", run: async () => ({ status, reason: "no execution verified" }) },
      { name: "publish", run: async () => { touched = true; return { status: "passed" }; } },
    ], () => {});
    assert.equal(report.succeeded, false);
    assert.equal(report.status, status);
    assert.equal(report.stages[1].status, "not-run");
    assert.equal(touched, false);
  });
}

it("archives thrown operation failures without claiming rollback or running more stages", async () => {
  const report = await runValidationStages([
    { name: "publish", run: async () => { throw new Error("Publish timed out; inspect target state."); } },
    { name: "verify", run: async () => ({ status: "passed" }) },
  ], () => {});
  assert.equal(report.status, "failed");
  assert.match(report.stages[0].reason ?? "", /timed out/);
  assert.equal(report.stages[1].status, "not-run");
});

it("does not turn an empty validation into success", async () => {
  await assert.rejects(() => runValidationStages([], () => {}), /stage/i);
});

it("requires every named test selector to resolve before any deployment", () => {
  const groups = [{ id: 50210, name: "SeedTests", methods: [{ name: "Seed" }] }];
  assert.doesNotThrow(() => assertTestSelection(groups, ["50210"], ["Seed"]));
  assert.throws(() => assertTestSelection(groups, ["50210", "missing"], ["Seed"]));
  assert.throws(() => assertTestSelection(groups, ["50210"], ["Seed", "Missing"]));
  assert.throws(() => assertTestSelection([], ["50210"], ["Seed"]));
  assert.throws(() => assertTestSelection({}, ["50210"], ["Seed"]));
});

it("rejects a selected codeunit that would contribute no matching methods", () => {
  const groups = [
    { id: 50210, name: "First", methods: [{ name: "Seed" }] },
    { id: 50211, name: "Second", methods: [{ name: "Other" }] },
  ];
  assert.throws(() => assertTestSelection(groups, ["50210", "50211"], ["Seed"]), /selector/);
  assert.doesNotThrow(() => assertTestSelection(groups, ["50210", "50211"], ["Seed", "Other"]));
});
