import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";

export interface AppDependency {
  id: string;
  name: string;
  publisher: string;
  version: string;
}

export interface AppManifest {
  id: string;
  name: string;
  publisher: string;
  version: string;
  application?: string;
  platform?: string;
  runtime?: string;
  target?: string;
  dependencies: AppDependency[];
}

export interface AlProject {
  /** Absolute folder path. */
  path: string;
  /** Path relative to repo root, forward slashes. */
  relPath: string;
  app: AppManifest;
  isTest: boolean;
  /** Ids of in-repo apps this project depends on directly. */
  localDependencies: string[];
  /** Dependencies that must come from symbol sources (not in repo). */
  externalDependencies: AppDependency[];
}

export interface AlGoSettings {
  country?: string;
  rulesetFile?: string;
  customCodeCops?: string[];
  failOn?: "none" | "error" | "warning";
  enableCodeCop?: boolean;
  enableUICop?: boolean;
  enableAppSourceCop?: boolean;
  enablePerTenantExtensionCop?: boolean;
  type?: string;
  appFolders?: string[];
  testFolders?: string[];
  bcptTestFolders?: string[];
  artifact?: string;
  /** Absolute folder the relative paths above are resolved against. */
  baseFolder: string;
}

export interface RepoModel {
  root: string;
  projects: AlProject[];
  /** Projects in build order; each inner array can build in parallel. */
  levels: AlProject[][];
  workspaceFile?: string;
  alGo?: AlGoSettings;
  discovery: "al-go" | "workspace" | "scan";
}

const TEST_DEPENDENCY_NAMES = new Set(
  ["library assert", "test runner", "tests-testlibraries", "any", "library variable storage", "system application test library", "application test library", "permissions mock"].map((s) => s.toLowerCase()),
);

const SKIP_DIRS = new Set(["node_modules", ".git", ".bc-whale", ".alpackages", ".output", ".alcache", ".snapshots", ".worktrees", ".buildartifacts", ".dependencies", "dist", "bin", "obj"]);

export function readJsonc<T = any>(file: string): T {
  let text = readFileSync(file, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return parseJsonc(text, [], { allowTrailingComma: true }) as T;
}

export function normalizeGuid(id: string | undefined): string {
  return (id ?? "").toLowerCase().replace(/[{}]/g, "");
}

export function readAppManifest(projectPath: string): AppManifest {
  const raw = readJsonc<any>(join(projectPath, "app.json"));
  return {
    id: normalizeGuid(raw.id),
    name: raw.name,
    publisher: raw.publisher,
    version: raw.version,
    application: raw.application,
    platform: raw.platform,
    runtime: raw.runtime,
    target: raw.target,
    dependencies: (raw.dependencies ?? []).map((d: any) => ({
      id: normalizeGuid(d.id ?? d.appId),
      name: d.name,
      publisher: d.publisher,
      version: d.version ?? d.minVersion ?? "0.0.0.0",
    })),
  };
}

/** Walk up from `start` to find the repository root (git root, or folder with a workspace / AL-Go settings). */
export function findRepoRoot(start: string): string {
  let dir = resolve(start);
  try {
    dir = realpathSync.native(dir);
  } catch {}
  const begin = dir;
  let fallback: string | undefined;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (!fallback && (existsSync(join(dir, "bc-whale.json")) || existsSync(join(dir, ".github", "AL-Go-Settings.json")))) fallback = dir;
    const parent = dirname(dir);
    if (parent === dir) return fallback ?? begin;
    dir = parent;
  }
}

function findWorkspaceFile(root: string): string | undefined {
  const files = readdirSync(root).filter((f) => f.toLowerCase().endsWith(".code-workspace"));
  return files.length ? join(root, files[0]) : undefined;
}

