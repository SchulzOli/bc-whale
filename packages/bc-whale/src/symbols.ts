import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAltool } from "./altool.js";
import { type EffectiveConfig, workDir } from "./config.js";
import { type Logger, silentLogger } from "./exec.js";
import { type AlProject, normalizeGuid, readJsonc, type RepoModel, selectProjects } from "./repo.js";
import type { Connection } from "./targets.js";

export interface PackageManifest {
  file: string;
  id: string;
  name: string;
  publisher: string;
  version: string;
}

export interface SymbolsResult {
  packageCache: string;
  projects: { project: string; succeeded: boolean; downloaded?: number; message?: string; warnings?: string[] }[];
  removedLocalCopies: string[];
  packages: number;
}

export function packageCacheDir(repo: RepoModel) {
  return workDir(repo, "packages");
}
export function outputDir(repo: RepoModel) {
  return workDir(repo, "out");
}

/**
 * Read .app manifests of a folder (cached by name/size/mtime, uses `altool gpm`).
 */
export async function readPackageManifests(folder: string): Promise<PackageManifest[]> {
  if (!existsSync(folder)) return [];
  const indexFile = join(folder, ".bc-whale-index.json");
  const index: Record<string, PackageManifest & { key: string }> = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, "utf8")) : {};
  const result: PackageManifest[] = [];
  const next: typeof index = {};
  for (const f of readdirSync(folder).filter((x) => x.toLowerCase().endsWith(".app"))) {
    const full = join(folder, f);
    const st = statSync(full);
    const key = `${st.size}-${st.mtimeMs}`;
    let m = index[f]?.key === key ? index[f] : undefined;
    if (!m) {
      const r = await runAltool<any>(["gpm", full], { stream: false });
      if (!r.json) continue;
      m = { key, file: full, id: normalizeGuid(r.json.id), name: r.json.name, publisher: r.json.publisher, version: r.json.version };
    }
    m.file = full;
    next[f] = m;
    result.push(m);
  }
  writeFileSync(indexFile, JSON.stringify(next, null, 2));
  return result;
}

/** app.json copy without in-repo dependencies, so altool never fetches stale published copies of our own apps. */
function writeStrippedProject(repo: RepoModel, project: AlProject): string {
  const raw = readJsonc<any>(join(project.path, "app.json"));
  const localIds = new Set(project.localDependencies);
  raw.dependencies = (raw.dependencies ?? []).filter((d: any) => !localIds.has(normalizeGuid(d.id ?? d.appId)));
  const dir = workDir(repo, "tmp", "symbols", project.app.id);
  writeFileSync(join(dir, "app.json"), JSON.stringify(raw, null, 2));
  return dir;
}

export async function downloadSymbols(
  repo: RepoModel,
  cfg: EffectiveConfig,
  opts: { projects?: string[]; connection?: Connection; force?: boolean; copyToProjects?: boolean; log?: Logger } = {},
): Promise<SymbolsResult> {
  const log = opts.log ?? silentLogger;
  const cache = packageCacheDir(repo);
  const selected = selectProjects(repo, opts.projects, { includeDependencies: true });
  const result: SymbolsResult = { packageCache: cache, projects: [], removedLocalCopies: [], packages: 0 };
  for (const p of selected) {
    if (!p.externalDependencies.length && !p.app.application && !p.app.platform) {
      result.projects.push({ project: p.app.name, succeeded: true, downloaded: 0, message: "no external dependencies" });
      continue;
    }
    const dir = writeStrippedProject(repo, p);
    const args = ["downloadsymbols", "--project", dir, "-c", cache];
    if (opts.force) args.push("--force");
    if (opts.connection) {
      args.push(...opts.connection.args);
    } else {
      args.push("--globalsourcesonly", "--symbolscountryregion", cfg.country);
      for (const feed of cfg.nugetFeeds ?? []) args.push("--nugetfeeds", feed);
    }
    log(`Symbols for ${p.app.name}`);
    const r = await runAltool<any>(args, { log, env: opts.connection?.env });
    const ok = r.exitCode === 0 && r.json?.succeeded !== false;
    result.projects.push({
      project: p.app.name,
      succeeded: ok,
      downloaded: r.json?.data?.downloadedCount,
      message: r.json?.message ?? (ok ? undefined : lastLines(r.output)),
      warnings: r.json?.warnings?.length ? r.json.warnings : undefined,
    });
  }
  // Never let a downloaded (published) copy of an in-repo app shadow the local build.
  const localKeys = new Set(repo.projects.map((p) => p.app.id));
  const manifests = await readPackageManifests(cache);
  for (const m of manifests) {
    if (localKeys.has(m.id)) {
      rmSync(m.file, { force: true });
      result.removedLocalCopies.push(`${m.name} ${m.version}`);
    }
  }
  result.packages = manifests.length - result.removedLocalCopies.length;
  if (opts.copyToProjects) copySymbolsToProjects(repo, selected);
  return result;
}

/** Copy external symbols + locally built dependencies into each project's .alpackages for the VS Code AL extension. */
export function copySymbolsToProjects(repo: RepoModel, projects: AlProject[]) {
  const cache = packageCacheDir(repo);
  const out = outputDir(repo);
  const files = [...readdirSync(cache).filter((f) => f.endsWith(".app")).map((f) => join(cache, f))];
  const built = existsSync(out) ? readdirSync(out).filter((f) => f.endsWith(".app")).map((f) => join(out, f)) : [];
  for (const p of projects) {
    const target = join(p.path, ".alpackages");
    if (!existsSync(target)) workDirAbs(target);
    for (const f of [...files, ...built]) {
      const name = f.split(/[\\/]/).pop()!;
      if (built.includes(f) && name.startsWith(`${p.app.publisher}_${p.app.name}_`)) continue;
      copyFileSync(f, join(target, name));
    }
  }
}

function workDirAbs(p: string) {
  mkdirSync(p, { recursive: true });
}

export function lastLines(text: string, n = 15) {
  return text.trim().split(/\r?\n/).slice(-n).join("\n");
}
