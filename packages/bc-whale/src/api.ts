import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAltool, runAltool, compareVersions } from "./altool.js";
import { build, readDiagnostics, type Diagnostic, type BuildOptions, writeWorkspace } from "./build.js";
import { captureInputs, check as checkInputs } from "./loop.js";
import { verifyFixEvidence } from "./fix.js";
import { proxyArguments, type ProxyKind } from "./troubleshoot.js";
import { analyzeProfileFileAsync } from "./profile-analysis.js";
import { collectProfile, createProfileBudget, readCapture, scheduleProfile } from "./profiling.js";
import { provisionAnalyzers, resolveAnalyzers } from "./analyzers.js";
import { cloud } from "./cloud.js";
import { editJsonFile, forgetContainerTarget, loadConfig, resolveTargetName, saveTarget, type EffectiveConfig, type Target, USER_CONFIG, workDir } from "./config.js";
import { publish, type PublishOptions, runTests, type TestOptions } from "./deploy.js";
import * as dockerOps from "./docker.js";
import { exec, mergeEnv, type Logger, silentLogger } from "./exec.js";
import { loadRepo, selectProjects, type RepoModel } from "./repo.js";
import { downloadSymbols, outputDir, packageCacheDir } from "./symbols.js";
import { resolveConnection } from "./targets.js";
import { updateVersions, type VersionOptions, writeLaunchConfigs } from "./workspace.js";
import { createTestBudget } from "./test-control.js";
export { validateLifecycle } from "./lifecycle.js";

export interface Ctx {
  repo?: string;
  log?: Logger;
}

const here = dirname(fileURLToPath(import.meta.url));
export const CLI_JS = join(here, "cli.js");
export const MCP_JS = join(here, "mcp.js");

function open(ctx: Ctx) {
  const repo = loadRepo(ctx.repo ?? process.env.BC_WHALE_REPO ?? process.cwd());
  if (!repo.projects.length) throw new Error(`No AL projects (app.json) found under ${repo.root}. Pass the repository path.`);
  return { repo, cfg: loadConfig(repo), log: ctx.log ?? silentLogger };
}

async function connectionFor(ctx: Ctx, targetName?: string) {
  const { repo, cfg, log } = open(ctx);
  const { name, target } = resolveTargetName(cfg, targetName);
  return { repo, cfg, log, name, target, connection: await resolveConnection(target) };
}

// ---------------- info / doctor ----------------

export async function info(ctx: Ctx) {
  const { repo, cfg } = open(ctx);
  const cache = packageCacheDir(repo);
  const out = outputDir(repo);
  return {
    root: repo.root,
    discovery: repo.discovery,
    workspaceFile: repo.workspaceFile,
    buildOrder: repo.levels.map((lvl, i) => ({ level: i, projects: lvl.map((p) => p.app.name) })),
    projects: repo.projects.map((p) => ({
      name: p.app.name,
      id: p.app.id,
      publisher: p.app.publisher,
      version: p.app.version,
      application: p.app.application,
      runtime: p.app.runtime,
      path: p.relPath,
      isTest: p.isTest,
      dependsOn: p.localDependencies.map((d) => repo.projects.find((x) => x.app.id === d)?.app.name),
      externalDependencies: p.externalDependencies.map((d) => `${d.publisher} ${d.name} ${d.version}`),
      built: existsSync(join(out, `${p.app.publisher}_${p.app.name}_${p.app.version}.app`)),
    })),
    config: {
      country: cfg.country,
      analyzers: cfg.analyzers,
      ruleset: cfg.ruleset,
      customAnalyzers: cfg.customAnalyzers,
      failOn: cfg.failOn,
      nugetFeeds: cfg.nugetFeeds,
      defaultTarget: cfg.defaultTarget,
      sources: cfg.sources,
    },
    targets: Object.fromEntries(Object.entries(cfg.targets).map(([k, v]) => [k, v])),
    packageCache: { path: cache, packages: readdirSync(cache).filter((f) => f.endsWith(".app")).length },
    output: out,
  };
}

