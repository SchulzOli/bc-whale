#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Command, Option } from "commander";
import * as api from "./api.js";
import { resolveAltool } from "./altool.js";
import type { Target } from "./config.js";
import { TEST_TOOLKIT_APPS } from "./docker.js";
import { mergeEnv, stderrLogger } from "./exec.js";
import { watchChecks } from "./loop.js";

const program = new Command();
program
  .name("bc-whale")
  .description("Business Central AL dev life cycle on top of altool - no BcContainerHelper.\nAll commands print JSON to stdout; progress goes to stderr.")
  .option("-r, --repo <path>", "repository (or any folder inside it); defaults to the current directory")
  .option("-q, --quiet", "suppress progress output");

const list = (v: string, prev: string[] = []) => prev.concat(v.split(",").map((s) => s.trim()).filter(Boolean));

function ctx<T extends object = {}>(extra?: T) {
  const g = program.opts();
  return { repo: g.repo as string | undefined, log: g.quiet ? undefined : stderrLogger, ...(extra as T) };
}

async function run(fn: () => Promise<unknown> | unknown) {
  try {
    const result: any = await fn();
    if (result !== undefined) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (result && (result.succeeded === false || result.ok === false)) process.exitCode = 1;
  } catch (e: any) {
    process.stderr.write(`error: ${e?.message ?? e}\n`);
    process.stdout.write(JSON.stringify({ succeeded: false, error: e?.message ?? String(e) }) + "\n");
    process.exitCode = 1;
  }
}

function runProfile(fn: (signal: AbortSignal) => Promise<unknown>) {
  return run(async () => {
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error("Profiling cancelled by Ctrl+C."));
    process.once("SIGINT", cancel);
    try { return await fn(controller.signal); }
    finally { process.removeListener("SIGINT", cancel); }
  });
}

const projectsOpt = () => new Option("-p, --projects <names>", "project names, folders, app ids or wildcards (comma separated)").argParser(list);
const targetOpt = () => new Option("-t, --target <name>", "target name (see 'bc-whale target list'); defaults to defaultTarget");
const positive = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error("Expected a positive integer");
  return n;
};
const timeoutOpt = () => new Option("--timeout-ms <n>", "maximum duration per compiler/publish/test process (default 600000)").argParser(positive);

program.command("doctor").description("check tools and prerequisites").action(() => run(() => api.doctor()));
program.command("info").description("projects, build order, dependencies, effective config and targets").action(() => run(() => api.info(ctx())));
program.command("validate").description("validate baseline -> persistent seed -> candidate upgrade -> data assertions on an explicitly authorized disposable target")
  .requiredOption("--baseline-repo <path>", "separate baseline repository")
  .requiredOption("-p, --projects <names>", "explicit production and test apps, no wildcards", list)
  .requiredOption("-t, --target <name>", "explicit disposable target")
  .requiredOption("--company <name>", "dedicated validation company")
  .requiredOption("--seed-codeunits <list>", "baseline seed test codeunits", list)
  .requiredOption("--seed-methods <list>", "baseline persistent seed methods", list)
  .requiredOption("--verify-codeunits <list>", "candidate verification codeunits", list)
  .requiredOption("--verify-methods <list>", "candidate data verification methods", list)
  .option("--authorized-disposable-target", "acknowledge authorization for installing fixture apps and persistent synthetic data")
  .addOption(timeoutOpt())
  .action((o) => run(() => api.validateLifecycle(ctx({
    baselineRepo: o.baselineRepo, projects: o.projects, target: o.target, company: o.company,
    seedCodeunits: o.seedCodeunits, seedMethods: o.seedMethods, verifyCodeunits: o.verifyCodeunits,
    verifyMethods: o.verifyMethods, authorizedDisposableTarget: o.authorizedDisposableTarget === true, timeoutMs: o.timeoutMs,
  }))));
