import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAltool } from "./altool.js";
import { resolveAnalyzers } from "./analyzers.js";
import { build, type BuildOptions } from "./build.js";
import { workDir, type EffectiveConfig } from "./config.js";
import { appFileName, readJsonc, selectProjects, type RepoModel } from "./repo.js";
import { downloadSymbols, outputDir, packageCacheDir } from "./symbols.js";

export interface InputSnapshot {
  shared: string;
  sources: Record<string, string>;
  outputs: Record<string, string>;
  reports?: Record<string, { runId: string; reportFile: string }>;
}

const SKIP = new Set([".git", ".bc-whale", ".alpackages", ".output", ".alcache", ".snapshots", ".worktrees", "node_modules", "dist", "bin", "obj"]);
const hash = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");
const fileHash = (file: string) => existsSync(file) ? hash(readFileSync(file)) : "missing";

function sourceHash(folder: string, excluded = new Set<string>()): string {
  const files: [string, string][] = [];
  const walk = (dir: string) => {
    if (excluded.has(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.has(entry.name) || entry.name.endsWith(".app")) continue;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Incremental check cannot safely fingerprint symbolic link ${path}; use build instead.`);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push([relative(folder, path), fileHash(path)]);
    }
  };
  walk(folder);
  return hash(JSON.stringify(files));
}

/** Content hashes, not timestamps: deletions and same-size edits invalidate the check. */
export function captureInputs(repo: RepoModel, cfg: EffectiveConfig, toolIdentity: string, resourceFiles: string[] = []): InputSnapshot {
  const cache = packageCacheDir(repo);
  const analyzerFolder = join(workDir(repo), "analyzers");
  const provisioned = existsSync(analyzerFolder) ? readdirSync(analyzerFolder).sort().map((f) => join(analyzerFolder, f)) : [];
  const configFiles = [...cfg.sources, ...(cfg.ruleset ? [cfg.ruleset] : []), ...(cfg.customAnalyzers ?? []), ...provisioned, ...resourceFiles];
  const included = new Set<string>();
  const includeRules = (path: string) => {
    if (included.has(path)) return;
    included.add(path);
    if (!existsSync(path)) return;
    const rules = readJsonc<{ includedRuleSets?: { path: string }[] }>(path);
    for (const rule of rules.includedRuleSets ?? []) {
      if (/^https?:/i.test(rule.path)) throw new Error("Remote included rulesets require a full build, not an incremental check.");
      includeRules(resolve(dirname(path), rule.path));
      if (path === cfg.ruleset) for (const p of repo.projects) includeRules(resolve(p.path, rule.path));
    }
  };
  if (cfg.ruleset) includeRules(cfg.ruleset);
  return {
    shared: hash(JSON.stringify([toolIdentity, cfg, sourceHash(repo.root, new Set(repo.projects.map((p) => p.path))), [...configFiles, ...included].map((p) => [p, fileHash(p)]),
      readdirSync(cache).filter((f) => f.endsWith(".app")).sort().map((f) => [f, fileHash(join(cache, f))])])),
    sources: Object.fromEntries(repo.projects.map((p) => [p.app.id, sourceHash(p.path)])),
    outputs: Object.fromEntries(repo.projects.map((p) => [p.app.id, fileHash(join(outputDir(repo), appFileName(p.app)))])),
  };
}

export function affectedProjects(repo: RepoModel, before: InputSnapshot | undefined, after: InputSnapshot) {
  if (!before || before.shared !== after.shared) return selectProjects(repo);
  const changed = repo.projects.filter((p) => before.sources[p.app.id] !== after.sources[p.app.id] || before.outputs[p.app.id] !== after.outputs[p.app.id]);
  return changed.length ? selectProjects(repo, changed.map((p) => p.app.id), { includeDependents: true }) : [];
}

export async function check(repo: RepoModel, cfg: EffectiveConfig, o: BuildOptions & { force?: boolean } = {}) {
  const started = Date.now();
  const stateFile = join(workDir(repo), "check-state.json");
  if (existsSync(join(workDir(repo), "build.lock"))) throw new Error("Build already running; wait before reusing or checking its outputs.");
  const tool = await resolveAltool();
  const analyzerResolution = resolveAnalyzers(repo, cfg, dirname(tool.path));
  if (!analyzerResolution.succeeded) throw new Error(`Configured analyzers missing: ${analyzerResolution.missing.join(", ")}. ${analyzerResolution.hint}`);
  if ((o.autoSymbols ?? true) && !readdirSync(packageCacheDir(repo)).some((f) => f.endsWith(".app"))) {
    await downloadSymbols(repo, cfg, { log: o.log });
  }
  const implementation = dirname(fileURLToPath(import.meta.url));
  const options = JSON.stringify([tool, fileHash(tool.path), analyzerResolution.resolved, o.analyzers ?? cfg.analyzers, o.failOn ?? cfg.failOn,
    readdirSync(implementation).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js")).sort().map((f) => fileHash(join(implementation, f)))]);
  const before: InputSnapshot | undefined = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : undefined;
  const current = captureInputs(repo, cfg, options);
  const affected = o.force ? selectProjects(repo) : affectedProjects(repo, before, current);
  const scope = new Set(selectProjects(repo, o.projects, { includeDependents: true }).map((p) => p.app.id));
  const selected = affected.filter((p) => scope.has(p.app.id));
  if (!selected.length) {
    return {
      succeeded: true, skipped: "Inputs and validated outputs unchanged since successful check; tests were not rerun.",
      affectedProjects: [], durationMs: Date.now() - started, stateFile,
      validatedReports: Object.fromEntries([...scope].map((id) => [repo.projects.find((p) => p.app.id === id)!.app.name, before?.reports?.[id]])),
    };
  }

  const result = await build(repo, cfg, { ...o, projects: selected.map((p) => p.app.id), includeDependencies: true });
  const after = captureInputs(repo, cfg, options);
  const stable = current.shared === after.shared && JSON.stringify(current.sources) === JSON.stringify(after.sources);
  if (result.succeeded && stable) {
    const validated = new Set(result.projects.map((p) => repo.projects.find((x) => x.app.name === p.name)!.app.id));
    const unchanged = before?.shared === after.shared ? before : undefined;
    const temporary = stateFile + `.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({
      shared: after.shared,
      sources: { ...unchanged?.sources, ...Object.fromEntries([...validated].map((id) => [id, after.sources[id]])) },
      outputs: { ...unchanged?.outputs, ...Object.fromEntries([...validated].map((id) => [id, after.outputs[id]])) },
      reports: { ...unchanged?.reports, ...Object.fromEntries([...validated].map((id) => [id, { runId: result.runId, reportFile: result.reportFile }])) },
    }, null, 2));
    renameSync(temporary, stateFile);
  }
  return {
    succeeded: result.succeeded && stable, affectedProjects: selected.map((p) => p.app.name),
    durationMs: Date.now() - started, stateFile, build: result,
    message: stable ? undefined : "Inputs changed during compilation; rerun check before relying on this build.",
  };
}