export async function doctor() {
  const checks: { check: string; ok: boolean; optional?: boolean; detail: string; fix?: string }[] = [];
  const add = (check: string, ok: boolean, detail: string, fix?: string, optional = false) => checks.push({ check, ok, ...(optional ? { optional } : {}), detail, ...(ok ? {} : { fix }) });
  try {
    const t = await resolveAltool();
    const ok = compareVersions(t.version, "17.0") >= 0;
    add("altool", ok, `${t.version} (${t.source}) ${t.path}`, "Update the AL Language extension (workspace compile, runtests, listtests need a current altool).");
    if (compareVersions(t.version, "30.0") < 0) add("altool features", false, `altool ${t.version} lacks runtests/listtests/downloadsymbols`, "Install AL extension >= 30 or 'dotnet tool update -g microsoft.dynamics.businesscentral.development.tools --prerelease'.");
  } catch (e: any) {
    add("altool", false, e.message, "Install the AL Language extension for VS Code.");
  }
  const globalAl = await exec("al", ["--version"], { stream: false }).catch(() => undefined);
  if (globalAl?.exitCode === 0) {
    const v = globalAl.stdout.trim().split("+")[0];
    const current = (await resolveAltool().catch(() => undefined))?.version ?? v;
    add("dotnet tool 'al'", compareVersions(v, current) >= 0, `${v}`, "Outdated global tool - update with 'dotnet tool update -g microsoft.dynamics.businesscentral.development.tools --prerelease' (bc-whale uses the newest altool anyway).", true);
  }
  add("node", parseInt(process.versions.node, 10) >= 20, process.versions.node, "Install Node.js 20+.");
  const dockerV = await exec("docker", ["version", "--format", "{{.Server.Os}} {{.Server.Version}}"], { stream: false }).catch(() => undefined);
  add("docker", dockerV?.exitCode === 0 && dockerV.stdout.includes("windows"), dockerV?.exitCode === 0 ? dockerV.stdout.trim() : "not available", "Install Docker (Windows containers) for local BC containers - or use cloud sandboxes.", true);
  const az = await exec(process.platform === "win32" ? "az.cmd" : "az", ["account", "show", "--query", "user.name", "-o", "tsv"], { stream: false }).catch(() => undefined);
  add("azure cli", az?.exitCode === 0, az?.exitCode === 0 ? `signed in as ${az.stdout.trim()}` : "not signed in", "Run 'az login' to manage BC online environments.", true);
  const git = await exec("git", ["--version"], { stream: false }).catch(() => undefined);
  add("git", git?.exitCode === 0, git?.stdout.trim() ?? "missing");
  add("user config", true, existsSync(USER_CONFIG) ? USER_CONFIG : `${USER_CONFIG} (not created yet)`);
  return { ok: checks.every((c) => c.ok || c.optional), checks };
}

// ---------------- life cycle ----------------

export async function symbols(ctx: Ctx & { projects?: string[]; target?: string; fromTarget?: boolean; force?: boolean; copyToProjects?: boolean }) {
  const { repo, cfg, log } = open(ctx);
  const connection = ctx.fromTarget ? (await connectionFor(ctx, ctx.target)).connection : undefined;
  return downloadSymbols(repo, cfg, { projects: ctx.projects, connection, force: ctx.force, copyToProjects: ctx.copyToProjects, log });
}

export async function compile(ctx: Ctx & BuildOptions) {
  const { repo, cfg, log } = open(ctx);
  return build(repo, cfg, { ...ctx, log });
}

export async function check(ctx: Ctx & BuildOptions & { force?: boolean }) {
  const { repo, cfg, log } = open(ctx);
  return checkInputs(repo, cfg, { ...ctx, log });
}

export async function diagnostics(ctx: Ctx & { runId?: string; offset?: number; limit?: number; severity?: Diagnostic["severity"]; project?: string }) {
  return readDiagnostics(open(ctx).repo, ctx);
}

export async function analyzers(ctx: Ctx & { source?: string }) {
  const { repo, cfg } = open(ctx);
  const prepared = ctx.source ? provisionAnalyzers(repo, resolve(ctx.source)) : undefined;
  return { ...resolveAnalyzers(repo, cfg, dirname((await resolveAltool()).path)), prepared };
}

interface FixSession {
  id: string;
  issue: string;
  projects: string[];
  target?: string;
  codeunits?: string[];
  methods?: string[];
  baseline: { succeeded: boolean; reportFile: string; test?: Awaited<ReturnType<typeof test>> };
  inputs: ReturnType<typeof captureInputs>;
}

async function captureFixInputs(repo: RepoModel, cfg: EffectiveConfig) {
  const tool = await resolveAltool();
  const resolution = resolveAnalyzers(repo, cfg, dirname(tool.path));
  if (!resolution.succeeded) throw new Error(`Configured analyzers missing: ${resolution.missing.join(", ")}. ${resolution.hint}`);
  return captureInputs(repo, cfg, JSON.stringify(tool), [tool.path, ...resolution.resolved.map((a) => a.path)]);
}

