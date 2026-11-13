#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as api from "./api.js";
import type { Target } from "./config.js";
import { TEST_TOOLKIT_APPS } from "./docker.js";
import type { Logger } from "./exec.js";

const MAX_TEXT = 60_000;

const server = new McpServer(
  { name: "bc_whale", version: "0.2.1" },
  {
    instructions: [
      "bc-whale covers the Business Central AL dev life cycle (multi-app repos) with altool only - never use BcContainerHelper.",
      "Typical flow: bc_whale_info -> bc_whale_symbols (once) -> bc_whale_build (fix diagnostics) -> bc_whale_publish -> bc_whale_test, or bc_whale_cycle for all in one.",
      "Every tool accepts 'repo' (absolute path of the repository or any folder inside it). Without it, BC_WHALE_REPO or the server cwd is used.",
      "Targets: bc_whale_target_list/add. Local containers: bc_whale_container_create (wait=false) then bc_whale_container_wait.",
      "Projects can be selected by app name, folder, app id or wildcard. Build output: <repo>/.bc-whale/out, symbols: <repo>/.bc-whale/packages.",
      "Profiling: bc_whale_profile_schedule on an authorized session, reproduce the slow activity during its window, then bc_whale_profile_collect using its id. Analyze existing local ZIP/CPU profiles with bc_whale_profile_analyze. Never automatically rerun workloads after empty captures.",
    ].join("\n"),
  },
);

const repo = z.string().optional().describe("Absolute path of the AL repository (or a folder inside it)");
const projects = z.array(z.string()).optional().describe("Project selection: app names, folders, app ids or wildcards. Default: all");
const target = z.string().optional().describe("Target name (see bc_whale_target_list). Default: defaultTarget");
const timeoutMs = z.number().int().positive().optional().describe("Timeout per compiler/publish/test process, default 600000 ms");

