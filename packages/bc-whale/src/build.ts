import { closeSync, existsSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveAltool, runAltool } from "./altool.js";
import { resolveAnalyzers } from "./analyzers.js";
import { type EffectiveConfig, workDir } from "./config.js";
import { exec, type Logger, silentLogger } from "./exec.js";
import { type AlProject, appFileName, type RepoModel, selectProjects } from "./repo.js";
import { downloadSymbols, lastLines, outputDir, packageCacheDir } from "./symbols.js";

export interface Diagnostic {
  id: string;
  project: string;
  severity: "Error" | "Warning" | "Info" | "Hidden";
  ruleId: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  helpLink?: string;
  source?: { uri: string; sha256: string; startLine: number; text: string };
}

export interface BuildResult {
  succeeded: boolean;
  failOn: string;
  durationMs: number;
  projects: { name: string; path: string; succeeded: boolean; appFile?: string; errors: number; warnings: number; infos: number }[];
  diagnostics: Diagnostic[];
  outputFolder: string;
  logFolder: string;
  skippedAnalyzers?: string[];
  resolvedAnalyzers?: { configured: string; path: string; sha256: string }[];
  output?: string;
  exitCode: number;
  timedOut: boolean;
  terminationError?: string;
  complete: boolean;
  totalDiagnostics: number;
  omittedDiagnostics: number;
  reportFile: string;
  runId: string;
  command: string;
  commit?: string;
  diagnosticChanges?: { added: string[]; resolved: string[]; unchanged: number };
}

export interface BuildOptions {
  projects?: string[];
  /** Also build in-repo dependencies of the selected projects (default true). */
  includeDependencies?: boolean;
  analyzers?: string[];
  failOn?: "none" | "error" | "warning";
  /** Download symbols first when the package cache is empty (default true). */
  autoSymbols?: boolean;
  /** Include Info/Hidden diagnostics in the response (default true; archive always contains them). */
  includeInfo?: boolean;
  maxDiagnostics?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  log?: Logger;
}

const VALID_ANALYZERS = new Set(["CodeCop", "UICop", "AppSourceCop", "PTECop"]);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid diagnostic object");
  return value as Record<string, unknown>;
}

export function parseDiagnostics(value: unknown, root: string, project: string): Diagnostic[] {
  const data = object(value);
  if (!Array.isArray(data.issues)) throw new Error("Diagnostic log has no issues array");
  return data.issues.flatMap((raw): Diagnostic[] => {
    const issue = object(raw);
    const properties = object(issue.properties);
    if (properties.isSuppressedInSource === "True" || properties.isSuppressedInSource === true) return [];
    const severity = properties.severity;
    if (severity !== "Error" && severity !== "Warning" && severity !== "Info" && severity !== "Hidden") throw new Error(`Unknown diagnostic severity '${severity}'`);
    const message = issue.shortMessage ?? issue.fullMessage;
    if (typeof issue.ruleId !== "string" || typeof message !== "string") throw new Error("Diagnostic is missing ruleId/message");
    const locations = Array.isArray(issue.locations) ? issue.locations : [];
    const target = locations.length ? object(locations[0]).analysisTarget : undefined;
    const loc = Array.isArray(target) && target.length ? object(target[0]) : undefined;
    const region = loc?.region ? object(loc.region) : {};
    const number = (key: string) => typeof region[key] === "number" ? region[key] as number : undefined;
    const line = number("startLine");
    let file: string | undefined;
    let source: Diagnostic["source"];
    if (typeof loc?.uri === "string") {
      const absolute = loc.uri.startsWith("file:") ? fileURLToPath(loc.uri) : resolve(root, loc.uri);
      file = relative(root, absolute).replace(/\\/g, "/");
      const within = relative(root, absolute);
      if (line && !isAbsolute(within) && within !== ".." && !within.startsWith(`..${sep}`) && existsSync(absolute)) {
        const content = readFileSync(absolute);
        const lines = content.toString("utf8").split(/\r?\n/);
        const startLine = Math.max(1, line - 2);
        source = { uri: pathToFileURL(absolute).href, sha256: createHash("sha256").update(content).digest("hex"), startLine, text: lines.slice(startLine - 1, line + 2).join("\n").trimEnd() };
      }
    }
    const diagnostic: Omit<Diagnostic, "id"> = {
      project, severity, ruleId: issue.ruleId, message, file, line,
      column: number("startColumn"), endLine: number("endLine"), endColumn: number("endColumn"),
      helpLink: typeof properties.helpLink === "string" ? properties.helpLink : undefined, source,
    };
    return [{ ...diagnostic, id: createHash("sha256").update(JSON.stringify([project, severity, issue.ruleId, message, file, line, diagnostic.column])).digest("hex").slice(0, 24) }];
  });
}

export function buildSucceeded(exitCode: number, complete: boolean, projects: BuildResult["projects"]): boolean {
  return exitCode === 0 && complete && projects.length > 0 && projects.every((p) => p.succeeded);
}