program.command("map").description("mermaid dependency map of the repo (altool workspace map)").action(() => run(() => api.map(ctx())));
const analyzers = program.command("analyzers").description("resolve and provision all configured custom analyzers");
analyzers.command("status").action(() => run(() => api.analyzers(ctx())));
analyzers.command("prepare").requiredOption("--source <folder>", "trusted local ALCops suite folder, including companion DLLs")
  .action((o) => run(() => api.analyzers(ctx({ source: o.source }))));
const fix = program.command("fix").description("record reproduced bug and verify an agent's source correction");
fix.command("start").requiredOption("--issue <text>", "concrete symptom").addOption(projectsOpt()).addOption(targetOpt())
  .option("--codeunits <list>", "regression test codeunits", list).option("--methods <list>", "regression test methods", list)
  .action((o) => run(() => api.fixStart(ctx({ issue: o.issue, projects: o.projects ?? [], target: o.target, codeunits: o.codeunits, methods: o.methods }))));
fix.command("verify <id>").action((id) => run(() => api.fixVerify(ctx({ id }))));
const debug = program.command("debug").description("official AL snapshot debugging and CPU profiling MCP proxies");
debug.command("register").requiredOption("--target <name>", "explicit troubleshooting target")
  .option("--host <hosts>", "copilot,vscode,repo", list).option("--api-port <n>", "API/OData MCP port, not dev port", positive)
  .option("--allow-production", "explicitly permit production troubleshooting")
  .action((o) => run(() => api.registerTroubleshooting(ctx({ target: o.target, hosts: o.host, apiPort: o.apiPort, allowProduction: o.allowProduction }))));
debug.command("proxy").requiredOption("--target <name>", "explicit target")
  .addOption(new Option("--kind <kind>").choices(["profile", "snapshot"]).makeOptionMandatory())
  .option("--api-port <n>", "API/OData MCP port", positive).option("--allow-production", "permit production")
  .action(async (o) => {
    try {
      const proxy = await api.troubleshootingProxy(ctx({ target: o.target, kind: o.kind, apiPort: o.apiPort, allowProduction: o.allowProduction }));
      const child = spawn(proxy.command, proxy.args, { cwd: proxy.cwd, env: mergeEnv(proxy.env), stdio: "inherit", windowsHide: true });
      child.on("error", (e) => { process.stderr.write(e.message + "\n"); process.exitCode = 1; });
      child.on("exit", (code) => { process.exitCode = code ?? 1; });
    } catch (e) { process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; }
  });

const profile = program.command("profile").description("schedule, collect and locally analyze official AL CPU profiles");
const profileTimeout = (defaultValue: number) => new Option("--timeout-ms <n>", "total proxy-operation deadline; cleanup may take up to 6s").argParser(positive).default(defaultValue);
profile.command("schedule").requiredOption("-t, --target <name>", "explicit authorized target")
  .requiredOption("--session-id <n>", "actual Business Central NST session id", positive)
  .option("--authorized-session", "acknowledge authorization to profile this session")
  .option("--duration-seconds <n>", "capture window, 1..3600 seconds", positive)
  .option("--sampling-interval-ms <n>", "50, 100 or 150 milliseconds", positive)
  .option("--profile-creation-threshold-ms <n>", "minimum activity duration, default 200ms", Number)
  .option("--description <text>", "schedule label, maximum 200 characters")
  .option("--api-port <n>", "API/OData MCP port, never development port 7049", positive)
  .option("--allow-production", "explicitly permit production capture")
  .addOption(profileTimeout(60_000))
  .action(o => runProfile(signal => api.profileSchedule(ctx({
    target: o.target, sessionId: o.sessionId, authorizedSession: o.authorizedSession === true,
    durationSeconds: o.durationSeconds, samplingIntervalMs: o.samplingIntervalMs,
    profileCreationThresholdMs: o.profileCreationThresholdMs, description: o.description,
    apiPort: o.apiPort, allowProduction: o.allowProduction, timeoutMs: o.timeoutMs, signal,
  }))));
