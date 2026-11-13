import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { parseArtifactSpec } from "./docker.js";
import { extractTrailingJson, mergeEnv } from "./exec.js";
import { compareVersions } from "./altool.js";
import { summarizeTestJson } from "./deploy.js";
import { loadRepo, selectProjects } from "./repo.js";
import { bumpVersion, updateVersions } from "./workspace.js";
import { loadConfig } from "./config.js";
import { exec } from "./exec.js";
import { registerMcp } from "./api.js";

const ids = {
  base: "11111111-1111-1111-1111-111111111111",
  ext: "22222222-2222-2222-2222-222222222222",
  test: "33333333-3333-3333-3333-333333333333",
};

function app(folder: string, root: string, name: string, id: string, deps: { id: string; name: string; publisher?: string; version?: string }[] = []) {
  mkdirSync(join(root, folder), { recursive: true });
  const json = {
    id,
    name,
    publisher: "Contoso",
    version: "1.0.0.0",
    application: "29.0.0.0",
    platform: "29.0.0.0",
    runtime: "18.0",
    dependencies: deps.map((d) => ({ id: d.id, name: d.name, publisher: d.publisher ?? "Contoso", version: d.version ?? "1.0.0.0" })),
  };
  writeFileSync(join(root, folder, "app.json"), "\ufeff" + JSON.stringify(json, null, 4).replace(/\n/g, "\r\n"));
}