export function diagnosticChanges(previous: Diagnostic[], current: Diagnostic[]) {
  const before = new Set(previous.map((d) => d.id)), after = new Set(current.map((d) => d.id));
  return { added: [...after].filter((id) => !before.has(id)), resolved: [...before].filter((id) => !after.has(id)), unchanged: [...after].filter((id) => before.has(id)).length };
}

export function findDiagnosticLog(project: string, files: string[]): string | undefined {
  return files.filter((f) => f.startsWith(project + "_") && /^\d{8}_\d{6}\.errorLog\.json$/i.test(f.slice(project.length + 1))).sort().at(-1);
}

async function gitInfo(root: string) {
  const url = await exec("git", ["-C", root, "config", "--get", "remote.origin.url"], { stream: false }).catch(() => undefined);
  const commit = await exec("git", ["-C", root, "rev-parse", "HEAD"], { stream: false }).catch(() => undefined);
  return { url: url?.exitCode === 0 ? url.stdout.trim() : undefined, commit: commit?.exitCode === 0 ? commit.stdout.trim() : undefined };
}

export function writeWorkspace(repo: RepoModel, projects: AlProject[], name = "bc-whale"): string {
  const file = join(workDir(repo), `${name}.code-workspace`);
  writeFileSync(file, JSON.stringify({ folders: projects.map((p) => ({ path: p.path, name: p.app.name })) }, null, 2));
  return file;
}

export async function build(repo: RepoModel, cfg: EffectiveConfig, o: BuildOptions = {}): Promise<BuildResult> {
  const lock = join(workDir(repo), "build.lock");
  let fd: number;
  try { fd = openSync(lock, "wx"); }
  catch (e) {
    if (e && typeof e === "object" && "code" in e && e.code === "EEXIST") throw new Error(`Build already running. Lock: ${lock}. Remove only after confirming its owning process is stopped.`);
    throw e;
  }
  try { writeFileSync(fd, String(process.pid)); return await buildUnlocked(repo, cfg, o); }
  finally { closeSync(fd); rmSync(lock); }
}