profile.command("collect <id>").description("stop and collect an existing capture; retry delayed empty results on the SAME schedule")
  .option("--allow-production", "explicitly permit collection from production")
  .addOption(profileTimeout(180_000))
  .action((id, o) => runProfile(signal => api.profileCollect(ctx({ id, allowProduction: o.allowProduction, timeoutMs: o.timeoutMs, signal }))));
profile.command("analyze <file>").description("analyze a local ZIP or .alcpuprofile without connecting to BC")
  .option("--top <n>", "hotspots per activity, 1..50", positive)
  .option("--report-file <path>", "JSON report; default <input>.analysis.json")
  .addOption(profileTimeout(60_000))
  .action((file, o) => runProfile(signal => api.profileAnalyze({ file, top: o.top, reportFile: o.reportFile, timeoutMs: o.timeoutMs, signal })));

program
  .command("symbols")
  .description("download symbols for all (or selected) projects into the shared .bc-whale package cache")
  .addOption(projectsOpt())
  .option("--from-target", "download from the target server instead of global NuGet feeds")
  .addOption(targetOpt())
  .option("--force", "re-download even when cached")
  .option("--copy-to-projects", "also copy symbols into each project's .alpackages (for the VS Code AL extension)")
  .action((o) => run(() => api.symbols(ctx({ projects: o.projects, fromTarget: o.fromTarget, target: o.target, force: o.force, copyToProjects: o.copyToProjects }))));

program
  .command("build")
  .alias("compile")
  .description("compile projects in dependency order (altool workspace compile) and return structured diagnostics")
  .addOption(projectsOpt())
  .option("--no-deps", "do not build in-repo dependencies of the selection")
  .option("--analyzers <list>", "CodeCop,UICop,AppSourceCop,PTECop (overrides config)", list)
  .addOption(new Option("--fail-on <level>", "fail on").choices(["none", "error", "warning"]))
  .option("--info", "include Info diagnostics (now the default)")
  .option("--no-info", "hide Info/Hidden in response only; keep the complete archive")
  .addOption(timeoutOpt())
  .option("--max-diagnostics <n>", "limit diagnostics in output", (v) => parseInt(v, 10))
  .action((o) => run(() => api.compile(ctx({ projects: o.projects, includeDependencies: o.deps, analyzers: o.analyzers, failOn: o.failOn, includeInfo: o.info, maxDiagnostics: o.maxDiagnostics, timeoutMs: o.timeoutMs }))));

for (const name of ["check", "watch"]) {
  program.command(name)
    .description(name === "check" ? "check changed apps and their dependents; reuse only a successful unchanged check" : "debounced serial checks on source edits (JSON lines; Ctrl+C stops)")
    .addOption(projectsOpt())
    .option("--force", "check all selected apps even when unchanged")
    .option("--analyzers <list>", "override analyzers", list)
    .addOption(new Option("--fail-on <level>").choices(["none", "error", "warning"]))
    .addOption(timeoutOpt())
    .option("--debounce-ms <n>", "watch debounce (default 300)", positive)
    .action((o) => run(async () => {
      const options = ctx({ projects: o.projects, force: o.force, analyzers: o.analyzers, failOn: o.failOn, timeoutMs: o.timeoutMs });
      if (name === "check") return api.check(options);
      const root = (await api.info(options)).root;
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
      try {
        await watchChecks(root, () => api.check(options), { signal: controller.signal, debounceMs: o.debounceMs, onResult: (r) => process.stdout.write(JSON.stringify(r) + "\n") });
      } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
    }));
}