export async function fixStart(ctx: Ctx & { issue: string; projects: string[]; target?: string; codeunits?: string[]; methods?: string[] }) {
  if (!ctx.issue.trim() || !ctx.projects.length) throw new Error("A concrete issue and explicit projects are required.");
  const { repo, cfg } = open(ctx);
  const selected = selectProjects(repo, ctx.projects, { includeDependents: true });
  if (ctx.target && !selected.some((p) => p.isTest)) throw new Error("No test apps in the selected bugfix scope. Add a regression test app before selecting a runtime target.");
  const inputs = await captureFixInputs(repo, cfg);
  const b = await compile({ ...ctx, projects: selected.map((p) => p.app.id), failOn: "warning", maxDiagnostics: 50 });
  if (!b.complete || b.timedOut) throw new Error(`Baseline incomplete: ${b.reportFile}. Resolve infrastructure failures before recording a bug.`);
  if (!b.succeeded && !b.projects.some((p) => p.errors > 0 || p.warnings > 0)) throw new Error(`Compiler process failed without actionable diagnostics: ${b.reportFile}. This is not a reproduced code defect.`);
  let t: Awaited<ReturnType<typeof test>> | undefined;
  if (b.succeeded && ctx.target) {
    const p = await deploy({ ...ctx, projects: selected.map((p) => p.app.id) });
    if (!p.succeeded) throw new Error("Baseline deployment failed; inspect the target before retrying.");
    t = await test({ ...ctx, projects: selected.filter((p) => p.isTest).map((p) => p.app.id) });
    if (!t.projects.some((p) => (p.failed ?? 0) > 0)) throw new Error("No failing test was reproduced; empty/discovery/infrastructure failures are not a bug baseline.");
  }
  const baseline = { succeeded: b.succeeded && (t?.succeeded ?? true), reportFile: b.reportFile, test: t };
  if (baseline.succeeded) throw new Error("No failing diagnostics or tests reproduced. Add a regression test or select the correct scenario.");
  const reproduced = await captureFixInputs(repo, cfg);
  if (inputs.shared !== reproduced.shared || JSON.stringify(inputs.sources) !== JSON.stringify(reproduced.sources)) throw new Error("Inputs changed during reproduction; rerun fix start after symbol downloads or source edits have finished.");
  const id = randomUUID();
  const session: FixSession = { id, issue: ctx.issue, projects: selected.map((p) => p.app.id), target: ctx.target, codeunits: ctx.codeunits, methods: ctx.methods, baseline, inputs };
  const file = join(workDir(repo, "fixes"), `${id}.json`);
  writeFileSync(file, JSON.stringify(session, null, 2));
  return { succeeded: true, id, file, baseline, diagnostics: b.diagnostics, next: "Use source evidence and AL MCP symbol relations to implement the smallest correction, then call bc_whale_fix_verify with this id. Never suppress rules merely to pass." };
}

export async function fixVerify(ctx: Ctx & { id: string }) {
  if (!/^[a-f0-9-]{36}$/i.test(ctx.id)) throw new Error("Invalid fix id");
  const { repo, cfg } = open(ctx);
  const file = join(workDir(repo, "fixes"), `${ctx.id}.json`);
  const session: FixSession = JSON.parse(readFileSync(file, "utf8"));
  const before = await captureFixInputs(repo, cfg);
  const changed = session.projects.filter((id) => session.inputs.sources[id] !== before.sources[id]);
  if (session.inputs.shared !== before.shared) throw new Error("Shared configuration/resources changed; reproduce a new baseline to prevent bypassing analyzers/rules.");
  const b = await compile({ ...ctx, projects: session.projects, failOn: "warning", maxDiagnostics: 50 });
  let t: Awaited<ReturnType<typeof test>> | undefined;
  if (b.succeeded && session.target) {
    const p = await deploy({ ...ctx, projects: session.projects, target: session.target });
    if (!p.succeeded) return { succeeded: false, build: b, publish: p, message: "Fix deployment failed; no successful verification recorded." };
    const tests = selectProjects(repo, session.projects, { testsOnly: true }).map((p) => p.app.id);
    t = await test({ ...ctx, projects: tests, target: session.target, codeunits: session.codeunits, methods: session.methods });
  }

  const after = await captureFixInputs(repo, cfg);
  const stable = before.shared === after.shared && JSON.stringify(before.sources) === JSON.stringify(after.sources);
  const gate = verifyFixEvidence(session.baseline, { succeeded: b.succeeded && (t?.succeeded ?? true) && stable }, changed.length > 0);
  const result = { ...gate, id: session.id, issue: session.issue, changedProjects: changed, build: b, test: t, baseline: session.baseline, verifiedAt: new Date().toISOString(), scope: session.target ? "compile-publish-test" : "diagnostics-only; runtime behavior not verified" };
  const reportFile = join(workDir(repo, "fixes"), `${ctx.id}.verification.json`);
  writeFileSync(reportFile, JSON.stringify(result, null, 2));
  return { ...result, reportFile };
}

