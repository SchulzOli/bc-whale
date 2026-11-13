import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAltool } from "./altool.js";
import { workDir } from "./config.js";
import { type Logger, silentLogger } from "./exec.js";
import { appFileName, type RepoModel, selectProjects } from "./repo.js";
import { lastLines, outputDir } from "./symbols.js";
import type { Connection } from "./targets.js";
import { createTestBudget } from "./test-control.js";

export interface PublishOptions {
  /** Immutable package folder for validation runs; defaults to the repo output. */
  packageFolder?: string;
  projects?: string[];
  /** Include test apps (default true). */
  includeTests?: boolean;
  /** Also publish in-repo dependencies of the selection (default true). */
  includeDependencies?: boolean;
  schemaUpdateMode?: "Synchronize" | "ForceSync" | "Recreate";
  forceUpgrade?: boolean;
  /** Stop at the first failing app (default true). */
  stopOnError?: boolean;
  log?: Logger;
  timeoutMs?: number;
}

export interface PublishResult {
  succeeded: boolean;
  target: string;
  apps: { name: string; version: string; file?: string; succeeded: boolean; durationMs?: number; exitCode?: number; timedOut?: boolean; message?: string }[];
}

export async function publish(repo: RepoModel, connection: Connection, o: PublishOptions = {}): Promise<PublishResult> {
  const log = o.log ?? silentLogger;
  const projects = selectProjects(repo, o.projects, { includeDependencies: o.includeDependencies ?? true, appsOnly: o.includeTests === false });
  const out = o.packageFolder ?? outputDir(repo);
  const result: PublishResult = { succeeded: true, target: connection.summary, apps: [] };
  for (const p of projects) {
    const file = join(out, appFileName(p.app));
    if (!existsSync(file)) {
      result.apps.push({ name: p.app.name, version: p.app.version, succeeded: false, message: "App not built - run build first." });
      result.succeeded = false;
      if (o.stopOnError ?? true) break;
      continue;
    }
    const args = ["publishapp", file, ...connection.args, "--schemaupdatemode", o.schemaUpdateMode ?? "Synchronize"];
    if (o.forceUpgrade) args.push("--forceupgrade");
    log(`Publishing ${p.app.name} ${p.app.version}`);
    const r = await runAltool<any>(args, { log, env: connection.env, timeoutMs: o.timeoutMs ?? 600_000 });
    const ok = r.exitCode === 0 && r.json?.succeeded !== false;
    result.apps.push({ name: p.app.name, version: p.app.version, file, succeeded: ok, durationMs: r.durationMs, exitCode: r.exitCode, timedOut: r.timedOut, message: ok ? r.json?.message : r.timedOut ? "Publish timed out; inspect target state before retrying." : r.json?.message ?? lastLines(r.output) });
    if (!ok) {
      result.succeeded = false;
      if (o.stopOnError ?? true) break;
    }
  }
  return result;
}

export interface TestOptions {
  /** Use exactly the package set archived for this validation run. */
  packageFolder?: string;
  projects?: string[];
  /** Codeunit ids or names (wildcards * allowed). */
  codeunits?: string[];
  /** Method names (wildcards * allowed). */
  methods?: string[];
  company?: string;
  coverage?: "none" | "procedure" | "line" | "all";
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Internal shared deadline, including an API build gate. */
  deadlineAt?: number;
  log?: Logger;
}

export interface TestFailure {
  codeunit?: string | number;
  method?: string;
  message?: string;
  callStack?: string;
}

export interface TestResult {
  succeeded: boolean;
  target: string;
  message?: string;
  phase?: "build" | "discovery" | "test";
  timedOut?: boolean;
  cancelled?: boolean;
  terminationError?: string;
  serverStateWarning?: string;
  notRunProjects?: string[];
  projects: {
    name: string;
    codeunits: number;
    methods: number;
    passed?: number;
    failed?: number;
    skipped?: number;
    succeeded: boolean;
    failures: TestFailure[];
    resultFile?: string;
    message?: string;
    exitCode?: number;
    timedOut?: boolean;
    cancelled?: boolean;
    terminationError?: string;
  }[];
}