program.command("diagnostics")
  .description("page the complete archived diagnostics with source evidence; no compilation")
  .option("--run-id <id>", "specific build run; default latest")
  .option("--offset <n>", "zero-based offset", Number)
  .option("--limit <n>", "page size 1..200 (default 100)", positive)
  .addOption(new Option("--severity <level>").choices(["Error", "Warning", "Info", "Hidden"]))
  .option("--project <name>", "exact app name")
  .action((o) => run(() => api.diagnostics(ctx({ runId: o.runId, offset: o.offset, limit: o.limit, severity: o.severity, project: o.project }))));

program
  .command("publish")
  .description("publish built apps to a target in dependency order")
  .addOption(projectsOpt())
  .addOption(targetOpt())
  .option("--no-tests", "skip test apps")
  .option("--no-deps", "do not publish in-repo dependencies of the selection")
  .option("--with-deps", "first publish runtime .app files from .bc-whale/deps")
  .addOption(new Option("--schema-update-mode <mode>").choices(["Synchronize", "ForceSync", "Recreate"]))
  .option("--force-upgrade", "force upgrade without version change")
  .option("--continue-on-error", "do not stop at the first failure")
  .addOption(timeoutOpt())
  .action((o) =>
    run(() =>
      api.deploy(ctx({ projects: o.projects, target: o.target, includeTests: o.tests, includeDependencies: o.deps, withDeps: o.withDeps, schemaUpdateMode: o.schemaUpdateMode, forceUpgrade: o.forceUpgrade, stopOnError: !o.continueOnError, timeoutMs: o.timeoutMs })),
    ),
  );

program
  .command("test")
  .description("fresh compile gate, then tests under one total deadline; never publishes")
  .addOption(projectsOpt())
  .addOption(targetOpt())
  .option("-c, --codeunits <list>", "codeunit ids or names, wildcards allowed", list)
  .option("-m, --methods <list>", "test method names, wildcards allowed", list)
  .option("--company <name>", "company to run in")
  .addOption(new Option("--coverage <kind>").choices(["none", "procedure", "line", "all"]))
  .option("--timeout-ms <n>", "total deadline for build, discovery and all test apps (default 600000)", positive)
  .action(async (o) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      await run(() => api.test(ctx({ projects: o.projects, target: o.target, codeunits: o.codeunits, methods: o.methods, company: o.company, coverage: o.coverage, timeoutMs: o.timeoutMs, signal: controller.signal })));
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
  });

program
  .command("cycle")
  .description("inner dev loop: symbols -> build -> [deps] -> publish -> test (stops at first failure)")
  .addOption(projectsOpt())
  .addOption(targetOpt())
  .option("--steps <list>", "subset of symbols,build,deps,publish,test", list)
  .option("-c, --codeunits <list>", "test codeunits filter", list)
  .option("-m, --methods <list>", "test methods filter", list)
  .option("--force-symbols", "refresh symbols")
  .option("--incremental", "use successful content-hash checks for build; publish/tests still run")
  .addOption(timeoutOpt())
  .addOption(new Option("--fail-on <level>").choices(["none", "error", "warning"]))
  .addOption(new Option("--schema-update-mode <mode>").choices(["Synchronize", "ForceSync", "Recreate"]))
  .action((o) => run(() => api.cycle(ctx({ projects: o.projects, target: o.target, steps: o.steps, codeunits: o.codeunits, methods: o.methods, forceSymbols: o.forceSymbols, failOn: o.failOn, schemaUpdateMode: o.schemaUpdateMode, incremental: o.incremental, timeoutMs: o.timeoutMs }))));

program
  .command("deps")
  .description("install missing dependencies + test toolkit on the target (docker: from the BC artifact; cloud: AppSource apps)")
  .addOption(projectsOpt())
  .addOption(targetOpt())
  .option("--toolkit", "force test toolkit installation")
  .option("--apps <names>", "additional Microsoft app names", list)
  .action((o) => run(() => api.deps(ctx({ projects: o.projects, target: o.target, testToolkit: o.toolkit, apps: o.apps }))));

