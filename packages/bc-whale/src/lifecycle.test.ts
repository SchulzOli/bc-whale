import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { validateLifecycle, type LifecycleOptions } from "./lifecycle.js";
import { publish, runTests } from "./deploy.js";
import { loadRepo } from "./repo.js";
import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import { USER_DIR } from "./config.js";
import { exec } from "./exec.js";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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
    const invalid: Record<string, unknown>[] = [
      { authorizedDisposableTarget: false }, { company: "" }, { seedMethods: [] },
      { verifyCodeunits: [] }, { projects: [] }, { target: "" },
      { baselineRepo: join(root, "candidate") }, { target: "production" },
      { companies: ["First"] }, { company: undefined, companies: [] },
      { company: undefined, companies: ["First", "first"] }, { company: undefined, companies: [" "] },
      { failOn: "none" }, { baselinePackages: [] },
      { baselinePackages: [{ file: "relative.app", sha256: "a".repeat(64) }] },
      { baselinePackages: [{ file: join(root, "baseline.app"), sha256: "invalid" }] },
    ];
    for (const change of invalid) await assert.rejects(() => validateLifecycle({ ...options, ...change }));
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

async function simulatedValidation(change: Record<string, unknown> = {}, mode = "", transport: "api" | "cli" | "mcp" = "api") {
  const { root, options } = fixture();
  const released = join(root, "released.app");
  const bytes = JSON.stringify({ id: "11111111-1111-1111-1111-111111111111", name: "Probe", publisher: "Validation", version: "1.0.0.0" });
  writeFileSync(released, bytes);
  writeFileSync(join(root, "audit.json"), "[]");
  if (mode === "stale-baseline-output") {
    mkdirSync(join(root, "baseline", ".bc-whale", "out"), { recursive: true });
    writeFileSync(join(root, "baseline", ".bc-whale", "out", "Validation_Probe_9.0.0.0.app"), "unrelated previous build");
  }
  for (const folder of ["baseline", "candidate"]) {
    writeFileSync(join(root, folder, "bc-whale.json"), JSON.stringify({
      analyzers: [], targets: { isolated: { type: "docker", container: `synthetic-${basename(root)}` } },
    }));
  }
  const script = `
    import { mock } from 'node:test';
    import fs from 'node:fs';
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    const root = process.env.FIXTURE_ROOT, mode = process.env.FIXTURE_MODE;
    const url = name => pathToFileURL(path.join(process.env.FIXTURE_DIST, name + '.js')).href;
    const symbols = await import(url('symbols'));
    const { selectProjects, appFileName } = await import(url('repo'));
    const audit = [];
    let installed = [], companyReads = 0;
    const record = value => { audit.push(value); fs.writeFileSync(path.join(root, 'audit.json'), JSON.stringify(audit)); };
    mock.module(url('docker'), { namedExports: {
      ...(await import(url('docker'))),
      inspectContainer: async () => ({ running: true, bcVersion: '29.0.0.0', auth: 'Windows' }),
      invokeInContainer: async (_name, script) => {
        if (script.includes('Get-NAVCompany')) {
          companyReads++;
          return '##COMPANIES##' + JSON.stringify(mode === 'drift' && companyReads > 1 ? ['First', 'Replacement'] : ['First', 'Second']);
        }
        return '##VALIDATION##' + JSON.stringify(installed);
      }
    } });
    mock.module(url('targets'), { namedExports: {
      ...(await import(url('targets'))),
      resolveConnection: async () => ({ args: [], env: {}, summary: 'synthetic', launch: {} })
    } });
    mock.module(url('altool'), { namedExports: {
      ...(await import(url('altool'))),
      resolveAltool: async () => ({ path: process.execPath, version: 'test', source: 'env' }),
      runAltool: async args => {
        const methods = args[0] === 'runtests' ? JSON.parse(fs.readFileSync(args[args.indexOf('--testgroups') + 1], 'utf8')).flatMap(g => g.testMethods) : undefined;
        record({ command: args[0], args, methods });
        if (args[0] === 'gpm') {
          const app = JSON.parse(fs.readFileSync(args[1], 'utf8'));
          if (mode === 'wrong-identity') app.publisher = 'Unexpected publisher';
          if (mode === 'wrong-version') app.version = '0.9.0.0';
          return { exitCode: 0, json: app };
        }
        if (args[0] === 'publishapp') {
          const app = JSON.parse(fs.readFileSync(args[1], 'utf8'));
          installed = installed.filter(a => a.id !== app.id).concat(app);
          if (mode === 'tamper' && app.version === '1.0.0.0') fs.writeFileSync(args[1], 'changed');
          return { exitCode: 0, json: { succeeded: true } };
        }
        if (args[0] === 'listtests') return { exitCode: 0, json: { codeunits: [{ id: 50100, name: 'Probe', methods: [{ name: 'Seed' }, { name: 'Verify' }] }] } };
        if (args[0] === 'runtests') return { exitCode: 0, json: { succeeded: true, tests: methods.map(method => ({ method, result: 'Passed' })) } };
        throw new Error('Unexpected altool operation: ' + args[0]);
      }
    } });
    mock.module(url('symbols'), { namedExports: {
      ...symbols, downloadSymbols: async () => ({ projects: [{ succeeded: true }] })
    } });
    mock.module(url('build'), { namedExports: {
      ...(await import(url('build'))),
      build: async (repo, _cfg, o) => {
        const selected = selectProjects(repo, o.projects, { includeDependencies: o.includeDependencies });
        record({ command: 'build', baseline: repo.root.endsWith('baseline'), names: selected.map(p => p.app.name), failOn: o.failOn });
        for (const p of selected) fs.writeFileSync(path.join(symbols.outputDir(repo), appFileName(p.app)), JSON.stringify(p.app));
        return { succeeded: mode !== 'warnings' || o.failOn === 'error', diagnostics: mode === 'warnings' ? [{ severity: 'Warning', ruleId: 'PC0001' }] : [] };
      }
    } });
    const options = JSON.parse(process.env.FIXTURE_OPTIONS);
    if (process.env.FIXTURE_TRANSPORT === 'mcp') await import(url('mcp'));
    else if (process.env.FIXTURE_TRANSPORT === 'cli') {
      process.argv = [process.execPath, 'cli.js', '-r', options.repo, 'validate',
        '--baseline-repo', options.baselineRepo, '-p', options.projects.join(','), '-t', options.target,
        '--companies', options.companies.join(','), '--seed-codeunits', '50100', '--seed-methods', 'Seed',
        '--verify-codeunits', '50100', '--verify-methods', 'Verify', '--authorized-disposable-target',
        '--baseline-package', options.baselinePackages[0].sha256 + '=' + options.baselinePackages[0].file,
        '--fail-on', options.failOn ?? 'warning'];
      await import(url('cli'));
    } else {
      const { validateLifecycle } = await import(url('lifecycle'));
      console.log(JSON.stringify(await validateLifecycle(options)));
    }
  `;
  const input = {
    ...options, company: undefined, companies: ["First", "Second"],
    baselinePackages: [{ file: released, sha256: mode === "bad-hash" ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex") }],
    ...change,
  };
  try {
    const args = ["--experimental-test-module-mocks", "--input-type=module", "-e", script];
    const env = {
      ...process.env, FIXTURE_ROOT: root, FIXTURE_MODE: mode, FIXTURE_TRANSPORT: transport,
      FIXTURE_DIST: fileURLToPath(new URL(".", import.meta.url)), FIXTURE_OPTIONS: JSON.stringify(input),
      BC_WHALE_HOME: join(root, "home"),
    };
    let data;
    if (transport === "mcp") {
      const client = new Client({ name: "validation-test", version: "1" });
      try {
        await client.connect(new StdioClientTransport({ command: process.execPath, args, env, stderr: "pipe" }));
        const reply = await client.callTool({ name: "bc_whale_validate", arguments: input });
        assert.ok(Array.isArray(reply.content) && reply.content[0].type === "text");
        assert.notEqual(reply.isError, true, reply.content[0].text);
        data = JSON.parse(reply.content[0].text);
      } finally { await client.close(); }
    } else {
      const result = await exec(process.execPath, args, { env, stream: false, timeoutMs: 20000 });
      assert.equal(result.exitCode, 0, result.output);
      data = JSON.parse(result.stdout);
    }
    return {
      root, result: data,
      audit: JSON.parse(readFileSync(join(root, "audit.json"), "utf8")) as { command: string; args?: string[]; methods?: string[]; baseline?: boolean; names?: string[]; failOn?: string }[],
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

it("preserves released baseline bytes, compiles only baseline tests and verifies every company without reseeding", async () => {
  const f = await simulatedValidation();
  try {
    assert.equal(f.result.succeeded, true, JSON.stringify(f.result.stages));
    const archived = join(dirname(f.result.reportFile), "baseline-packages", "Validation_Probe_1.0.0.0.app");
    assert.equal(readFileSync(archived, "utf8"), readFileSync(join(f.root, "released.app"), "utf8"));
    assert.deepEqual(f.audit.find(a => a.command === "build" && a.baseline)?.names, ["Probe Tests"]);
    assert.equal(f.result.baselineMode, "released-packages");
    assert.deepEqual(f.result.companies, ["First", "Second"]);
    const tests = f.audit.filter(a => a.command === "runtests").map(a => a.args!);
    assert.equal(tests.length, 4);
    assert.deepEqual(tests.map(a => a[a.indexOf("--company") + 1]), ["First", "Second", "First", "Second"]);
    assert.deepEqual(f.audit.filter(a => a.command === "runtests").map(a => a.methods), [["Seed"], ["Seed"], ["Verify"], ["Verify"]]);
  } finally { f.cleanup(); }
});

it("keeps warnings blocking by default but records an explicit error threshold without suppressing diagnostics", async () => {
  for (const failOn of [undefined, "error"]) {
    const f = await simulatedValidation({ failOn }, "warnings");
    try {
      assert.equal(f.result.succeeded, failOn === "error");
      assert.equal(f.result.failOn, failOn ?? "warning");
      assert.ok(f.audit.filter(a => a.command === "build").every(a => a.failOn === (failOn ?? "warning")));
      const stage = f.result.stages.find((s: { name: string }) => s.name === "prepare-baseline");
      assert.equal((stage.evidence.build ?? stage.evidence).diagnostics[0].ruleId, "PC0001");
    } finally { f.cleanup(); }
  }
});

it("rejects changed archived baseline bytes before seeding and never publishes the candidate", async () => {
  const f = await simulatedValidation({}, "tamper");
  try {
    assert.equal(f.result.succeeded, false);
    assert.match(f.result.stages.find((s: { status: string }) => s.status === "failed").reason, /package changed/i);
    assert.equal(f.audit.filter(a => a.command === "runtests").length, 0);
    assert.ok(f.audit.filter(a => a.command === "publishapp").every(a => !a.args!.some(v => v.includes("candidate-packages"))));
  } finally { f.cleanup(); }
});

it("blocks the candidate upgrade when the company set changes after seeding", async () => {
  const f = await simulatedValidation({}, "drift");
  try {
    assert.equal(f.result.succeeded, false);
    assert.match(f.result.stages.find((s: { status: string }) => s.status === "failed").reason, /compan/i);
    assert.ok(f.audit.filter(a => a.command === "publishapp").every(a => !a.args!.some(v => v.includes("candidate-packages"))));
  } finally { f.cleanup(); }
});

for (const transport of ["cli", "mcp"] as const) {
  it(`exposes released packages, companies and explicit warning policy through ${transport}`, async () => {
    const f = await simulatedValidation({ failOn: "error" }, "warnings", transport);
    try {
      assert.equal(f.result.succeeded, true);
      assert.equal(f.result.baselineMode, "released-packages");
      assert.equal(f.result.failOn, "error");
      assert.deepEqual(f.result.companies, ["First", "Second"]);
      assert.equal(f.audit.filter(a => a.command === "runtests").length, 4);
    } finally { f.cleanup(); }
  });
}

it("keeps source-baseline and single-company validation compatible", async () => {
  const f = await simulatedValidation({ company: "First", companies: undefined, baselinePackages: undefined });
  try {
    assert.equal(f.result.succeeded, true);
    assert.equal(f.result.baselineMode, "source");
    assert.equal(f.result.company, "First");
    assert.deepEqual(f.audit.find(a => a.command === "build" && a.baseline)?.names, ["Probe", "Probe Tests"]);
    assert.equal(f.audit.filter(a => a.command === "runtests").length, 2);
  } finally { f.cleanup(); }
});

for (const mode of ["bad-hash", "wrong-identity", "wrong-version"]) {
  it(`rejects released baseline ${mode} before any publish`, async () => {
    const f = await simulatedValidation({}, mode);
    try {
      assert.equal(f.result.succeeded, false);
      assert.equal(f.result.stages.find((s: { name: string }) => s.name === "prepare-baseline").status, "failed");
      assert.equal(f.audit.filter(a => a.command === "publishapp").length, 0);
      assert.equal(f.audit.filter(a => a.command === "build").length, 0);
    } finally { f.cleanup(); }
  });
}

it("blocks stale competing baseline production outputs without deleting them or compiling fixtures against them", async () => {
  const f = await simulatedValidation({}, "stale-baseline-output");
  try {
    assert.equal(f.result.succeeded, false);
    assert.match(f.result.stages.find((s: { status: string }) => s.status === "failed").reason, /competing|another version/i);
    assert.equal(f.audit.filter(a => a.command === "build").length, 0);
    assert.equal(readFileSync(join(f.root, "baseline", ".bc-whale", "out", "Validation_Probe_9.0.0.0.app"), "utf8"), "unrelated previous build");
  } finally { f.cleanup(); }
});