function truncate(text: string) {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n... [truncated ${text.length - MAX_TEXT} chars]` : text;
}

type Extra = { signal: AbortSignal; _meta?: { progressToken?: string | number }; sendNotification: (n: any) => Promise<void> };

/** Logger that writes to stderr and, when the client asked for it, sends progress notifications (keeps long calls alive). */
function loggerFor(extra: Extra): Logger {
  const token = extra?._meta?.progressToken;
  let progress = 0;
  let last = 0;
  return (line: string) => {
    process.stderr.write(line.endsWith("\n") ? line : line + "\n");
    if (token === undefined) return;
    const now = Date.now();
    if (now - last < 1000) return;
    last = now;
    extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++progress, message: line.slice(0, 200) } }).catch(() => {});
  };
}

function tool<S extends z.ZodRawShape>(name: string, description: string, shape: S, fn: (args: z.infer<z.ZodObject<S>>, log: Logger, signal: AbortSignal) => Promise<unknown> | unknown) {
  server.registerTool(name, { description, inputSchema: shape }, (async (args: any, extra: Extra) => {
    try {
      const result: any = await fn(args, loggerFor(extra), extra.signal);
      const text = typeof result === "string" ? result : JSON.stringify(result ?? { ok: true }, null, 2);
      if (typeof result !== "string" && text.length > MAX_TEXT) {
        return { content: [{ type: "text", text: JSON.stringify({ succeeded: false, error: "Response too large; read reportFile locally. For build diagnostics use bc_whale_diagnostics with a smaller limit.", id: result?.id, runId: result?.runId ?? result?.build?.runId, reportFile: result?.reportFile ?? result?.analysis?.reportFile ?? result?.build?.reportFile ?? result?.baseline?.reportFile }) }], isError: true };
      }
      return { content: [{ type: "text", text: truncate(text) }], isError: result?.succeeded === false || result?.ok === false };
    } catch (e: any) {
      return { content: [{ type: "text", text: `error: ${e?.message ?? e}` }], isError: true };
    }
  }) as any);
}

// ---------------- repo & life cycle ----------------

tool("bc_whale_doctor", "Check prerequisites: altool version, docker, az login, git, config location.", {}, () => api.doctor());
tool("bc_whale_validate", "Validate a baseline-to-candidate upgrade on an explicitly authorized disposable target and dedicated company. Seeds persistent data, verifies installed versions and runs data assertions. Synchronize only; never cleans up, downgrades or calls the SaaS Admin API. Non-Docker installed-version inspection is currently blocked. Snapshot/profiling remain separate captures.", {
  repo, baselineRepo: z.string().min(1), projects: z.array(z.string().min(1)).min(1),
  target: z.string().min(1), company: z.string().min(1),
  seedCodeunits: z.array(z.string().min(1)).min(1), seedMethods: z.array(z.string().min(1)).min(1),
  verifyCodeunits: z.array(z.string().min(1)).min(1), verifyMethods: z.array(z.string().min(1)).min(1),
  authorizedDisposableTarget: z.boolean(), timeoutMs,
}, (a, log) => api.validateLifecycle({ ...a, log }));
tool("bc_whale_analyzers", "Resolve all configured custom analyzers with hashes; missing analyzers block build/check. Optional source provisions an explicitly trusted local ALCops suite including companion DLLs.", { repo, source: z.string().optional() }, (a) => api.analyzers(a));
tool("bc_whale_fix_start", "Reproduce a concrete bug with a fresh strict build, optionally publish and run regression tests on an explicitly chosen target. Record immutable baseline and source hashes. Deploys only when target is supplied. Returns id for verification; agent implements correction using AL MCP and sources.", {
  repo, issue: z.string().min(1), projects: z.array(z.string()).min(1), target,
  codeunits: z.array(z.string()).optional(), methods: z.array(z.string()).optional(),
}, (a, log) => api.fixStart({ ...a, log }));
tool("bc_whale_fix_verify", "Verify source corrections against the recorded baseline with a fresh strict build and, if baseline selected a target, publish/tests. Fails unchanged sources, configuration bypasses and missing execution. Writes evidence report; never edits code itself.", {
  repo, id: z.string().uuid(),
}, (a, log) => api.fixVerify({ ...a, log }));
tool("bc_whale_debug_register", "Register official AL snapshot debugging and CPU profiling MCP proxies for an explicitly chosen target. Resolves credentials at startup, never writes passwords. Capture is a separate operation on selected sessions; production requires explicit approval.", {
  repo, target: z.string(), hosts: z.array(z.enum(["copilot", "vscode", "repo"])).optional(),
  apiPort: z.number().int().positive().max(65535).optional(), allowProduction: z.boolean().optional(),
}, (a) => api.registerTroubleshooting(a));

const profileDeadline = z.number().int().min(1).max(3_600_000).optional().describe("Total proxy-operation deadline, including connection/retries; bounded local cleanup may take up to 6 seconds");
tool("bc_whale_profile_schedule", "Arm official AL CPU profiling on an explicitly authorized NST session. Requires BC 2026 wave 2+ capabilities. Returns a persistent capture id and the official nextStep: show that nextStep to the user verbatim and reproduce the slow activity during the window before collecting. Does not execute a workload, publish or call the Admin API. Local cancellation may leave the remote schedule armed until its window ends.", {
  repo, target: z.string().min(1), sessionId: z.number().int().positive(), authorizedSession: z.boolean(),
  durationSeconds: z.number().int().min(1).max(3600).optional(),
  samplingIntervalMs: z.union([z.literal(50), z.literal(100), z.literal(150)]).optional(),
  profileCreationThresholdMs: z.number().int().nonnegative().optional(), description: z.string().max(200).optional(),
  apiPort: z.number().int().positive().max(65535).optional(), allowProduction: z.boolean().optional(), timeoutMs: profileDeadline,
}, (a, log, signal) => api.profileSchedule({ ...a, log, signal }));
tool("bc_whale_profile_collect", "Stop and collect a previously armed capture using its persistent bc-whale id. Call after the activity ran/window ended, or when the user explicitly requests early collection. Retries only delayed empty results from the SAME schedule under one deadline (default 180000ms). Archives and analyzes real CPU evidence locally. Empty results are unverified, never successful. Does not rerun workloads or terminate BC sessions. Production needs explicit permission again.", {
  repo, id: z.string().uuid(), allowProduction: z.boolean().optional(), timeoutMs: profileDeadline,
}, (a, log, signal) => api.profileCollect({ ...a, log, signal }));
tool("bc_whale_profile_analyze", "Analyze a local .zip or .alcpuprofile without BC access. Returns self/inclusive hotspots, idle exclusions, activity SQL/HTTP metrics, session memory when embedded, sparse-sample warnings and a persistent JSON report. CPU sampling is not a benchmark; missing memory stays unavailable. Sensitive evidence remains local.", {
  file: z.string().min(1), top: z.number().int().min(1).max(50).optional(), reportFile: z.string().min(1).optional(), timeoutMs: profileDeadline,
}, (a, _log, signal) => api.profileAnalyze({ ...a, signal }));

tool("bc_whale_info", "Describe the AL repo: projects (name, id, version, app/test), build order levels, in-repo and external dependencies, effective config (analyzers, ruleset, failOn) and targets.", { repo }, (a, log) =>
  api.info({ repo: a.repo, log }),
);

tool(
  "bc_whale_symbols",
  "Download symbols (Microsoft + AppSource dependencies) for the projects into the shared package cache. Default source: global NuGet feeds, no server needed. fromTarget=true downloads from the target server/environment instead (needed for PTE dependencies only installed there).",
  { repo, projects, fromTarget: z.boolean().optional(), target, force: z.boolean().optional().describe("Re-download"), copyToProjects: z.boolean().optional().describe("Also copy into each project's .alpackages for the VS Code AL extension") },
  (a, log) => api.symbols({ ...a, log }),
);

tool(
  "bc_whale_build",
  "Compile projects in dependency order with altool workspace compile (in-repo dependencies always come from the fresh build, never from the cache). Returns per-project status, the .app files and structured diagnostics (file, line, column, rule, message). Use after editing AL code.",
  {
    repo,
    projects,
    includeDependencies: z.boolean().optional().describe("Also build in-repo dependencies of the selection (default true)"),
    analyzers: z.array(z.string()).optional().describe("Override analyzers: CodeCop, UICop, AppSourceCop, PTECop"),
    failOn: z.enum(["none", "error", "warning"]).optional(),
    includeInfo: z.boolean().optional().describe("Include Info/Hidden (default true); archive always complete"),
    maxDiagnostics: z.number().int().nonnegative().optional().describe("Response preview limit (default 50); use bc_whale_diagnostics for all"),
    timeoutMs,
  },
  (a, log) => api.compile({ ...a, includeDependencies: a.includeDependencies ?? true, maxDiagnostics: a.maxDiagnostics ?? 50, log }),
);

tool("bc_whale_check", "Fast bugfix check: detect content changes, build affected apps and transitive dependents with fresh dependencies. Reuse only successful checks with identical inputs and output hashes. Returns compiler diagnostics, source snippets/hashes, rule help links and diagnostic delta. Does not publish or run tests.", {
  repo, projects, force: z.boolean().optional(), analyzers: z.array(z.string()).optional(),
  failOn: z.enum(["none", "error", "warning"]).optional(), timeoutMs,
}, (a, log) => api.check({ ...a, maxDiagnostics: 50, log }));

tool("bc_whale_diagnostics", "Read all archived Error/Warning/Info/Hidden diagnostics without recompiling. Includes source location, snapshot SHA256/snippet and compiler helpLink. Follow nextOffset until absent. resolved IDs mean no longer reported, not proof of correctness.", {
  repo, runId: z.string().optional(), offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(200).optional(), severity: z.enum(["Error", "Warning", "Info", "Hidden"]).optional(),
  project: z.string().optional(),
}, (a) => api.diagnostics({ ...a, limit: a.limit ?? 20 }));

tool(
  "bc_whale_publish",
  "Publish built apps (.bc-whale/out) to a target in dependency order (dev endpoint, altool publishapp). Build first.",
  {
    repo,
    projects,
    target,
    includeTests: z.boolean().optional().describe("Default true"),
    includeDependencies: z.boolean().optional().describe("Default true"),
    withDeps: z.boolean().optional().describe("First publish runtime packages from .bc-whale/deps"),
    schemaUpdateMode: z.enum(["Synchronize", "ForceSync", "Recreate"]).optional(),
    forceUpgrade: z.boolean().optional(),
    timeoutMs,
  },
  (a, log) => api.deploy({ ...a, includeDependencies: a.includeDependencies ?? true, log }),
);

tool(
  "bc_whale_test",
  "Fresh compile gate, then AL test discovery/execution under one total deadline (default 600000 ms). Compile errors start no tests. MCP cancellation terminates the local altool process tree; server sessions may require inspection. Never publishes; use cycle build,publish,test for changed source.",
  {
    repo,
    projects,
    target,
    codeunits: z.array(z.string()).optional(),
    methods: z.array(z.string()).optional(),
    company: z.string().optional(),
    coverage: z.enum(["none", "procedure", "line", "all"]).optional(),
    timeoutMs: z.number().int().positive().optional().describe("Total deadline for build, discovery and all test apps; default 600000 ms"),
  },
  (a, log, signal) => api.test({ ...a, log, signal }),
);

tool(
  "bc_whale_cycle",
  "Inner dev loop in one call: symbols (only if cache empty) -> build -> [deps] -> publish -> test. Stops at the first failing step. With projects set, only relevant test apps run.",
  {
    repo,
    projects,
    target,
    steps: z.array(z.enum(["symbols", "build", "deps", "publish", "test"])).optional().describe("Default: symbols, build, publish, test"),
    codeunits: z.array(z.string()).optional(),
    methods: z.array(z.string()).optional(),
    failOn: z.enum(["none", "error", "warning"]).optional(),
    forceSymbols: z.boolean().optional(),
    schemaUpdateMode: z.enum(["Synchronize", "ForceSync", "Recreate"]).optional(),
    incremental: z.boolean().optional().describe("Use cached successful build checks; publish and tests are still executed"),
    timeoutMs,
  },
  (a, log) => api.cycle({ ...a, log }),
);

tool(
  "bc_whale_deps",
  "Install missing dependencies on the target: docker -> Microsoft apps + test toolkit from the container's artifact; cloud -> AppSource apps via admin API. Also publishes .app files placed in <repo>/.bc-whale/deps.",
  { repo, projects, target, testToolkit: z.boolean().optional(), apps: z.array(z.string()).optional().describe("Additional Microsoft app names") },
  (a, log) => api.deps({ ...a, log }),
);

tool(
  "bc_whale_version",
  "Bump or set app versions; keeps in-repo dependency versions consistent. Formatting of app.json is preserved.",
  {
    repo,
    projects,
    bump: z.enum(["major", "minor", "build", "revision"]).optional(),
    set: z.string().optional().describe("Exact 4-part version"),
    application: z.string().optional().describe("Also set application version (and platform major)"),
    dryRun: z.boolean().optional(),
  },
  (a, log) => api.version({ ...a, log }),
);

tool("bc_whale_launch", "Write a 'bc-whale: <target>' configuration into each project's .vscode/launch.json (for F5 debugging in VS Code).", { repo, projects, target }, (a, log) => api.launch({ ...a, log }));

tool("bc_whale_map", "Mermaid dependency map of the repo's AL projects.", { repo }, (a, log) => api.map({ ...a, log }));

const selector = (what: string) => z.string().optional().describe(`${what} node selector: ns:<glob>, obj:<Type>/<Name>[#member], app:<guid>, id:, kind:, scope:, access:, or debuggable/elevation/onprem-surface; '!' negates, '+' AND, ',' OR`);
const graphSelection = {
  repo, projects,
  from: selector("Source"), to: selector("Target"),
  direction: z.enum(["callees", "callers", "both"]).optional().describe("Default: callees for from, callers for to"),
  edgeKinds: z.array(z.enum(["Direct", "Event", "Interface", "Run", "Trigger"])).optional(),
  depth: z.number().int().min(0).optional().describe("Max traversal depth, 0 = unbounded"),
  resolvedOnly: z.boolean().optional().describe("Only statically resolved edges"),
  frontier: selector("Return the nearest nodes matching this"),
  exclude: selector("Prune nodes matching this (e.g. ns:*Test*)"),
  force: z.boolean().optional().describe("Rebuild the graph even if sources are unchanged"),
  timeoutMs,
};

tool("bc_whale_graph_build", "Build the compiler-resolved AL call graph (altool graph extract-whole) of the selected projects and their in-repo dependencies. Reused until AL sources or app.json change. Query and export build it on demand.", {
  repo, projects, force: graphSelection.force, timeoutMs,
}, (a, log, signal) => api.graphBuild({ ...a, log, signal }));

tool("bc_whale_graph_query", "Who calls what across apps: reachability or concrete paths over the compiler-resolved AL call graph (events, interfaces, triggers). Examples: to='obj:Codeunit/Sales-Post#Run' direction=callers; from='access:public+app:<guid>' to='access:internal+app:<guid>' paths=true.", {
  ...graphSelection,
  scope: z.enum(["cloud", "onprem"]).optional(),
  paths: z.boolean().optional().describe("Enumerate concrete paths (capped sample) instead of reachable nodes"),
  maxPaths: z.number().int().positive().optional(),
}, (a, log, signal) => api.graphQuery({ ...a, log, signal }));

tool("bc_whale_graph_export", "Export the call graph or a selected subgraph as DGML (Visual Studio), GraphML (yEd, Gephi) or SARIF (code scanning), with source locations.", {
  ...graphSelection,
  format: z.enum(["dgml", "graphml", "sarif"]).optional(),
  out: z.string().optional().describe("Output file; default <repo>/.bc-whale/graph/export.<format>"),
}, (a, log, signal) => api.graphExport({ ...a, log, signal }));

tool(
  "bc_whale_altool",
  "Escape hatch: run the resolved altool (newest AL extension) with raw arguments, e.g. ['gpm','<app>'] or ['doc','build',...].",
  { repo, args: z.array(z.string()) },
  (a, log) => api.altoolRaw({ ...a, log }),
);

// ---------------- targets ----------------

tool("bc_whale_target_list", "List configured targets and the default target.", { repo }, async (a) => (await api.info({ repo: a.repo })).targets);

tool(
  "bc_whale_target_add",
  "Add or update a deployment target. type docker -> container; cloud -> environmentName (+tenant); onprem -> server url, serverInstance, authentication.",
  {
    repo,
    name: z.string(),
    type: z.enum(["docker", "cloud", "onprem"]),
    container: z.string().optional(),
    environmentName: z.string().optional(),
    environmentType: z.enum(["Sandbox", "Production"]).optional(),
    tenant: z.string().optional(),
    server: z.string().optional(),
    serverInstance: z.string().optional(),
    port: z.number().int().optional(),
    authentication: z.enum(["Windows", "UserPassword", "AAD"]).optional(),
    username: z.string().optional(),
    passwordEnv: z.string().optional().describe("Name of the env var that holds the password"),
    company: z.string().optional(),
    scope: z.enum(["user", "repo"]).optional().describe("user = ~/.bc-whale/config.json (default), repo = <repo>/bc-whale.json"),
    makeDefault: z.boolean().optional(),
  },
  (a) => {
    const { repo: r, name, scope, makeDefault, type, ...rest } = a;
    const clean = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    return api.targetAdd({ repo: r, name, scope, makeDefault, target: { type, ...clean } as Target });
  },
);

tool("bc_whale_target_remove", "Remove a target.", { repo, name: z.string(), scope: z.enum(["user", "repo"]).optional() }, (a) => api.targetRemove(a));

tool("bc_whale_target_check", "Resolve a target to its connection (validates container state and credentials).", { repo, target }, (a, log) => api.targetCheck({ ...a, log }));

// ---------------- containers ----------------

tool("bc_whale_container_list", "List local BC containers (state, version, country, ip, auth).", {}, () => api.containers.list());

tool(
  "bc_whale_container_create",
  "Create a local BC container from an artifact with the generic image (no BcContainerHelper) and register it as target. Use wait=false and then bc_whale_container_wait, because the first start takes 10-20 minutes.",
  {
    repo,
    name: z.string(),
    artifact: z.string().describe("e.g. sandbox/29/de, onprem/latest/w1, 29.0.54011.55816/de or a full artifact URL"),
    country: z.string().optional(),
    username: z.string().optional().describe("Default admin"),
    passwordEnv: z.string().optional().describe("Env var with the password; default: generated and stored with DPAPI"),
    auth: z.enum(["NavUserPassword", "Windows"]).optional(),
    memory: z.string().optional(),
    licenseFile: z.string().optional(),
    publishPorts: z.boolean().optional(),
    replace: z.boolean().optional(),
    wait: z.boolean().optional().describe("Default false for MCP"),
    makeDefault: z.boolean().optional(),
  },
  (a, log) => {
    const { passwordEnv, ...o } = a;
    return api.containers.create({ ...o, password: passwordEnv ? process.env[passwordEnv] : undefined, wait: a.wait ?? false, log });
  },
);

tool("bc_whale_container_wait", "Wait until a container is ready (polls logs for 'Ready for connections!').", { name: z.string() }, (a, log) => api.containers.wait(a.name, log));

tool(
  "bc_whale_container_action",
  "start, stop, restart or remove a container.",
  { name: z.string(), action: z.enum(["start", "stop", "restart", "remove"]) },
  (a) => api.containers.action(a.name, a.action),
);

tool("bc_whale_container_logs", "Container logs (tail).", { name: z.string(), tail: z.number().int().optional() }, (a) => api.containers.logs(a.name, a.tail ?? 200));

tool("bc_whale_container_apps", "Apps published/installed in the container.", { name: z.string() }, (a) => api.containers.installedApps(a.name));

tool(
  "bc_whale_container_install_apps",
  "Publish + sync + install Microsoft apps from the container's artifact by name (testToolkit adds the standard test libraries).",
  { name: z.string(), apps: z.array(z.string()).optional(), testToolkit: z.boolean().optional() },
  (a, log) => api.containers.installApps(a.name, [...(a.apps ?? []), ...(a.testToolkit ? TEST_TOOLKIT_APPS : [])], log),
);

tool("bc_whale_container_license", "Import a license file into a container.", { name: z.string(), file: z.string() }, (a, log) => api.containers.importLicense(a.name, a.file, log));

tool("bc_whale_artifact", "Resolve an artifact spec (sandbox/29/de, onprem/latest/w1, ...) to the artifact URL and version.", { spec: z.string(), country: z.string().optional() }, (a) =>
  api.containers.artifact(a.spec, a.country),
);

// ---------------- cloud ----------------

const tenant = z.string().optional().describe("AAD tenant id or domain");

tool("bc_whale_cloud_environments", "List BC online environments (admin center API).", { tenant }, (a) => api.cloud.listEnvironments(a));
tool(
  "bc_whale_cloud_create",
  "Create a BC online sandbox environment. Optionally register it as target.",
  { tenant, name: z.string(), countryCode: z.string(), applicationVersion: z.string().optional(), ringName: z.string().optional(), registerTarget: z.boolean().optional(), repo },
  async (a) => {
    const r = await api.cloud.createEnvironment(a.name, a);
    if (a.registerTarget) api.targetAdd({ repo: a.repo, name: a.name, target: { type: "cloud", environmentName: a.name, environmentType: "Sandbox", ...(a.tenant ? { tenant: a.tenant } : {}) } });
    return r;
  },
);
tool("bc_whale_cloud_copy", "Copy an environment to a new sandbox.", { tenant, source: z.string(), target: z.string() }, (a) => api.cloud.copyEnvironment(a.source, a.target, a));
tool("bc_whale_cloud_delete", "Delete an environment.", { tenant, name: z.string() }, (a) => api.cloud.deleteEnvironment(a.name, a));
tool("bc_whale_cloud_operations", "Environment operations (create/copy/update status).", { tenant, name: z.string() }, (a) => api.cloud.operations(a.name, a));
tool("bc_whale_cloud_apps", "Apps installed in an environment.", { tenant, name: z.string() }, (a) => api.cloud.listApps(a.name, a));
tool("bc_whale_cloud_install_app", "Install an AppSource app into an environment.", { tenant, name: z.string(), appId: z.string(), version: z.string().optional() }, (a) =>
  api.cloud.installApp(a.name, a.appId, a),
);

await server.connect(new StdioServerTransport());
process.stderr.write("bc-whale MCP server ready (stdio)\n");