function wildcard(patterns: string[] | undefined) {
  if (!patterns?.length) return () => true;
  const rx = patterns.map((p) => new RegExp("^" + p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i"));
  return (...values: (string | number)[]) => values.some((v) => rx.some((r) => r.test(String(v))));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Count method outcomes, not enclosing suite summaries; reject unrecognised outcomes. */
export function summarizeTestJson(json: unknown): { passed: number; failed: number; skipped: number; failures: TestFailure[] } {
  const acc = { passed: 0, failed: 0, skipped: 0, failures: [] as TestFailure[] };
  const visit = (value: unknown, codeunit?: string | number): void => {
    if (Array.isArray(value)) { value.forEach((n) => visit(n, codeunit)); return; }
    const node = record(value);
    if (!node) return;
    const cu = node.codeunitId ?? node.codeUnitId ?? node.codeunit ?? codeunit;
    const outcome = node.result ?? node.outcome ?? node.status;
    const method = node.method ?? node.methodName ?? node.testMethod;
    if (typeof method === "string") {
      if (typeof outcome !== "string") throw new Error(`Missing test outcome for ${method}`);
      const o = outcome.toLowerCase();
      if (["pass", "passed", "success", "succeeded"].includes(o)) acc.passed++;
      else if (["fail", "failed", "failure", "error"].includes(o)) {
        acc.failed++;
        const message = node.message ?? node.errorMessage ?? node.error ?? node.output;
        const stack = node.callStack ?? node.stackTrace;
        acc.failures.push({
          codeunit: typeof cu === "string" || typeof cu === "number" ? cu : undefined,
          method, message: typeof message === "string" ? message : undefined,
          callStack: typeof stack === "string" ? stack : undefined,
        });
      } else if (["skip", "skipped", "inconclusive", "ignored"].includes(o)) acc.skipped++;
      else throw new Error(`Unknown test outcome '${outcome}' for ${method}`);
      return;
    }
    for (const [k, v] of Object.entries(node)) if (v && typeof v === "object" && k !== "properties") visit(v, typeof cu === "string" || typeof cu === "number" ? cu : undefined);
  };
  visit(json);
  return acc;
}

export function testExecutionSucceeded(exitCode: number, json: unknown, summary: { passed: number; failed: number; skipped: number }, expected: number): boolean {
  const data = record(json);
  return exitCode === 0 && !!data && data.succeeded !== false && expected > 0 &&
    summary.passed > 0 && summary.failed === 0 && summary.passed + summary.skipped >= expected;
}

export async function runTests(repo: RepoModel, connection: Connection, o: TestOptions = {}): Promise<TestResult> {
  const budget = createTestBudget(o.timeoutMs, o.signal, o.deadlineAt);
  const log = o.log ?? silentLogger;
  const projects = o.projects?.length === 0 ? [] : selectProjects(repo, o.projects, { testsOnly: true });
  const out = o.packageFolder ?? outputDir(repo);
  const resultsDir = workDir(repo, "testresults");
  const cuFilter = wildcard(o.codeunits);
  const mFilter = wildcard(o.methods);
  const result: TestResult = { succeeded: projects.length > 0, target: connection.summary, projects: [], message: projects.length ? undefined : "No test projects selected; no execution was verified." };
  for (const p of projects) {
    if (budget.timedOut() || budget.cancelled()) {
      result.succeeded = false;
      result.message = budget.cancelled() ? "Test run cancelled; remaining apps were not run." : "Test run deadline exceeded; remaining apps were not run.";
      break;
    }
    const appFile = join(out, appFileName(p.app));
    if (!existsSync(appFile)) {
      result.projects.push({ name: p.app.name, codeunits: 0, methods: 0, succeeded: false, failures: [], message: "Test app not built - run build first." });
      result.succeeded = false;
      break;
    }
    result.phase = "discovery";
    const listed = await runAltool<any>(["listtests", "--appfile", appFile], { log, stream: false, timeoutMs: budget.remaining(), signal: o.signal });
    if (listed.timedOut || listed.cancelled) {
      result.succeeded = false;
      result.timedOut = listed.timedOut;
      result.cancelled = listed.cancelled;
      result.terminationError = listed.terminationError;
      result.message = listed.cancelled ? "Test discovery cancelled; tests were not started." : "Test discovery timed out; tests were not started.";
      break;
    }
    if (listed.exitCode !== 0 || listed.json?.succeeded === false || !Array.isArray(listed.json?.codeunits)) {
      result.projects.push({ name: p.app.name, codeunits: 0, methods: 0, succeeded: false, failures: [], message: `Test discovery failed: ${lastLines(listed.output)}` });
      result.succeeded = false;
      break;
    }
    const groups = (listed.json?.codeunits ?? [])
      .filter((c: any) => cuFilter(c.id, c.name))
      .map((c: any) => ({ codeunitId: c.id, testMethods: (c.methods ?? []).map((m: any) => m.name).filter((m: string) => mFilter(m)) }))
      .filter((g: any) => g.testMethods.length);
    const methodCount = groups.reduce((n: number, g: any) => n + g.testMethods.length, 0);
    if (!groups.length) {
      result.projects.push({ name: p.app.name, codeunits: 0, methods: 0, succeeded: false, failures: [], message: "No matching tests; no execution was verified." });
      result.succeeded = false;
      break;
    }
    // No method filter -> empty list runs all methods of the codeunit (incl. data-driven variants).
    if (!o.methods?.length) for (const g of groups) g.testMethods = [];
    const groupsFile = join(resultsDir, `${p.app.id}.groups.json`);
    writeFileSync(groupsFile, JSON.stringify(groups, null, 2));
    const args = ["runtests", "--testgroups", groupsFile, ...connection.args];
    const company = o.company ?? connection.company;
    if (company) args.push("--company", company);
    if (o.coverage && o.coverage !== "none") args.push("--coverage", o.coverage, "--coverage-output", workDir(repo, "coverage", p.app.id), "--coverage-format", "cobertura", "--coverage-source-root", p.path);
    log(`Running ${methodCount} test method(s) in ${groups.length} codeunit(s) of ${p.app.name}`);
    if (budget.timedOut() || budget.cancelled()) {
      result.succeeded = false;
      result.message = "Test run cancelled or deadline exceeded before execution; no further tests started.";
      break;
    }
    result.phase = "test";
    const r = await runAltool<unknown>(args, { log, env: connection.env, timeoutMs: budget.remaining(), signal: o.signal });
    const resultFile = join(resultsDir, `${p.app.name}.json`);
    writeFileSync(resultFile, r.json ? JSON.stringify(r.json, null, 2) : r.output);
    let parseError: string | undefined;
    let s = { passed: 0, failed: 0, skipped: 0, failures: [] as TestFailure[] };
    try { s = summarizeTestJson(r.json); }
    catch (e) { parseError = e instanceof Error ? e.message : String(e); }
    const ok = !r.timedOut && !r.cancelled && !parseError && testExecutionSucceeded(r.exitCode, r.json, s, methodCount);
    result.projects.push({
      name: p.app.name,
      codeunits: groups.length,
      methods: methodCount,
      passed: s.passed,
      failed: s.failed,
      skipped: s.skipped,
      succeeded: ok,
      failures: s.failures.slice(0, 50),
      resultFile,
      exitCode: r.exitCode, timedOut: r.timedOut, cancelled: r.cancelled, terminationError: r.terminationError,
      message: ok ? undefined : parseError ?? (r.cancelled ? "Test execution cancelled." : r.timedOut ? "Test execution timed out." : `Failed, empty or incomplete test execution (exit ${r.exitCode}); expected at least ${methodCount} outcomes. ${lastLines(r.output)}`),
    });
    if (!ok) result.succeeded = false;
    if (r.timedOut || r.cancelled) {
      result.timedOut = r.timedOut;
      result.cancelled = r.cancelled;
      result.terminationError = r.terminationError;
      result.serverStateWarning = `${r.terminationError ? "Local process tree termination could not be confirmed." : "Local altool process tree stopped."} The BC server session may still be running; inspect it before retrying. No server session was killed automatically.`;
      break;
    }
    if (!ok) break;
  }
  result.timedOut ||= budget.timedOut();
  result.cancelled ||= budget.cancelled();
  if (result.timedOut || result.cancelled) result.succeeded = false;
  result.notRunProjects = projects.filter((p) => !result.projects.some((r) => r.name === p.app.name)).map((p) => p.app.name);
  return result;
}