export async function troubleshootingProxy(ctx: Ctx & { target: string; kind: ProxyKind; apiPort?: number; allowProduction?: boolean }) {
  const { repo, connection, target } = await connectionFor(ctx, ctx.target);
  if (target.type === "cloud" && target.environmentType === "Production" && !ctx.allowProduction) throw new Error("Production troubleshooting requires explicit allowProduction.");
  const tool = await resolveAltool();
  const command = ctx.kind === "profile" ? "launchprofilingmcpproxy" : "launchsnapshotmcpproxy";
  const help = await runAltool([command, "--help"], { stream: false });
  if (help.exitCode !== 0 || !help.output.includes(command)) throw new Error(`Installed altool does not support ${command}. Update the AL extension.`);
  const args = proxyArguments(ctx.kind, connection, workDir(repo, "profiles"), ctx.apiPort);
  return { command: tool.path, args, cwd: repo.root, env: connection.env };
}

async function profileTarget(ctx: Ctx & { target: string; apiPort?: number; allowProduction?: boolean; signal?: AbortSignal }) {
  ctx.signal?.throwIfAborted();
  if (!ctx.target?.trim()) throw new Error("Profiling requires an explicit target.");
  const { repo, cfg, log } = open(ctx);
  const { target } = resolveTargetName(cfg, ctx.target);
  if (target.type === "cloud" && target.environmentType === "Production" && !ctx.allowProduction) throw new Error("Production profiling requires explicit allowProduction on schedule and collect.");
  const identity = target.type === "cloud"
    ? { type: target.type, environmentName: target.environmentName, environmentType: target.environmentType ?? "Sandbox", tenant: target.tenant }
    : target.type === "docker" ? { type: target.type, container: target.container }
      : { type: target.type, server: target.server, serverInstance: target.serverInstance ?? "BC", tenant: target.tenant, authentication: target.authentication ?? "UserPassword" };
  const targetFingerprint = createHash("sha256").update(JSON.stringify({ identity, apiPort: ctx.apiPort })).digest("hex");
  const connection = await resolveConnection(target, ctx.signal);
  const tool = await resolveAltool(ctx.signal);
  ctx.signal?.throwIfAborted();
  return {
    root: workDir(repo, "profiles", "captures"), target: ctx.target, targetFingerprint, log,
    proxy: {
      command: tool.path, args: proxyArguments("profile", connection, workDir(repo, "profiles"), ctx.apiPort),
      cwd: repo.root,
      env: Object.fromEntries(Object.entries(mergeEnv(connection.env)).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    },
  };
}

export async function profileSchedule(ctx: Ctx & {
  target: string; sessionId: number; authorizedSession: boolean; allowProduction?: boolean; apiPort?: number;
  durationSeconds?: number; samplingIntervalMs?: number; profileCreationThresholdMs?: number; description?: string;
  timeoutMs?: number; signal?: AbortSignal;
}) {
  if (!ctx.authorizedSession) throw new Error("Profiling requires explicit authorization for the selected session.");
  const b = createProfileBudget(ctx.timeoutMs ?? 60_000, ctx.signal);
  try { return await scheduleProfile({ ...ctx, ...await profileTarget({ ...ctx, signal: b.signal }), signal: b.signal }); }
  catch (error) { return profilePreparationFailure(error, b.signal); }
  finally { b.dispose(); }
}

export async function profileCollect(ctx: Ctx & { id: string; allowProduction?: boolean; timeoutMs?: number; signal?: AbortSignal }) {
  const b = createProfileBudget(ctx.timeoutMs ?? 180_000, ctx.signal);
  try {
    const { repo } = open(ctx);
    const state = readCapture(workDir(repo, "profiles", "captures"), ctx.id);
    return await collectProfile({ ...ctx, ...await profileTarget({ ...ctx, target: state.target, apiPort: state.apiPort, signal: b.signal }), signal: b.signal });
  } catch (error) { return { ...profilePreparationFailure(error, b.signal), id: ctx.id }; }
  finally { b.dispose(); }
}

function profilePreparationFailure(error: unknown, signal: AbortSignal) {
  const timedOut = signal.aborted && signal.reason instanceof Error && signal.reason.name === "TimeoutError";
  return { succeeded: false as const, timedOut, cancelled: signal.aborted && !timedOut, error: error instanceof Error ? error.message : String(error), phase: "preparation" };
}

export async function profileAnalyze(ctx: { file: string; top?: number; reportFile?: string; timeoutMs?: number; signal?: AbortSignal }) {
  const b = createProfileBudget(ctx.timeoutMs ?? 60_000, ctx.signal);
  try { return await analyzeProfileFileAsync(ctx.file, { ...ctx, signal: b.signal }); }
  finally { b.dispose(); }
}

export async function registerTroubleshooting(ctx: Ctx & { target: string; hosts?: McpHost[]; apiPort?: number; allowProduction?: boolean }) {
  // Validate capability and target now; credentials are never written to config.
  await troubleshootingProxy({ ...ctx, kind: "profile" });
  await troubleshootingProxy({ ...ctx, kind: "snapshot" });
  const root = open(ctx).repo.root;
  const written: { file: string; servers: string[] }[] = [];
  for (const host of ctx.hosts ?? ["copilot"]) {
    const { file, key } = mcpFileFor(host, root);
    const servers: string[] = [];
    for (const kind of ["profile", "snapshot"] as const) {
      const name = `bc-whale-${kind}-${basename(root)}-${ctx.target}`;
      const args = [CLI_JS, "debug", "proxy", "--kind", kind, "--target", ctx.target, "--repo", root];
      if (ctx.apiPort !== undefined) args.push("--api-port", String(ctx.apiPort));
      if (ctx.allowProduction) args.push("--allow-production");
      editJsonFile(file, [key, name], host === "copilot" ? { type: "local", command: process.execPath, args, tools: ["*"] } : { type: "stdio", command: process.execPath, args });
      servers.push(name);
    }
    written.push({ file, servers });
  }
  return { succeeded: true, written, note: "Restart these MCP servers. Capture requires BC 2026 wave 2+ server capabilities/permissions and an explicitly selected session; registration does not start capture.", sources: ["https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-al-tool"] };
}

export async function deploy(ctx: Ctx & PublishOptions & { target?: string; withDeps?: boolean }) {
  const { repo, connection, log } = await connectionFor(ctx, ctx.target);
  const depsResult = ctx.withDeps ? await publishDepsFolder(ctx) : undefined;
  if (depsResult && !depsResult.succeeded) return { succeeded: false, target: connection.summary, apps: [], deps: depsResult };
  const r = await publish(repo, connection, { ...ctx, log });
  return depsResult ? { ...r, deps: depsResult } : r;
}

export async function test(ctx: Ctx & TestOptions & { target?: string }) {
  const budget = createTestBudget(ctx.timeoutMs, ctx.signal);
  const deadlineSignal = AbortSignal.timeout(budget.remaining());
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, deadlineSignal]) : deadlineSignal;
  const { repo, cfg, log } = open(ctx);
  const selected = selectProjects(repo, ctx.projects, { testsOnly: true });
  if (!selected.length) return { succeeded: false, phase: "build", message: "No test apps selected; nothing was run.", projects: [] };
  budget.remaining();
  log("Test preflight: fresh compile of selected test apps and dependencies; no publish.");
  const compiled = await build(repo, cfg, {
    projects: selected.map((p) => p.app.id), includeDependencies: true, failOn: "error",
    autoSymbols: false, timeoutMs: budget.remaining(), signal, log,
  });
  if (!compiled.succeeded || budget.cancelled() || budget.timedOut()) {
    return {
      succeeded: false, phase: "build", build: compiled, projects: [],
      timedOut: compiled.timedOut || budget.timedOut(), cancelled: budget.cancelled(),
      message: "Test preflight failed, cancelled or timed out. No tests or publish were started. Resolve diagnostics first; download missing symbols separately.",
    };
  }
  budget.remaining();
  const { connection } = await connectionFor(ctx, ctx.target);
  const result = await runTests(repo, connection, { ...ctx, log, signal, deadlineAt: budget.deadline });
  return { ...result, build: compiled, deploymentNote: "Fresh compilation does not publish. Tests execute the installed server version; use cycle build,publish,test for source corrections." };
}