program
  .command("version")
  .description("bump or set app versions; keeps in-repo dependency versions consistent (formatting preserved)")
  .addOption(projectsOpt())
  .addOption(new Option("--bump <part>").choices(["major", "minor", "build", "revision"]))
  .option("--set <version>", "exact 4-part version")
  .option("--application <version>", "also set application (and platform major)")
  .option("--dry-run", "only show changes")
  .action((o) => run(() => api.version(ctx({ projects: o.projects, bump: o.bump, set: o.set, application: o.application, dryRun: o.dryRun }))));

program
  .command("launch")
  .description("write a 'bc-whale: <target>' configuration into every project's .vscode/launch.json")
  .addOption(projectsOpt())
  .addOption(targetOpt())
  .action((o) => run(() => api.launch(ctx({ projects: o.projects, target: o.target }))));

// ---- targets ----
const target = program.command("target").description("manage deployment targets (docker container, BC online sandbox, on-prem server)");
target.command("list").action(() => run(async () => (await api.info(ctx())).targets));
target
  .command("add <name>")
  .option("--docker <container>", "local BC container")
  .option("--cloud <environmentName>", "BC online environment")
  .option("--production", "cloud environment type Production (default Sandbox)")
  .option("--tenant <tenant>", "AAD tenant id/domain")
  .option("--onprem <server>", "on-prem server url, e.g. http://bcserver")
  .option("--instance <name>", "server instance", "BC")
  .option("--port <port>", "dev endpoint port", (v) => parseInt(v, 10))
  .addOption(new Option("--auth <auth>").choices(["Windows", "UserPassword", "AAD"]))
  .option("--user <name>", "username (UserPassword)")
  .option("--password-env <var>", "env var holding the password")
  .option("--company <name>", "company used for tests")
  .addOption(new Option("--scope <scope>", "where to store the target").choices(["user", "repo"]).default("user"))
  .option("--default", "make it the default target")
  .action((name, o) =>
    run(() => {
      let t: Target;
      if (o.docker) t = { type: "docker", container: o.docker };
      else if (o.cloud) t = { type: "cloud", environmentName: o.cloud, environmentType: o.production ? "Production" : "Sandbox", ...(o.tenant ? { tenant: o.tenant } : {}) };
      else if (o.onprem) t = { type: "onprem", server: o.onprem, serverInstance: o.instance, ...(o.port ? { port: o.port } : {}), authentication: o.auth ?? "UserPassword", ...(o.user ? { username: o.user } : {}), ...(o.passwordEnv ? { passwordEnv: o.passwordEnv } : {}), ...(o.tenant ? { tenant: o.tenant } : {}) };
      else throw new Error("Specify --docker, --cloud or --onprem");
      if (o.company) t.company = o.company;
      return api.targetAdd(ctx({ name, target: t, scope: o.scope, makeDefault: o.default }));
    }),
  );
target
  .command("remove <name>")
  .addOption(new Option("--scope <scope>").choices(["user", "repo"]).default("user"))
  .action((name, o) => run(() => api.targetRemove(ctx({ name, scope: o.scope }))));
target.command("check [name]").description("resolve a target to its connection (validates container/credentials)").action((name) => run(() => api.targetCheck(ctx({ target: name }))));