/** One check at a time; edits during compilation queue a single debounced rerun. */
export async function watchChecks(root: string, run: () => Promise<unknown>, o: { debounceMs?: number; signal: AbortSignal; onResult: (result: unknown) => void }) {
  const debounce = o.debounceMs ?? 300;
  if (!Number.isInteger(debounce) || debounce < 1) throw new Error("debounceMs must be positive");
  if (o.signal.aborted) return;
  let pending = true, running = false, stopped = false;
  let timer: NodeJS.Timeout | undefined;
  await new Promise<void>((resolve, reject) => {
    const watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (filename && filename.toString().split(/[\\/]/).some((p) => SKIP.has(p) || p.endsWith(".app"))) return;
      pending = true;
      schedule();
    });
    const stop = () => {
      stopped = true;
      watcher.close();
      if (timer) clearTimeout(timer);
      if (!running) resolve();
    };
    o.signal.addEventListener("abort", stop, { once: true });
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void execute(); }, debounce);
    };
    const execute = async () => {
      if (running || stopped || o.signal.aborted) return;
      running = true; pending = false;
      try { o.onResult(await run()); }
      catch (e) { o.onResult({ succeeded: false, error: e instanceof Error ? e.message : String(e) }); }
      finally {
        running = false;
        if (stopped || o.signal.aborted) { o.signal.removeEventListener("abort", stop); resolve(); }
        else if (pending) schedule();
      }
    };
    watcher.on("error", (e) => { stop(); o.signal.removeEventListener("abort", stop); reject(e); });
    void execute();
  });
}