/** Install missing external dependencies (and the test toolkit) on the target. */
export async function deps(ctx: Ctx & { target?: string; projects?: string[]; testToolkit?: boolean; apps?: string[] }) {
  const { repo, log, target, name } = await connectionFor(ctx, ctx.target);
  const projects = selectProjects(repo, ctx.projects);
  const external = new Map<string, { id: string; name: string; publisher: string; version: string }>();
  for (const p of projects) for (const d of p.externalDependencies) external.set(d.id || d.name, d);
  const wantToolkit = ctx.testToolkit ?? projects.some((p) => p.isTest);
  if (target.type === "docker") {
    const names = new Set<string>(ctx.apps ?? []);
    for (const d of external.values()) if (d.publisher === "Microsoft") names.add(d.name);
    if (wantToolkit) for (const n of dockerOps.TEST_TOOLKIT_APPS) names.add(n);
    const nonMicrosoft = [...external.values()].filter((d) => d.publisher !== "Microsoft").map((d) => `${d.publisher} ${d.name} ${d.version}`);
    const r = await dockerOps.installArtifactApps(target.container, [...names], log);
    return {
      target: name,
      ...r,
      succeeded: r.failed.length === 0,
      notInArtifact: nonMicrosoft.length ? nonMicrosoft : undefined,
      hint: nonMicrosoft.length ? "Non-Microsoft dependencies are not part of the BC artifact. Provide runtime .app files in .bc-whale/deps (published automatically by 'bc-whale publish --with-deps') or publish them manually." : undefined,
    };
  }
  if (target.type === "cloud") {
    const installed: any[] = await cloud.listApps(target.environmentName, { tenant: target.tenant });
    const have = new Set(installed.filter((a) => a.state === "Installed").map((a) => String(a.id).toLowerCase()));
    const results: any[] = [];
    for (const d of external.values()) {
      if (!d.id || have.has(d.id) || d.publisher === "Microsoft") continue;
      try {
        const r = await cloud.installApp(target.environmentName, d.id, { tenant: target.tenant });
        results.push({ app: `${d.publisher} ${d.name}`, scheduled: true, operation: r?.id });
      } catch (e: any) {
        results.push({ app: `${d.publisher} ${d.name}`, scheduled: false, error: e.message });
      }
    }
    return { succeeded: results.every((r) => r.scheduled), target: name, results, note: "Installs are scheduled, not confirmed complete. " + (wantToolkit ? "Test libraries must be available in the online sandbox; BC online cannot install them from artifacts." : "") };
  }
  return { succeeded: external.size === 0, target: name, external: [...external.values()], note: "On-prem targets: install these dependencies with your server tooling." };
}