describe("repo model", () => {
  let root: string;
  before(() => {
    root = mkdtempSync(join(tmpdir(), "bc-whale-test-"));
    mkdirSync(join(root, ".git"));
    app("Base", root, "Base", ids.base);
    app("Ext", root, "Ext", ids.ext, [{ id: ids.base, name: "Base" }]);
    app("Test", root, "Ext Test", ids.test, [
      { id: ids.ext, name: "Ext" },
      { id: "5d86850b-0d76-4eca-bd7b-951ad998e997", name: "Tests-TestLibraries", publisher: "Microsoft", version: "29.0.0.0" },
    ]);
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("discovers projects, test apps and topological levels", () => {
    const repo = loadRepo(join(root, "Ext"));
    assert.equal(repo.projects.length, 3);
    assert.deepEqual(repo.levels.map((l) => l.map((p) => p.app.name)), [["Base"], ["Ext"], ["Ext Test"]]);
    assert.equal(repo.projects.find((p) => p.app.name === "Ext Test")?.isTest, true);
    assert.equal(repo.projects.find((p) => p.app.name === "Ext")?.isTest, false);
  });

  it("selects with dependencies, dependents and wildcards", () => {
    const repo = loadRepo(root);
    assert.deepEqual(selectProjects(repo, ["Ext"], { includeDependencies: true }).map((p) => p.app.name), ["Base", "Ext"]);
    assert.deepEqual(selectProjects(repo, ["Base"], { includeDependents: true, testsOnly: true }).map((p) => p.app.name), ["Ext Test"]);
    assert.deepEqual(selectProjects(repo, ["ext*"]).map((p) => p.app.name).sort(), ["Ext", "Ext Test"]);
    assert.deepEqual(selectProjects(repo, [ids.base.toUpperCase()]).map((p) => p.app.name), ["Base"]);
    assert.throws(() => selectProjects(repo, ["nope"]));
  });

  it("bumps versions and keeps in-repo dependencies consistent, preserving BOM and CRLF", () => {
    const repo = loadRepo(root);
    const dry = updateVersions(repo, { projects: ["Base"], bump: "minor", dryRun: true });
    assert.equal(dry.changes[0].to, "1.1.0.0");
    assert.match(readFileSync(join(root, "Base", "app.json"), "utf8"), /"1\.0\.0\.0"/);
    updateVersions(repo, { projects: ["Base"], bump: "minor" });
    const base = readFileSync(join(root, "Base", "app.json"), "utf8");
    assert.equal(base.charCodeAt(0), 0xfeff);
    assert.ok(base.includes("\r\n"));
    assert.equal(JSON.parse(base.slice(1)).version, "1.1.0.0");
    const ext = JSON.parse(readFileSync(join(root, "Ext", "app.json"), "utf8").slice(1));
    assert.equal(ext.dependencies[0].version, "1.1.0.0");
  });

  it("derives analyzers from AL-Go project type", () => {
    const r2 = mkdtempSync(join(tmpdir(), "bc-whale-algo-"));
    try {
      mkdirSync(join(r2, ".git"));
      mkdirSync(join(r2, ".github"));
      writeFileSync(join(r2, ".github", "AL-Go-Settings.json"), JSON.stringify({ type: "AppSource App", enableCodeCop: true, failOn: "warning" }));
      mkdirSync(join(r2, ".AL-Go"));
      writeFileSync(join(r2, ".AL-Go", "settings.json"), JSON.stringify({ appFolders: ["App"] }));
      app("App", r2, "A", ids.base);
      const cfg = loadConfig(loadRepo(r2));
      assert.deepEqual(cfg.analyzers?.sort(), ["AppSourceCop", "CodeCop"]);
      assert.equal(cfg.failOn, "warning");
    } finally {
      rmSync(r2, { recursive: true, force: true });
    }
  });

  it("plans a narrow rebuild including dependents and detects deleted inputs and outputs", async () => {
    const modulePath = "./loop.js";
    const { captureInputs, affectedProjects } = await import(modulePath);
    const repo = loadRepo(root);
    writeFileSync(join(root, "Ext", "a.al"), "codeunit 50100 A {}\n");
    const cfg = loadConfig(repo);
    const before = captureInputs(repo, cfg, "tool-v1");
    assert.deepEqual(affectedProjects(repo, before, before), []);
    writeFileSync(join(root, "Ext", "a.al"), "codeunit 50100 B {}\n");
    const changed = captureInputs(repo, cfg, "tool-v1");
    assert.deepEqual(affectedProjects(repo, before, changed).map((p: { app: { name: string } }) => p.app.name), ["Ext", "Ext Test"]);
    rmSync(join(root, "Ext", "a.al"));
    assert.equal(affectedProjects(repo, changed, captureInputs(repo, cfg, "tool-v1")).length, 2);
    assert.equal(affectedProjects(repo, before, captureInputs(repo, cfg, "tool-v2")).length, 3);
    writeFileSync(join(root, "main.ruleset.json"), JSON.stringify({ name: "main", includedRuleSets: [{ path: "included.ruleset.json", action: "Default" }] }));
    writeFileSync(join(root, "included.ruleset.json"), '{"name":"before"}');
    const rulesCfg = { ...cfg, ruleset: join(root, "main.ruleset.json") };
    const rulesBefore = captureInputs(repo, rulesCfg, "tool-v1");
    writeFileSync(join(root, "included.ruleset.json"), '{"name":"after"}');
    assert.equal(affectedProjects(repo, rulesBefore, captureInputs(repo, rulesCfg, "tool-v1")).length, 3);
    const commonBefore = captureInputs(repo, cfg, "tool-v1");
    writeFileSync(join(root, "shared.js"), "shared control add-in resource");
    assert.equal(affectedProjects(repo, commonBefore, captureInputs(repo, cfg, "tool-v1")).length, 3);
  });

  it("does not mistake analyzerFolder for a built-in analyzer", () => {
    mkdirSync(join(root, "Ext", ".vscode"), { recursive: true });
    writeFileSync(join(root, "Ext", ".vscode", "settings.json"), JSON.stringify({ "al.codeAnalyzers": ["${CodeCop}", "${analyzerFolder}Custom.dll"] }));
    const cfg = loadConfig(loadRepo(root));
    assert.deepEqual(cfg.analyzers, ["CodeCop"]);
    assert.ok(cfg.customAnalyzers?.some((p) => p.includes("${analyzerFolder}Custom.dll")));
  });
});

describe("helpers", () => {
  it("runs the Azure CLI batch launcher on Windows without spawn EINVAL", { skip: process.platform !== "win32" }, async () => {
    const { getAdminToken } = await import("./cloud.js");
    const root = mkdtempSync(join(tmpdir(), "bc-whale-azure-cli-"));
    const names = ["PATH", "BC_ACCESS_TOKEN", "BC_WHALE_CLIENT_ID", "BC_WHALE_CLIENT_SECRET"];
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      writeFileSync(join(root, "az.cmd"), "@echo off\r\necho bc-whale-fixture-token\r\n");
      process.env.PATH = `${root};${process.env.PATH}`;
      for (const name of names.slice(1)) delete process.env[name];
      assert.equal(await getAdminToken(), "bc-whale-fixture-token");
    } finally {
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe("MCP registration", () => {
    it("registers selected official remote servers without replacing existing entries", () => {
      const root = mkdtempSync(join(tmpdir(), "bc-whale-mcp-"));
      try {
        mkdirSync(join(root, ".git"));
        app("App", root, "A", ids.base);
        const path = join(root, ".vscode", "mcp.json");
        mkdirSync(join(root, ".vscode"));
        writeFileSync(path, JSON.stringify({ servers: { existing: { type: "http", url: "https://example.test/mcp" } } }));

        const result = registerMcp({
          repo: root,
          hosts: ["repo"],
          almcp: true,
          businessCentral: {
            tenantId: "tenant-id",
            environmentName: "Sandbox",
            company: "CRONUS",
            configurationName: "Sales",
          },
          azureDevOpsOrganization: "contoso",
          graphEnterprise: true,
        });

        const config = JSON.parse(readFileSync(path, "utf8"));
        assert.deepEqual(result.written[0].servers, ["bc_whale", `almcp-${basename(root)}`, "businesscentral", "azure-devops-contoso", "microsoft-graph-enterprise"]);
        assert.equal(config.servers.existing.url, "https://example.test/mcp");
        assert.equal(config.servers.businesscentral.type, "http");
        assert.equal(config.servers.businesscentral.url, "https://mcp.businesscentral.dynamics.com");
        assert.deepEqual(config.servers.businesscentral.headers, {
          TenantId: "tenant-id",
          EnvironmentName: "Sandbox",
          Company: "CRONUS",
          ConfigurationName: "Sales",
        });
        assert.equal(config.servers["azure-devops-contoso"].url, "https://mcp.dev.azure.com/contoso");
        assert.equal(config.servers["microsoft-graph-enterprise"].url, "https://mcp.svc.cloud.microsoft/enterprise");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
  it("builds official troubleshooting proxy args without confusing API and developer ports", async () => {
    const modulePath = "./troubleshoot.js";
    const { proxyArguments } = await import(modulePath);
    const connection = { args: ["--server", "http://localhost", "--serverinstance", "BC", "--environmenttype", "OnPrem", "--port", "7049"], env: {}, launch: {}, summary: "test" };
    const profile = proxyArguments("profile", connection, "C:\\profiles", 7047);
    assert.equal(profile[0], "launchprofilingmcpproxy");
    assert.equal(profile[profile.indexOf("--port") + 1], "7047");
    assert.ok(!profile.includes("7049"));
    assert.ok(profile.includes("--profilefolder"));
    const snapshot = proxyArguments("snapshot", connection, "C:\\profiles", 7047);
    assert.equal(snapshot[0], "launchsnapshotmcpproxy");
    assert.ok(!snapshot.includes("--profilefolder"));
    assert.throws(() => proxyArguments("profile", connection, "C:\\profiles", 7049), /port/i);
  });
  it("requires a reproduced failure and fresh successful verification for a bugfix", async () => {
    const modulePath = "./fix.js";
    const { verifyFixEvidence } = await import(modulePath);
    assert.equal(verifyFixEvidence({ succeeded: true }, { succeeded: true }, true).succeeded, false);
    assert.equal(verifyFixEvidence({ succeeded: false }, { succeeded: true }, false).succeeded, false);
    assert.equal(verifyFixEvidence({ succeeded: false }, { succeeded: false }, true).succeeded, false);
    assert.equal(verifyFixEvidence({ succeeded: false }, { succeeded: true }, true).succeeded, true);
  });
  it("rejects a runtime bugfix selection without its own test apps before building or publishing", async () => {
    const { fixStart } = await import("./api.js");
    const root = mkdtempSync(join(tmpdir(), "bc-whale-fix-selection-"));
    try {
      mkdirSync(join(root, ".git")); app("App", root, "A", ids.base);
      writeFileSync(join(root, "bc-whale.json"), JSON.stringify({ customAnalyzers: ["Missing.dll"] }));
      await assert.rejects(fixStart({ repo: root, issue: "Runtime regression", projects: ["A"], target: "probe" }), /No test apps in the selected bugfix scope/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("resolves analyzer placeholders and provisions an explicitly selected local suite", async () => {
    const modulePath = "./analyzers.js";
    const { resolveAnalyzers, provisionAnalyzers } = await import(modulePath);
    const root = mkdtempSync(join(tmpdir(), "bc-whale-analyzers-"));
    try {
      mkdirSync(join(root, ".git")); app("App", root, "A", ids.base);
      const bin = join(root, "compiler"); mkdirSync(bin);
      const source = join(root, "suite"); mkdirSync(source);
      writeFileSync(join(source, "ALCops.LinterCop.dll"), "fixture DLL");
      writeFileSync(join(source, "ALCops.Common.dll"), "companion");
      const repo = loadRepo(root), cfg = { ...loadConfig(repo), customAnalyzers: [join(root, "App", "${analyzerFolder}ALCops.LinterCop.dll")] };
      assert.equal(resolveAnalyzers(repo, cfg, bin).succeeded, false);
      const prepared = provisionAnalyzers(repo, source);
      assert.equal(prepared.files.length, 2);
      const result = resolveAnalyzers(repo, cfg, bin);
      assert.equal(result.succeeded, true);
      assert.equal(result.resolved.length, 1);
      assert.match(result.resolved[0].sha256, /^[a-f0-9]{64}$/);
      assert.ok(result.resolved[0].path.endsWith("ALCops.LinterCop.dll"));
      assert.equal(resolveAnalyzers(repo, { ...cfg, customAnalyzers: ["Missing.dll"] }, bin).succeeded, false);
      const { captureInputs } = await import("./loop.js");
      const before = captureInputs(repo, cfg, "tool");
      writeFileSync(join(prepared.destination, "ALCops.Common.dll"), "changed companion");
      assert.notEqual(captureInputs(repo, cfg, "tool").shared, before.shared);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("extracts trailing JSON after log output", () => {
    const text = 'Downloading...\n{ "x": 1 }\nmore log\n{\n  "succeeded": true,\n  "data": { "n": [1, 2] }\n}\n';
    assert.deepEqual(extractTrailingJson(text), { succeeded: true, data: { n: [1, 2] } });
    assert.equal(extractTrailingJson("no json here"), undefined);
  });

  it("bumps versions", () => {
    assert.equal(bumpVersion("29.0.3.7", "build"), "29.0.4.0");
    assert.equal(bumpVersion("29.1", "major"), "30.0.0.0");
  });

  it("compares versions numerically", () => {
    assert.ok(compareVersions("30.0.43.45776", "17.0.34") > 0);
    assert.ok(compareVersions("9.0", "10.0") < 0);
    assert.equal(compareVersions("1.0", "1.0.0.0"), 0);
  });

  it("parses artifact specs", () => {
    assert.deepEqual(parseArtifactSpec("sandbox/29/de"), { type: "sandbox", version: "29", country: "de" });
    assert.deepEqual(parseArtifactSpec("onprem/latest"), { type: "onprem", version: "latest", country: "w1" });
    assert.deepEqual(parseArtifactSpec("//*//latest".replace("//*//", "/*/"), "de"), { type: "sandbox", version: "latest", country: "de" });
    assert.deepEqual(parseArtifactSpec("29.0.54011.55816/de"), { type: "sandbox", version: "29.0.54011.55816", country: "de" });
    assert.deepEqual(parseArtifactSpec("https://x/sandbox/1/w1"), { url: "https://x/sandbox/1/w1" });
  });

  it("summarizes test results of unknown shape", () => {
    const s = summarizeTestJson({
      codeunits: [
        { codeunitId: 50100, testResults: [{ method: "A", result: "Success" }, { method: "B", result: "Failure", message: "boom", callStack: "x" }, { method: "C", result: "Skipped" }] },
      ],
    });
    assert.equal(s.passed, 1);
    assert.equal(s.failed, 1);
    assert.equal(s.skipped, 1);
    assert.equal(s.failures[0].message, "boom");
    assert.equal(s.failures[0].codeunit, 50100);
  });

  it("overrides env variables case-insensitively", () => {
    process.env.BC_WHALE_CASE_TEST = "a";
    const env = mergeEnv({ bc_whale_case_test: "b" });
    assert.deepEqual(Object.keys(env).filter((k) => k.toLowerCase() === "bc_whale_case_test"), ["bc_whale_case_test"]);
    delete process.env.BC_WHALE_CASE_TEST;
  });

  it("rejects unknown test outcomes rather than reporting zero failures", () => {
    assert.throws(() => summarizeTestJson({ tests: [{ methodName: "A", status: "pending" }] }), /outcome/i);
  });

  it("does not count a suite summary as a test method", () => {
    const s = summarizeTestJson({ name: "suite", status: "passed", results: [{ methodName: "A", status: "failed", output: "boom" }] });
    assert.equal(s.passed, 0);
    assert.equal(s.failed, 1);
    assert.equal(s.failures[0].message, "boom");
  });

  it("marks subprocess timeouts explicitly", async () => {
    const r = await exec(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { timeoutMs: 100 });
    assert.ok("timedOut" in r && r.timedOut);
    assert.notEqual(r.exitCode, 0);
  });

  it("terminates the timed-out Windows process tree", { skip: process.platform !== "win32" }, async () => {
    const root = mkdtempSync(join(tmpdir(), "bc-whale-timeout-tree-"));
    const started = join(root, "child-started");
    try {
      const childScript = `require('node:fs').writeFileSync(${JSON.stringify(started)},String(process.pid));setInterval(()=>{},1000)`;
      const parentScript = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});setTimeout(()=>{},60000)`;
      await exec(process.execPath, ["-e", parentScript], { timeoutMs: 600 });
      const { existsSync } = await import("node:fs");
      assert.equal(existsSync(started), true, "the child must actually have started");
      const pid = Number(readFileSync(started, "utf8"));
      assert.throws(() => process.kill(pid, 0), "the compiler child must be stopped before timeout returns");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("parses compiler info and file URIs without inventing warning severity", async () => {
    const m = await import("./build.js");
    assert.ok("parseDiagnostics" in m, "parseDiagnostics must be available");
    const parse = m.parseDiagnostics;
    assert.equal(typeof parse, "function");
    if (typeof parse !== "function") return;
    const root = mkdtempSync(join(tmpdir(), "bc-whale-diag-"));
    try {
      writeFileSync(join(root, "a.al"), "codeunit 50100 A {}\n");
      const { pathToFileURL } = await import("node:url");
      const d = parse({ issues: [{
        ruleId: "AL0603", shortMessage: "conversion", properties: { severity: "Info", helpLink: "https://learn.microsoft.com/example" },
        locations: [{ analysisTarget: [{ uri: pathToFileURL(join(root, "a.al")).href, region: { startLine: 1, startColumn: 3 } }] }],
      }] }, root, "A");
      assert.equal(d[0].severity, "Info");
      assert.equal(d[0].file, "a.al");
      assert.ok(d[0].source);
      assert.equal(d[0].source.text, "codeunit 50100 A {}");
      assert.match(d[0].source.sha256, /^[a-f0-9]{64}$/);
      assert.throws(() => parse({ issues: [{ ruleId: "AL1", properties: { severity: "Unexpected" } }] }, root, "A"), /severity/i);
      assert.throws(() => parse({}, root, "A"), /issues/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails empty, partial and unsuccessful test executions", async () => {
    const m = await import("./deploy.js");
    assert.ok("testExecutionSucceeded" in m);
    const ok = m.testExecutionSucceeded;
    assert.equal(typeof ok, "function");
    if (typeof ok !== "function") return;
    assert.equal(ok(0, { succeeded: true }, { passed: 0, failed: 0, skipped: 0 }, 1), false);
    assert.equal(ok(0, { succeeded: true }, { passed: 1, failed: 0, skipped: 0 }, 2), false);
    assert.equal(ok(1, { succeeded: true }, { passed: 1, failed: 0, skipped: 0 }, 1), false);
    assert.equal(ok(0, { succeeded: false }, { passed: 1, failed: 0, skipped: 0 }, 1), false);
    assert.equal(ok(0, { succeeded: true }, { passed: 1, failed: 0, skipped: 0 }, 1), true);
  });

  it("requires compiler success even when artifacts exist", async () => {
    const m = await import("./build.js");
    assert.ok("buildSucceeded" in m);
    assert.equal(m.buildSucceeded(1, true, [{ name: "A", path: "A", succeeded: true, errors: 0, warnings: 0, infos: 0 }]), false);
    assert.equal(m.buildSucceeded(0, false, []), false);
    assert.equal(m.buildSucceeded(0, true, []), false);
  });

  it("pages every diagnostic and identifies additions and removals", async () => {
    const { parseDiagnostics, readDiagnostics, diagnosticChanges } = await import("./build.js");
    const root = mkdtempSync(join(tmpdir(), "bc-whale-pages-"));
    try {
      mkdirSync(join(root, ".git"));
      app("App", root, "A", ids.base);
      const repo = loadRepo(root);
      const dir = join(root, ".bc-whale", "logs", "run1");
      mkdirSync(dir, { recursive: true });
      const diagnostics = parseDiagnostics({ issues: Array.from({ length: 205 }, (_, i) => ({
        ruleId: `AL${i}`, shortMessage: `message${i}`, properties: { severity: i % 2 ? "Info" : "Warning" },
      })) }, root, "A");
      const reportFile = join(dir, "diagnostics.json");
      writeFileSync(reportFile, JSON.stringify({ runId: "run1", complete: true, diagnostics }));
      writeFileSync(join(root, ".bc-whale", "latest-build.json"), JSON.stringify({ reportFile }));
      assert.equal(readDiagnostics(repo, { limit: 200 }).nextOffset, 200);
      assert.equal(readDiagnostics(repo, { offset: 200 }).diagnostics.length, 5);
      assert.equal(readDiagnostics(repo, { severity: "Info" }).total, 102);
      const changes = diagnosticChanges(diagnostics.slice(0, 2), diagnostics.slice(1, 3));
      assert.deepEqual(changes.resolved, [diagnostics[0].id]);
      assert.deepEqual(changes.added, [diagnostics[2].id]);
      assert.equal(changes.unchanged, 1);
      assert.throws(() => readDiagnostics(repo, { runId: "../escape" }), /runId/);
      assert.throws(() => readDiagnostics(repo, { limit: 0 }), /limit/);
      rmSync(join(root, ".bc-whale", "latest-build.json"));
      assert.equal(readDiagnostics(repo, { runId: "run1", limit: 1 }).diagnostics.length, 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does not assign a similarly prefixed app's diagnostics to its dependency", async () => {
    const m = await import("./build.js");
    assert.ok("findDiagnosticLog" in m);
    const find = m.findDiagnosticLog;
    assert.equal(typeof find, "function");
    if (typeof find !== "function") return;
    assert.equal(find("Base", ["Base_Test_20261105_120000.errorLog.json", "Base_20261105_115900.errorLog.json"]), "Base_20261105_115900.errorLog.json");
  });

  it("watches source edits without overlapping checks or looping on generated output", async () => {
    const modulePath = "./loop.js";
    const { watchChecks } = await import(modulePath);
    const root = mkdtempSync(join(tmpdir(), "bc-whale-watch-"));
    const controller = new AbortController();
    mkdirSync(join(root, ".bc-whale"));
    let calls = 0, active = 0, peak = 0;
    try {
      const watching = watchChecks(root, async () => {
        calls++; active++; peak = Math.max(peak, active);
        writeFileSync(join(root, ".bc-whale", "generated.json"), String(calls));
        if (calls === 1) writeFileSync(join(root, "a.al"), "changed during check");
        await new Promise((resolve) => setTimeout(resolve, 60));
        active--;
        return { succeeded: true };
      }, { debounceMs: 20, signal: controller.signal, onResult: () => { if (calls === 2) controller.abort(); } });
      const timeout = setTimeout(() => controller.abort(), 1500);
      await watching;
      clearTimeout(timeout);
      assert.equal(calls, 2);
      assert.equal(peak, 1);
    } finally { controller.abort(); rmSync(root, { recursive: true, force: true }); }
  });
});