// ---- containers ----
const container = program.command("container").description("local BC docker containers using the generic image directly (no BcContainerHelper)");
container.command("list").action(() => run(() => api.containers.list()));
container
  .command("create <name>")
  .requiredOption("-a, --artifact <spec>", "sandbox/29/de | onprem/latest/w1 | 29.0.54011.55816/de | full artifact URL")
  .option("--country <code>", "default country when spec has none", "w1")
  .option("--user <name>", "admin user", "admin")
  .option("--password-env <var>", "env var holding the password (default: generated and stored with DPAPI)")
  .addOption(new Option("--auth <auth>").choices(["NavUserPassword", "Windows"]).default("NavUserPassword"))
  .option("--memory <size>", "memory limit", "8G")
  .option("--image <image>", "generic image (default matches host OS)")
  .addOption(new Option("--isolation <mode>").choices(["process", "hyperv"]))
  .option("--license <file>", "license file (.bclicense/.flf)")
  .option("--publish-ports", "map 80/7048/7049/7085/7086 to localhost")
  .option("--replace", "replace an existing container with the same name")
  .option("--no-wait", "return right after docker run")
  .option("--default", "register as default target")
  .action((name, o) =>
    run(() =>
      api.containers.create({
        name, artifact: o.artifact, country: o.country, username: o.user, password: o.passwordEnv ? process.env[o.passwordEnv] : undefined,
        auth: o.auth, memory: o.memory, image: o.image, isolation: o.isolation, licenseFile: o.license, publishPorts: o.publishPorts,
        replace: o.replace, wait: o.wait, makeDefault: o.default, repo: program.opts().repo, log: ctx().log,
      }),
    ),
  );
for (const action of ["start", "stop", "restart", "remove"] as const) container.command(`${action} <name>`).action((name) => run(() => api.containers.action(name, action)));
container.command("wait <name>").description("wait until the container is ready").action((name) => run(() => api.containers.wait(name, ctx().log)));
container.command("logs <name>").option("--tail <n>", "lines", (v) => parseInt(v, 10), 200).action((name, o) => run(async () => { process.stdout.write((await api.containers.logs(name, o.tail)) + "\n"); }));
container.command("apps <name>").description("installed apps").action((name) => run(() => api.containers.installedApps(name)));
container
  .command("install-apps <name> [apps...]")
  .description("publish+install Microsoft apps from the container's artifact by name")
  .option("--toolkit", "add the standard test toolkit apps")
  .action((name, apps: string[], o) => run(() => api.containers.installApps(name, [...apps, ...(o.toolkit ? TEST_TOOLKIT_APPS : [])], ctx().log)));
container.command("license <name> <file>").action((name, file) => run(() => api.containers.importLicense(name, file, ctx().log)));
container
  .command("credential <name>")
  .description("store the credential for an existing container (DPAPI)")
  .requiredOption("--user <name>")
  .option("--password-env <var>", "env var holding the password; otherwise prompted")
  .action((name, o) => run(async () => api.containers.setCredential(name, o.user, o.passwordEnv ? process.env[o.passwordEnv] ?? "" : await promptHidden("Password: "))));
container.command("artifact <spec>").description("resolve an artifact spec to a URL").option("--country <code>", "default country", "w1").action((spec, o) => run(() => api.containers.artifact(spec, o.country)));

// ---- cloud ----
const cloudCmd = program.command("cloud").description("BC online environments via the admin center API (token: az login / BC_ACCESS_TOKEN / client credentials)");
const tenantOpt = () => new Option("--tenant <tenant>", "AAD tenant");
cloudCmd.command("list").addOption(tenantOpt()).action((o) => run(() => api.cloud.listEnvironments({ tenant: o.tenant })));
cloudCmd
  .command("create <name>")
  .addOption(tenantOpt())
  .requiredOption("--country <code>", "country code, e.g. DE")
  .option("--version <v>", "application version")
  .option("--ring <ring>", "ring name (PREVIEW, ...)")
  .option("--register", "register as target (user scope)")
  .action((name, o) =>
    run(async () => {
      const r = await api.cloud.createEnvironment(name, { tenant: o.tenant, countryCode: o.country, applicationVersion: o.version, ringName: o.ring });
      if (o.register) api.targetAdd(ctx({ name, target: { type: "cloud", environmentName: name, environmentType: "Sandbox", ...(o.tenant ? { tenant: o.tenant } : {}) } }));
      return r;
    }),
  );