/** Publish runtime .app files placed in .bc-whale/deps (non-Microsoft dependencies) before publishing the repo apps. */
export async function publishDepsFolder(ctx: Ctx & { target?: string; timeoutMs?: number }) {
  const { repo, connection, log } = await connectionFor(ctx, ctx.target);
  const folder = workDir(repo, "deps");
  const files = readdirSync(folder).filter((f) => f.toLowerCase().endsWith(".app"));
  const results = [];
  for (const f of files) {
    const r = await runAltool<any>(["publishapp", join(folder, f), ...connection.args, "--schemaupdatemode", "Synchronize"], { log, env: connection.env, timeoutMs: ctx.timeoutMs ?? 600_000 });
    results.push({ file: f, succeeded: r.exitCode === 0 && r.json?.succeeded !== false, exitCode: r.exitCode, timedOut: r.timedOut, message: r.json?.message ?? (r.exitCode === 0 ? undefined : r.output) });
    if (r.exitCode !== 0 || r.json?.succeeded === false) break;
  }
  return { succeeded: results.every((r) => r.succeeded), folder, results };
}

export interface CycleOptions extends Ctx {
  target?: string;
  projects?: string[];
  steps?: ("symbols" | "build" | "deps" | "publish" | "test")[];
  codeunits?: string[];
  methods?: string[];
  analyzers?: string[];
  failOn?: "none" | "error" | "warning";
  forceSymbols?: boolean;
  schemaUpdateMode?: "Synchronize" | "ForceSync" | "Recreate";
  incremental?: boolean;
  timeoutMs?: number;
}

