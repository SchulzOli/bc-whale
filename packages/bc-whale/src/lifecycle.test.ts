import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { validateLifecycle, type LifecycleOptions } from "./lifecycle.js";
import { publish, runTests } from "./deploy.js";
import { loadRepo } from "./repo.js";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { USER_DIR } from "./config.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bc-whale-validation-"));
  for (const [folder, version] of [["baseline", "1.0.0.0"], ["candidate", "1.1.0.0"]]) {
    const repo = join(root, folder);
    mkdirSync(join(repo, ".git"), { recursive: true });
    for (const [name, id] of [["Probe", "11111111-1111-1111-1111-111111111111"], ["Probe Tests", "22222222-2222-2222-2222-222222222222"]]) {
      mkdirSync(join(repo, name));
      writeFileSync(join(repo, name, "app.json"), JSON.stringify({
        id, name, version, publisher: "Validation",
        dependencies: name.endsWith("Tests") ? [{ id: "11111111-1111-1111-1111-111111111111", name: "Probe", publisher: "Validation", version }] : [],
      }));
      if (name.endsWith("Tests")) writeFileSync(join(repo, name, "Test.al"), "codeunit 50100 ProbeTests { Subtype = Test; }");
    }
    writeFileSync(join(repo, "bc-whale.json"), JSON.stringify({ targets: {
      isolated: { type: "onprem", server: "http://unused", authentication: "Windows" },
      production: { type: "cloud", environmentName: "Production", environmentType: "Production" },
    } }));
  }
  const options: LifecycleOptions = {
    repo: join(root, "candidate"), baselineRepo: join(root, "baseline"),
    projects: ["Probe", "Probe Tests"], target: "isolated", company: "Validation",
    seedCodeunits: ["50100"], seedMethods: ["Seed"], verifyCodeunits: ["50100"], verifyMethods: ["Verify"],
    authorizedDisposableTarget: true,
  };
  return { root, options };
}

it("rejects missing authorization, company, explicit selectors, same repo and production before target access", async () => {
  const { root, options } = fixture();
  try {
    for (const change of [
      { authorizedDisposableTarget: false }, { company: "" }, { seedMethods: [] },
      { verifyCodeunits: [] }, { projects: [] }, { target: "" },
      { baselineRepo: join(root, "candidate") }, { target: "production" },
    ]) await assert.rejects(() => validateLifecycle({ ...options, ...change }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("archives unsupported target inspection as blocked before any builds or publishes", async () => {
  const { root, options } = fixture();
  try {
    const result = await validateLifecycle(options);
    assert.equal(result.succeeded, false);
    assert.equal(result.status, "blocked");
    assert.equal(result.stages[0].status, "blocked");
    assert.ok(result.stages.slice(1).every((s) => s.status === "not-run"));
    const report = JSON.parse(readFileSync(result.reportFile, "utf8"));
    assert.equal(report.targetType, "onprem");
    assert.equal(report.company, "Validation");
    assert.equal(report.diagnostics.profile.status, "not-run");
    assert.match(report.stages[0].reason, /installed/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("publish and test discovery do not fall back to mutable outputs when archived packages are missing", async () => {
  const { root } = fixture();
  try {
    const repo = loadRepo(join(root, "candidate"));
    const out = join(repo.root, ".bc-whale", "out");
    const archived = join(root, "archived");
    mkdirSync(out, { recursive: true });
    mkdirSync(archived);
    writeFileSync(join(out, "Validation_Probe_1.1.0.0.app"), "not an archived package");
    writeFileSync(join(out, "Validation_Probe Tests_1.1.0.0.app"), "not an archived package");
    const connection = { args: [], env: {}, launch: {}, summary: "must not connect" };
    const deployed = await publish(repo, connection, { packageFolder: archived, projects: ["Probe"] });
    assert.equal(deployed.succeeded, false);
    assert.match(deployed.apps[0].message ?? "", /not built/i);
    const tested = await runTests(repo, connection, { packageFolder: archived, projects: ["Probe Tests"] });
    assert.equal(tested.succeeded, false);
    assert.match(tested.projects[0].message ?? "", /not built/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("locks a Docker target across aliases and companies before trying to connect", async () => {
  const { root, options } = fixture();
  const container = basename(root);
  const locks = join(USER_DIR, "validation-locks");
  mkdirSync(locks, { recursive: true });
  const lock = join(locks, `${createHash("sha256").update(`docker:${container.toLowerCase()}`).digest("hex")}.lock`);
  try {
    writeFileSync(join(root, "candidate", "bc-whale.json"), JSON.stringify({ targets: {
      isolated: { type: "docker", container },
      alias: { type: "docker", container: container.toUpperCase() },
    } }));
    writeFileSync(lock, "another validation owns this target", { flag: "wx" });
    await assert.rejects(() => validateLifecycle(options), /locked/);
    await assert.rejects(() => validateLifecycle({ ...options, target: "alias", company: "Other" }), /locked/);
    assert.equal(readFileSync(lock, "utf8"), "another validation owns this target");
  } finally {
    rmSync(lock, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