cloudCmd.command("copy <source> <target>").addOption(tenantOpt()).action((s, t, o) => run(() => api.cloud.copyEnvironment(s, t, { tenant: o.tenant })));
cloudCmd.command("delete <name>").addOption(tenantOpt()).action((n, o) => run(() => api.cloud.deleteEnvironment(n, { tenant: o.tenant })));
cloudCmd.command("operations <name>").addOption(tenantOpt()).action((n, o) => run(() => api.cloud.operations(n, { tenant: o.tenant })));
cloudCmd.command("apps <name>").addOption(tenantOpt()).action((n, o) => run(() => api.cloud.listApps(n, { tenant: o.tenant })));
cloudCmd.command("install <name> <appId>").addOption(tenantOpt()).option("--version <v>").action((n, id, o) => run(() => api.cloud.installApp(n, id, { tenant: o.tenant, version: o.version })));

// ---- auth / mcp / passthrough ----
program
  .command("auth <action>")
  .description("login|logout - altool token cache for BC online (used by symbols/publish/test against cloud targets)")
  .option("--tenant <tenant>")
  .option("--environment-name <name>")
  .option("--device-code", "device code flow")
  .action((action, o) =>
    run(async () => {
      const args = ["auth", action];
      if (o.tenant) args.push("--tenant", o.tenant);
      if (o.environmentName) args.push("--environmentname", o.environmentName);
      if (o.deviceCode) args.push("--devicecode");
      return api.altoolRaw(ctx({ args }));
    }),
  );

const mcp = program.command("mcp").description("MCP integration");
mcp
  .command("register")
  .description("register bc-whale and optionally official AL, Business Central, Azure DevOps or Microsoft Graph MCP servers")
  .option("--host <hosts>", "copilot,vscode,repo", list)
  .option("--almcp", "also register the official AL MCP server for the repo")
  .option("--name <name>", "name of the AL MCP entry")
  .option("--business-central", "also register the Business Central online data MCP server")
  .option("--bc-tenant <tenant>", "pin the Business Central tenant id")
  .option("--bc-environment <name>", "pin the Business Central environment")
  .option("--bc-company <name>", "pin the Business Central company")
  .option("--bc-configuration <name>", "pin the Business Central MCP configuration")
  .option("--azure-devops <organization>", "also register the remote Azure DevOps MCP server for an organization")
  .option("--graph-enterprise", "also register the Microsoft Graph Enterprise MCP server (preview)")
  .action((o) => run(() => api.registerMcp(ctx({
    hosts: o.host,
    almcp: o.almcp,
    name: o.name,
    businessCentral: o.businessCentral ? {
      tenantId: o.bcTenant,
      environmentName: o.bcEnvironment,
      company: o.bcCompany,
      configurationName: o.bcConfiguration,
    } : undefined,
    azureDevOpsOrganization: o.azureDevops,
    graphEnterprise: o.graphEnterprise,
  }) as any)));
mcp.command("serve").description("run the bc-whale MCP server on stdio").action(async () => { await import("./mcp.js"); });

program
  .command("almcp")
  .description("start the official AL MCP server (stdio) for all projects of the repo, using the newest altool and the .bc-whale package cache")
  .action(async () => {
    const tool = await resolveAltool();
    const { args, cwd } = api.almcpArgs(program.opts().repo ?? process.cwd());
    const child = spawn(tool.path, args, { cwd, stdio: "inherit", windowsHide: true });
    child.on("exit", (code) => process.exit(code ?? 0));
  });

program
  .command("altool")
  .description("run altool with raw arguments (escape hatch), e.g. bc-whale altool -- doc build ...")
  .argument("[args...]")
  .allowUnknownOption()
  .action((args: string[]) => run(() => api.altoolRaw(ctx({ args }))));

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    const write = (rl as any)._writeToOutput;
    (rl as any)._writeToOutput = (s: string) => (s.includes(question) ? write.call(rl, s) : undefined);
    rl.question(question, (answer) => {
      rl.close();
      process.stderr.write("\n");
      resolve(answer);
    });
  });
}

program.parseAsync(process.argv);