async function buildUnlocked(repo: RepoModel, cfg: EffectiveConfig, o: BuildOptions): Promise<BuildResult> {
  if (o.maxDiagnostics !== undefined && (!Number.isInteger(o.maxDiagnostics) || o.maxDiagnostics < 0)) throw new Error("maxDiagnostics must be a non-negative integer");
  if (o.timeoutMs !== undefined && (!Number.isInteger(o.timeoutMs) || o.timeoutMs <= 0)) throw new Error("timeoutMs must be a positive integer");
  const log = o.log ?? silentLogger;
  const started = Date.now();
  const projects = selectProjects(repo, o.projects, { includeDependencies: o.includeDependencies ?? true });
  const analyzers = o.analyzers ?? cfg.analyzers;
  for (const analyzer of analyzers) if (!VALID_ANALYZERS.has(analyzer)) throw new Error(`Unknown analyzer '${analyzer}'`);
  if (cfg.ruleset && !existsSync(cfg.ruleset)) throw new Error(`Configured ruleset not found: ${cfg.ruleset}`);
  const analyzerResolution = resolveAnalyzers(repo, cfg, dirname((await resolveAltool()).path));
  if (!analyzerResolution.succeeded) throw new Error(`Configured analyzers missing: ${analyzerResolution.missing.join(", ")}. ${analyzerResolution.hint}`);
  const custom = analyzerResolution.resolved.map((a) => a.path);
  const cache = packageCacheDir(repo);
  const out = outputDir(repo);
  if ((o.autoSymbols ?? true) && !readdirSync(cache).some((f) => f.endsWith(".app"))) {
    log("Package cache empty - downloading symbols first");
    await downloadSymbols(repo, cfg, { projects: projects.map((p) => p.app.id), log });
  }
  // Remove previous outputs of the projects being built so dependents never compile against stale apps.
  for (const p of projects) {
    for (const f of readdirSync(out)) if (f.toLowerCase().startsWith(`${p.app.publisher}_${p.app.name}_`.toLowerCase()) && f.endsWith(".app")) rmSync(join(out, f), { force: true });
  }
  const runId = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
  const errDir = workDir(repo, "logs", runId, "errors");
  const logDir = workDir(repo, "logs", runId);
  const ws = writeWorkspace(repo, projects);
  const args = ["workspace", "compile", ws, "-c", `${out};${cache}`, "-o", out, "--errorlogdirectory", errDir, "--logdirectory", logDir];
  if (analyzers.length) args.push("--analyzers", analyzers.join(","));
  if (cfg.ruleset) {
    args.push("--ruleset", cfg.ruleset);
  }
  if (custom.length) args.push("--customanalyzers", custom.join(","));
  if (cfg.define?.length) args.push("--define", cfg.define.join(","));
  if (cfg.maxCpuCount) args.push("--maxcpucount", String(cfg.maxCpuCount));
  const git = await gitInfo(repo.root);
  if (git.url) args.push("--sourcerepositoryurl", git.url);
  if (git.commit) args.push("--sourcecommit", git.commit);

  const r = await runAltool(args, { log, cwd: repo.root, timeoutMs: o.timeoutMs ?? 600_000, signal: o.signal });
  writeFileSync(join(logDir, "process.log"), r.output);
  const diagnostics: Diagnostic[] = [];
  const failOn = o.failOn ?? cfg.failOn;
  const projectResults: BuildResult["projects"] = [];
  const problems: string[] = [];
  const errorFiles = existsSync(errDir) ? readdirSync(errDir) : [];
  for (const p of projects) {
    const errFile = findDiagnosticLog(p.app.name, errorFiles);
    let issues: Diagnostic[] = [];
    if (!errFile) problems.push(`Missing diagnostic log for ${p.app.name}`);
    else {
      try { issues = parseDiagnostics(JSON.parse(readFileSync(join(errDir, errFile), "utf8")), repo.root, p.app.name); }
      catch (e) { problems.push(`${p.app.name}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    let errors = 0, warnings = 0, infos = 0;
    for (const i of issues) {
      const sev = i.severity;
      if (sev === "Error") errors++;
      else if (sev === "Warning") warnings++;
      else infos++;
      diagnostics.push(i);
    }
    const appFile = join(out, appFileName(p.app));
    const produced = existsSync(appFile);
    const analyzerFailed = issues.some((d) => d.ruleId === "AD0001");
    if (analyzerFailed) problems.push(`Analyzer execution failed for ${p.app.name}; inspect AD0001 before relying on this build.`);
    const ok = produced && errors === 0 && !analyzerFailed && !(failOn === "warning" && warnings > 0);
    projectResults.push({ name: p.app.name, path: p.relPath, succeeded: ok, appFile: produced ? appFile : undefined, errors, warnings, infos });
  }
  const order = { Error: 0, Warning: 1, Info: 2, Hidden: 3 } as const;
  diagnostics.sort((a, b) => order[a.severity] - order[b.severity]);
  const max = o.maxDiagnostics ?? 200;
  const complete = problems.length === 0;
  const reportFile = join(logDir, "diagnostics.json");
  const latestFile = join(workDir(repo), "latest-build.json");
  const scope = projects.map((p) => p.app.id).sort().join(",");
  let changes: BuildResult["diagnosticChanges"];
  if (complete && existsSync(latestFile)) {
    const previous: BuildResult & { scope: string } = JSON.parse(readFileSync(latestFile, "utf8"));
    if (previous.complete && previous.scope === scope) {
      const archived: BuildResult = JSON.parse(readFileSync(previous.reportFile, "utf8"));
      changes = diagnosticChanges(archived.diagnostics, diagnostics);
    }
  }
  const result: BuildResult = {
    succeeded: buildSucceeded(r.exitCode, complete, projectResults),
    failOn,
    durationMs: Date.now() - started,
    projects: projectResults,
    diagnostics,
    outputFolder: out,
    logFolder: logDir,
    skippedAnalyzers: undefined,
    resolvedAnalyzers: analyzerResolution.resolved,
    output: r.exitCode !== 0 || !complete || projectResults.some((p) => !p.appFile) ? [...problems, r.timedOut ? "Compiler timed out." : "", lastLines(r.output, 40)].filter(Boolean).join("\n") : undefined,
    exitCode: r.exitCode, timedOut: r.timedOut, terminationError: r.terminationError, complete, totalDiagnostics: diagnostics.length,
    omittedDiagnostics: 0, reportFile, runId, command: r.command, commit: git.commit, diagnosticChanges: changes,
  };
  writeFileSync(reportFile, JSON.stringify(result, null, 2));
  writeFileSync(latestFile, JSON.stringify({ ...result, diagnostics: [], scope }, null, 2));
  const visible = (o.includeInfo ?? true) ? diagnostics : diagnostics.filter((d) => d.severity === "Error" || d.severity === "Warning");
  return { ...result, diagnostics: visible.slice(0, max), omittedDiagnostics: diagnostics.length - Math.min(visible.length, max) };
}

export function readDiagnostics(repo: RepoModel, o: { runId?: string; offset?: number; limit?: number; severity?: Diagnostic["severity"]; project?: string } = {}) {
  const offset = o.offset ?? 0, limit = o.limit ?? 100;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("offset must be non-negative; limit must be between 1 and 200");
  if (o.runId && !/^[a-zA-Z0-9-]+$/.test(o.runId)) throw new Error("Invalid runId");
  const reportFile: string = o.runId ? join(workDir(repo), "logs", o.runId, "diagnostics.json") :
    (JSON.parse(readFileSync(join(workDir(repo), "latest-build.json"), "utf8")) as BuildResult).reportFile;
  const report: BuildResult = JSON.parse(readFileSync(reportFile, "utf8"));
  const filtered = report.diagnostics.filter((d) => (!o.severity || d.severity === o.severity) && (!o.project || d.project === o.project));
  return { runId: report.runId, reportFile, complete: report.complete, total: filtered.length, offset, nextOffset: offset + limit < filtered.length ? offset + limit : undefined, diagnostics: filtered.slice(offset, offset + limit) };
}
