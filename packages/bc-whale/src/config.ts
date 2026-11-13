import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import { readJsonc, type RepoModel } from "./repo.js";

export type TargetType = "docker" | "cloud" | "onprem";

export interface TargetBase {
  type: TargetType;
  /** Company used for tests (defaults to the first/default company of the server). */
  company?: string;
  description?: string;
}
export interface DockerTarget extends TargetBase {
  type: "docker";
  container: string;
}
export interface CloudTarget extends TargetBase {
  type: "cloud";
  tenant?: string;
  environmentName: string;
  environmentType?: "Sandbox" | "Production";
}
export interface OnPremTarget extends TargetBase {
  type: "onprem";
  server: string;
  serverInstance?: string;
  port?: number;
  authentication?: "Windows" | "UserPassword" | "AAD";
  username?: string;
  /** Name of an environment variable holding the password (never store the password itself). */
  passwordEnv?: string;
  tenant?: string;
}
export type Target = DockerTarget | CloudTarget | OnPremTarget;

export interface BcWhaleConfig {
  /** Symbol country/region for global NuGet symbol download, e.g. w1, de. */
  country?: string;
  /** Extra NuGet feeds searched before Microsoft feeds for dependencies. */
  nugetFeeds?: string[];
  /** CodeCop, UICop, AppSourceCop, PTECop. */
  analyzers?: string[];
  ruleset?: string;
  customAnalyzers?: string[];
  failOn?: "none" | "error" | "warning";
  /** Preprocessor symbols. */
  define?: string[];
  maxCpuCount?: number;
  targets?: Record<string, Target>;
  defaultTarget?: string;
}

export const USER_DIR = process.env.BC_WHALE_HOME ?? join(homedir(), ".bc-whale");
export const USER_CONFIG = join(USER_DIR, "config.json");

export function repoConfigFile(repo: RepoModel | string): string {
  return join(typeof repo === "string" ? repo : repo.root, "bc-whale.json");
}

function readIfExists(file: string): BcWhaleConfig {
  return existsSync(file) ? (readJsonc<BcWhaleConfig>(file) ?? {}) : {};
}

export interface EffectiveConfig extends BcWhaleConfig {
  country: string;
  analyzers: string[];
  failOn: "none" | "error" | "warning";
  targets: Record<string, Target & { scope: "repo" | "user" }>;
  sources: string[];
}