/** The inner dev loop in one call: symbols -> build -> deps -> publish -> test. Stops at the first failing step. */
export async function cycle(o: CycleOptions) {
  const steps = o.steps ?? ["symbols", "build", "publish", "test"];
  const result: Record<string, unknown> = {};
  const started = Date.now();
  let ok = true;
  if (steps.includes("symbols")) {
    const { repo } = open(o);
    const empty = !readdirSync(packageCacheDir(repo)).some((f) => f.endsWith(".app"));
    if (empty || o.forceSymbols) {
      const s = await symbols({ ...o, force: o.forceSymbols });
      result.symbols = s;
      ok = s.projects.every((p) => p.succeeded);
    } else result.symbols = { skipped: "package cache present (use forceSymbols to refresh)" };
  }
  if (ok && steps.includes("build")) {
    const b = o.incremental ? await check(o) : await compile({ ...o, includeDependencies: true });
    result.build = b;
    ok = b.succeeded;
  }
  if (ok && steps.includes("deps")) {
    const d = await deps(o);
    result.deps = d;
    ok = d.succeeded;
  }
  if (ok && steps.includes("publish")) {
    const p = await deploy({ ...o, includeDependencies: true, withDeps: steps.includes("deps") });
    result.publish = p;
    ok = p.succeeded;
  }
  if (ok && steps.includes("test")) {
    const t = await test({ ...o, projects: testProjectsFor(o) });
    result.test = t;
    ok = t.succeeded;
  }
  return { succeeded: ok, durationMs: Date.now() - started, ...result };
}

/** Tests relevant for a selection: selected test apps, or test apps that depend on selected apps. */
function testProjectsFor(o: CycleOptions): string[] | undefined {
  if (!o.projects?.length) return undefined;
  const { repo } = open(o);
  return selectProjects(repo, o.projects, { includeDependents: true, testsOnly: true }).map((p) => p.app.id);
}

export async function version(ctx: Ctx & VersionOptions) {
  const { repo } = open(ctx);
  return updateVersions(repo, ctx);
}

export async function launch(ctx: Ctx & { target?: string; projects?: string[] }) {
  const { repo, name, target, connection } = await connectionFor(ctx, ctx.target);
  return writeLaunchConfigs(repo, name, target, connection, { projects: ctx.projects });
}

export async function map(ctx: Ctx) {
  const { repo, log } = open(ctx);
  const ws = writeWorkspace(repo, repo.projects);
  const file = join(workDir(repo), "workspace-map.md");
  await runAltool(["workspace", "map", ws, file], { log });
  return { file, markdown: existsSync(file) ? readFileSync(file, "utf8") : undefined };
}

export async function altoolRaw(ctx: Ctx & { args: string[] }) {
  const r = await runAltool(ctx.args, { log: ctx.log, cwd: ctx.repo });
  return { exitCode: r.exitCode, json: r.json, output: r.json ? undefined : r.output.slice(-20000) };
}

// ---------------- targets ----------------

export function targetAdd(ctx: Ctx & { name: string; target: Target; scope?: "repo" | "user"; makeDefault?: boolean }) {
  const root = loadRepo(ctx.repo ?? process.cwd()).root;
  const file = saveTarget(ctx.scope ?? "user", root, ctx.name, ctx.target, ctx.makeDefault);
  return { saved: ctx.name, file };
}

export function targetRemove(ctx: Ctx & { name: string; scope?: "repo" | "user" }) {
  const root = loadRepo(ctx.repo ?? process.cwd()).root;
  return { removed: ctx.name, file: saveTarget(ctx.scope ?? "user", root, ctx.name, undefined) };
}

export async function targetCheck(ctx: Ctx & { target?: string }) {
  const { name, connection } = await connectionFor(ctx, ctx.target);
  return { target: name, summary: connection.summary, args: connection.args, credentialsProvided: Object.keys(connection.env) };
}

// ---------------- containers & cloud ----------------

export const containers = {
  list: () => dockerOps.listContainers(),
  create: async (o: dockerOps.CreateContainerOptions & { repo?: string; registerTarget?: boolean; makeDefault?: boolean }) => {
    const r = await dockerOps.createContainer(o);
    if (o.registerTarget ?? true) {
      const root = loadRepo(o.repo ?? process.cwd()).root;
      saveTarget("user", root, o.name, { type: "docker", container: o.name }, o.makeDefault);
    }
    return r;
  },
  wait: (name: string, log?: Logger) => dockerOps.waitForContainer(name, { log }).then(() => dockerOps.inspectContainer(name)),
  action: async (name: string, action: Parameters<typeof dockerOps.containerAction>[1]) => {
    const r = await dockerOps.containerAction(name, action);
    return action === "remove" ? { ...r, targetRemoved: forgetContainerTarget(name) } : r;
  },
  logs: dockerOps.containerLogs,
  installApps: dockerOps.installArtifactApps,
  installedApps: dockerOps.listInstalledApps,
  importLicense: dockerOps.importLicense,
  setCredential: async (name: string, username: string, password: string) => {
    await dockerOps.saveContainerCredential(name, { username, password });
    return { name, username, stored: true };
  },
  artifact: (spec: string, country?: string) => dockerOps.resolveArtifactUrl(spec, country),
};