function loadAlGo(root: string): { settings: AlGoSettings; projectFolders: string[] } | undefined {
  const repoSettingsFile = join(root, ".github", "AL-Go-Settings.json");
  const repoSettings = existsSync(repoSettingsFile) ? readJsonc<any>(repoSettingsFile) : undefined;
  let projectNames: string[] = repoSettings?.projects ?? [];
  if (!projectNames.length) {
    if (existsSync(join(root, ".AL-Go", "settings.json"))) projectNames = ["."];
    else {
      projectNames = readdirSync(root).filter((d) => {
        const p = join(root, d, ".AL-Go", "settings.json");
        return existsSync(p);
      });
    }
  }
  if (!projectNames.length && !repoSettings) return undefined;
  const folders: string[] = [];
  let merged: any = { ...(repoSettings ?? {}) };
  let baseFolder = root;
  const appFolders: string[] = [];
  const testFolders: string[] = [];
  const bcptFolders: string[] = [];
  for (const proj of projectNames) {
    const projDir = resolve(root, proj);
    const settingsFile = join(projDir, ".AL-Go", "settings.json");
    if (!existsSync(settingsFile)) continue;
    const ps = readJsonc<any>(settingsFile);
    merged = { ...merged, ...ps };
    baseFolder = projDir;
    for (const f of ps.appFolders ?? []) appFolders.push(resolve(projDir, f));
    for (const f of ps.testFolders ?? []) testFolders.push(resolve(projDir, f));
    for (const f of ps.bcptTestFolders ?? []) bcptFolders.push(resolve(projDir, f));
    folders.push(projDir);
  }
  if (!folders.length) return undefined;
  return {
    settings: {
      country: merged.country,
      rulesetFile: merged.rulesetFile,
      customCodeCops: merged.customCodeCops,
      failOn: merged.failOn,
      enableCodeCop: merged.enableCodeCop,
      enableUICop: merged.enableUICop,
      enableAppSourceCop: merged.enableAppSourceCop,
      enablePerTenantExtensionCop: merged.enablePerTenantExtensionCop,
      type: merged.type,
      artifact: merged.artifact,
      appFolders,
      testFolders,
      bcptTestFolders: bcptFolders,
      baseFolder,
    },
    projectFolders: folders,
  };
}

function scanForApps(dir: string, depth: number, out: string[]) {
  if (depth < 0) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  if (entries.includes("app.json")) {
    out.push(dir);
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.toLowerCase()) || e.startsWith(".")) continue;
    const p = join(dir, e);
    try {
      if (statSync(p).isDirectory()) scanForApps(p, depth - 1, out);
    } catch {
      // ignore
    }
  }
}

export function loadRepo(start: string): RepoModel {
  const root = findRepoRoot(start);
  const alGoLoaded = loadAlGo(root);
  const workspaceFile = findWorkspaceFile(root);
  let folders: string[] = [];
  let discovery: RepoModel["discovery"] = "scan";
  const testSet = new Set<string>();
  if (alGoLoaded && (alGoLoaded.settings.appFolders?.length || alGoLoaded.settings.testFolders?.length)) {
    discovery = "al-go";
    for (const f of [...(alGoLoaded.settings.appFolders ?? []), ...(alGoLoaded.settings.testFolders ?? []), ...(alGoLoaded.settings.bcptTestFolders ?? [])]) {
      if (existsSync(join(f, "app.json"))) folders.push(f);
    }
    for (const f of [...(alGoLoaded.settings.testFolders ?? []), ...(alGoLoaded.settings.bcptTestFolders ?? [])]) testSet.add(resolve(f).toLowerCase());
  } else if (workspaceFile) {
    discovery = "workspace";
    const ws = readJsonc<any>(workspaceFile);
    for (const f of ws.folders ?? []) {
      const p = isAbsolute(f.path) ? f.path : resolve(dirname(workspaceFile), f.path);
      if (existsSync(join(p, "app.json"))) folders.push(p);
    }
  }
  if (!folders.length) {
    discovery = "scan";
    scanForApps(root, 6, folders);
  }
  folders = [...new Set(folders.map((f) => resolve(f)))];

  const projects: AlProject[] = folders.map((path) => {
    const app = readAppManifest(path);
    const isTest =
      testSet.has(path.toLowerCase()) ||
      app.dependencies.some((d) => TEST_DEPENDENCY_NAMES.has((d.name ?? "").toLowerCase())) ||
      /\btests?$/i.test(app.name);
    return { path, relPath: relative(root, path).replace(/\\/g, "/") || ".", app, isTest, localDependencies: [], externalDependencies: [] };
  });
  const byId = new Map(projects.map((p) => [p.app.id, p]));
  const byName = new Map(projects.map((p) => [`${p.app.publisher}|${p.app.name}`.toLowerCase(), p]));
  for (const p of projects) {
    for (const d of p.app.dependencies) {
      const local = (d.id && byId.get(d.id)) || byName.get(`${d.publisher}|${d.name}`.toLowerCase());
      if (local) p.localDependencies.push(local.app.id);
      else p.externalDependencies.push(d);
    }
  }
  return {
    root,
    projects,
    levels: topologicalLevels(projects),
    workspaceFile,
    alGo: alGoLoaded?.settings,
    discovery,
  };
}