/** Merge: AL-Go settings < VS Code project settings < user config < repo bc-whale.json. Targets: user + repo (repo wins). */
export function loadConfig(repo: RepoModel): EffectiveConfig {
  const user = readIfExists(USER_CONFIG);
  const repoCfg = readIfExists(repoConfigFile(repo));
  const sources: string[] = [];
  if (existsSync(USER_CONFIG)) sources.push(USER_CONFIG);
  if (existsSync(repoConfigFile(repo))) sources.push(repoConfigFile(repo));
  if (repo.alGo) sources.push("AL-Go settings");

  const alGo = repo.alGo;
  const analyzersFromAlGo: string[] = [];
  if (alGo?.enableCodeCop) analyzersFromAlGo.push("CodeCop");
  if (alGo?.enableUICop) analyzersFromAlGo.push("UICop");
  if (alGo?.enableAppSourceCop ?? alGo?.type === "AppSource App") analyzersFromAlGo.push("AppSourceCop");
  if (alGo?.enablePerTenantExtensionCop ?? (alGo !== undefined && (alGo.type ?? "PTE") === "PTE")) analyzersFromAlGo.push("PTECop");

  const analyzersFromVsCode = new Set<string>();
  const customFromVsCode = new Set<string>();
  let rulesetFromVsCode: string | undefined;
  for (const p of repo.projects) {
    const f = join(p.path, ".vscode", "settings.json");
    if (!existsSync(f)) continue;
    const s = readJsonc<any>(f) ?? {};
    for (const a of s["al.codeAnalyzers"] ?? []) {
      const m = /^\$\{(CodeCop|UICop|AppSourceCop|PTECop)\}$/.exec(a);
      if (m) analyzersFromVsCode.add(m[1]);
      else customFromVsCode.add(resolve(p.path, a.replace(/\$\{workspaceFolder\}/g, p.path)));
    }
    if (!rulesetFromVsCode && s["al.ruleSetPath"]) rulesetFromVsCode = resolve(p.path, s["al.ruleSetPath"]);
  }

  const rulesetFromAlGo = alGo?.rulesetFile ? resolve(alGo.baseFolder, alGo.rulesetFile) : undefined;
  const customFromAlGo = (alGo?.customCodeCops ?? []).map((c) => resolve(alGo!.baseFolder, c));

  const pick = <K extends keyof BcWhaleConfig>(k: K) => repoCfg[k] ?? user[k];
  const targets: EffectiveConfig["targets"] = {};
  for (const [n, t] of Object.entries(user.targets ?? {})) targets[n] = { ...t, scope: "user" };
  for (const [n, t] of Object.entries(repoCfg.targets ?? {})) targets[n] = { ...t, scope: "repo" };

  return {
    ...user,
    ...repoCfg,
    country: pick("country") ?? alGo?.country ?? "w1",
    analyzers: pick("analyzers") ?? (analyzersFromVsCode.size ? [...analyzersFromVsCode] : analyzersFromAlGo),
    ruleset: repoCfg.ruleset ? resolve(repo.root, repoCfg.ruleset) : user.ruleset ?? rulesetFromAlGo ?? rulesetFromVsCode,
    customAnalyzers: (repoCfg.customAnalyzers?.map((c) => resolve(repo.root, c)) ?? user.customAnalyzers ?? [...new Set([...customFromAlGo, ...customFromVsCode])]),
    failOn: pick("failOn") ?? alGo?.failOn ?? "error",
    targets,
    defaultTarget: repoCfg.defaultTarget ?? user.defaultTarget,
    sources,
  };
}

export function resolveTargetName(cfg: EffectiveConfig, name?: string): { name: string; target: Target } {
  const n = name ?? cfg.defaultTarget ?? (Object.keys(cfg.targets).length === 1 ? Object.keys(cfg.targets)[0] : undefined);
  if (!n) throw new Error(`No target given and no defaultTarget configured. Known targets: ${Object.keys(cfg.targets).join(", ") || "(none) - add one with 'bc-whale target add'"}`);
  const t = cfg.targets[n];
  if (!t) throw new Error(`Unknown target '${n}'. Known: ${Object.keys(cfg.targets).join(", ") || "(none)"}`);
  return { name: n, target: t };
}

/** Edit a JSON(C) file in place, preserving formatting and comments. */
export function editJsonFile(file: string, path: (string | number)[], value: unknown) {
  let text = existsSync(file) ? readFileSync(file, "utf8") : "{}";
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) text = text.slice(1);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const edits = modify(text, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol } });
  text = applyEdits(text, edits);
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(file, (bom ? "\ufeff" : "") + text, "utf8");
}

export function saveTarget(scope: "repo" | "user", repoRoot: string, name: string, target: Target | undefined, makeDefault = false) {
  const file = scope === "repo" ? repoConfigFile(repoRoot) : USER_CONFIG;
  editJsonFile(file, ["targets", name], target);
  if (makeDefault) editJsonFile(file, ["defaultTarget"], target ? name : undefined);
  return file;
}

/** Remove the user-scope target that 'container create' registered for this container (if any). */
export function forgetContainerTarget(container: string): boolean {
  const user = readIfExists(USER_CONFIG);
  const t = user.targets?.[container];
  if (!t || t.type !== "docker" || t.container !== container) return false;
  editJsonFile(USER_CONFIG, ["targets", container], undefined);
  if (user.defaultTarget === container) editJsonFile(USER_CONFIG, ["defaultTarget"], undefined);
  return true;
}

/** Per-repo working folder (.bc-whale) - self-ignoring so it never shows up in git. */
export function workDir(repo: RepoModel, ...sub: string[]): string {
  const base = join(repo.root, ".bc-whale");
  if (!existsSync(base)) {
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, ".gitignore"), "*\n");
  }
  const p = join(base, ...sub);
  mkdirSync(p, { recursive: true });
  return p;
}