export { cloud };

// ---------------- MCP registration ----------------

export type McpHost = "copilot" | "vscode" | "repo";

function mcpFileFor(host: McpHost, repoRoot: string) {
  if (host === "copilot") return { file: join(homedir(), ".copilot", "mcp-config.json"), key: "mcpServers" };
  if (host === "vscode") return { file: join(process.env.APPDATA ?? join(homedir(), ".config"), "Code", "User", "mcp.json"), key: "servers" };
  return { file: join(repoRoot, ".vscode", "mcp.json"), key: "servers" };
}

/**
 * Register the bc-whale MCP server (and optionally the official AL MCP server for a repo, started through
 * bc-whale so it always uses the newest altool and the shared .bc-whale package cache).
 */
export function registerMcp(ctx: Ctx & {
  hosts?: McpHost[];
  almcp?: boolean;
  name?: string;
  businessCentral?: { tenantId?: string; environmentName?: string; company?: string; configurationName?: string };
  azureDevOpsOrganization?: string;
  graphEnterprise?: boolean;
}) {
  const hosts = ctx.hosts ?? ["copilot"];
  const root = ctx.repo ? loadRepo(ctx.repo).root : undefined;
  const written: { host: McpHost; file: string; servers: string[] }[] = [];
  if (ctx.azureDevOpsOrganization !== undefined && !ctx.azureDevOpsOrganization.trim()) {
    throw new Error("Azure DevOps organization must not be empty.");
  }
  for (const host of hosts) {
    if (host === "repo" && !root) throw new Error("repo host requires a repository path");
    const { file, key } = mcpFileFor(host, root ?? "");
    const servers: string[] = [];
    const node = process.execPath;
    const entry = (args: string[]) =>
      host === "copilot" ? { type: "local", command: node, args, tools: ["*"] } : { type: "stdio", command: node, args };
    editJsonFile(file, [key, "bc_whale"], entry([MCP_JS]));
    servers.push("bc_whale");
    if (ctx.almcp && root) {
      const n = ctx.name ?? `almcp-${basename(root)}`;
      editJsonFile(file, [key, n], entry([CLI_JS, "almcp", "--repo", root]));
      servers.push(n);
    }
    if (ctx.businessCentral) {
      const { tenantId, environmentName, company, configurationName } = ctx.businessCentral;
      const headers = Object.fromEntries(
        Object.entries({
          TenantId: tenantId,
          EnvironmentName: environmentName,
          Company: company,
          ConfigurationName: configurationName,
        }).filter(([, value]) => value !== undefined),
      );
      editJsonFile(file, [key, "businesscentral"], {
        type: "http",
        url: "https://mcp.businesscentral.dynamics.com",
        ...(Object.keys(headers).length ? { headers } : {}),
      });
      servers.push("businesscentral");
    }
    if (ctx.azureDevOpsOrganization) {
      const organization = ctx.azureDevOpsOrganization.trim();
      const n = `azure-devops-${organization}`;
      editJsonFile(file, [key, n], {
        type: "http",
        url: `https://mcp.dev.azure.com/${encodeURIComponent(organization)}`,
      });
      servers.push(n);
    }
    if (ctx.graphEnterprise) {
      const n = "microsoft-graph-enterprise";
      editJsonFile(file, [key, n], { type: "http", url: "https://mcp.svc.cloud.microsoft/enterprise" });
      servers.push(n);
    }
    written.push({ host, file, servers });
  }
  return { written, note: "Reload the MCP servers / restart the agent session to pick up the change." };
}

/** Arguments for the official AL MCP server over all projects of a repo (used by `bc-whale almcp`). */
export function almcpArgs(repoPath: string): { args: string[]; cwd: string } {
  const repo: RepoModel = loadRepo(repoPath);
  const out = outputDir(repo);
  const cache = packageCacheDir(repo);
  const caches = [out, cache, ...repo.projects.map((p) => join(p.path, ".alpackages")).filter(existsSync)];
  return {
    cwd: repo.root,
    args: ["launchmcpserver", ...repo.projects.map((p) => resolve(p.path)), "--transport", "stdio", "--packagecachepath", caches.join(";"), "--outfolder", workDir(repo, "almcp"), "--disableTelemetry", "--logfile", join(workDir(repo, "logs"), "almcp.log")],
  };
}