/** Kahn's algorithm grouped by level. Throws on cycles. */
export function topologicalLevels(projects: AlProject[]): AlProject[][] {
  const remaining = new Map(projects.map((p) => [p.app.id, p]));
  const done = new Set<string>();
  const levels: AlProject[][] = [];
  while (remaining.size) {
    const level = [...remaining.values()].filter((p) => p.localDependencies.every((d) => done.has(d)));
    if (!level.length) {
      throw new Error(`Dependency cycle between: ${[...remaining.values()].map((p) => p.app.name).join(", ")}`);
    }
    level.sort((a, b) => a.app.name.localeCompare(b.app.name));
    for (const p of level) {
      remaining.delete(p.app.id);
      done.add(p.app.id);
    }
    levels.push(level);
  }
  return levels;
}

export function buildOrder(repo: RepoModel): AlProject[] {
  return repo.levels.flat();
}

/**
 * Resolve a user selection (names, folder paths, app ids, or globs with *) to projects.
 * With includeDependencies, all upstream in-repo dependencies are added.
 */
export function selectProjects(repo: RepoModel, selectors?: string[], opts: { includeDependencies?: boolean; includeDependents?: boolean; testsOnly?: boolean; appsOnly?: boolean } = {}): AlProject[] {
  let selected: AlProject[];
  if (!selectors || !selectors.length) selected = [...repo.projects];
  else {
    selected = [];
    for (const s of selectors) {
      const needle = s.toLowerCase().replace(/\\/g, "/");
      const rx = needle.includes("*") ? new RegExp("^" + needle.split("*").map(escapeRx).join(".*") + "$") : undefined;
      const matches = repo.projects.filter((p) => {
        const keys = [p.app.name.toLowerCase(), p.relPath.toLowerCase(), p.app.id, p.path.toLowerCase().replace(/\\/g, "/")];
        return rx ? keys.some((k) => rx.test(k)) : keys.some((k) => k === needle || k.endsWith("/" + needle));
      });
      if (!matches.length) throw new Error(`No AL project matches '${s}'. Known: ${repo.projects.map((p) => p.app.name).join(", ")}`);
      selected.push(...matches);
    }
  }
  const ids = new Set(selected.map((p) => p.app.id));
  if (opts.includeDependencies) {
    const byId = new Map(repo.projects.map((p) => [p.app.id, p]));
    const stack = [...ids];
    while (stack.length) {
      const p = byId.get(stack.pop()!);
      for (const d of p?.localDependencies ?? []) if (!ids.has(d)) { ids.add(d); stack.push(d); }
    }
  }
  if (opts.includeDependents) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of repo.projects) if (!ids.has(p.app.id) && p.localDependencies.some((d) => ids.has(d))) { ids.add(p.app.id); changed = true; }
    }
  }
  return buildOrder(repo).filter((p) => ids.has(p.app.id) && (!opts.testsOnly || p.isTest) && (!opts.appsOnly || !p.isTest));
}

function escapeRx(s: string) {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/** Conventional output file name produced by alc: Publisher_Name_Version.app */
export function appFileName(app: Pick<AppManifest, "publisher" | "name" | "version">): string {
  const clean = (s: string) => s.replace(/[\\/:*?"<>|]/g, "");
  return `${clean(app.publisher)}_${clean(app.name)}_${app.version}.app`;
}
