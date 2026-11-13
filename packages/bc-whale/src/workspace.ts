import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import type { Target } from "./config.js";
import { type RepoModel, selectProjects } from "./repo.js";
import type { Connection } from "./targets.js";

function editText(file: string, mutate: (text: string, eol: string) => string) {
  let text = readFileSync(file, "utf8");
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) text = text.slice(1);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  writeFileSync(file, (bom ? "\ufeff" : "") + mutate(text, eol), "utf8");
}

export function bumpVersion(current: string, part: "major" | "minor" | "build" | "revision"): string {
  const v = current.split(".").map((x) => parseInt(x, 10) || 0);
  while (v.length < 4) v.push(0);
  const i = { major: 0, minor: 1, build: 2, revision: 3 }[part];
  v[i]++;
  for (let j = i + 1; j < 4; j++) v[j] = 0;
  return v.join(".");
}

export interface VersionOptions {
  projects?: string[];
  bump?: "major" | "minor" | "build" | "revision";
  set?: string;
  /** Also update application/platform (e.g. "30.0.0.0") */
  application?: string;
  dryRun?: boolean;
}

/**
 * Update app versions and keep in-repo dependency references consistent.
 * Uses formatting-preserving JSON edits.
 */
export function updateVersions(repo: RepoModel, o: VersionOptions) {
  if (!o.bump && !o.set && !o.application) throw new Error("Specify bump, set or application.");
  if (o.set && !/^\d+\.\d+\.\d+\.\d+$/.test(o.set)) throw new Error("set must be a 4-part version like 29.1.0.0");
  const selected = selectProjects(repo, o.projects);
  const newVersions = new Map<string, string>();
  for (const p of selected) newVersions.set(p.app.id, o.set ?? (o.bump ? bumpVersion(p.app.version, o.bump) : p.app.version));
  const changes: { project: string; file: string; from: string; to: string; dependencyUpdates: string[] }[] = [];
  for (const p of repo.projects) {
    const file = join(p.path, "app.json");
    const deps: string[] = [];
    const own = newVersions.get(p.app.id);
    if (!o.dryRun) {
      editText(file, (text, eol) => {
        const fmt = { formattingOptions: { insertSpaces: true, tabSize: 2, eol } };
        const errors: ParseError[] = [];
        const raw = parse(text, errors, { allowTrailingComma: true });
        let t = text;
        if (own && own !== p.app.version) t = applyEdits(t, modify(t, ["version"], own, fmt));
        if (own && o.application) {
          t = applyEdits(t, modify(t, ["application"], o.application, fmt));
          if (raw.platform) t = applyEdits(t, modify(t, ["platform"], o.application.replace(/^(\d+)\..*$/, "$1.0.0.0"), fmt));
        }
        (raw.dependencies ?? []).forEach((d: any, i: number) => {
          const id = String(d.id ?? d.appId ?? "").toLowerCase();
          const nv = newVersions.get(id);
          if (nv && d.version !== nv) {
            t = applyEdits(t, modify(t, ["dependencies", i, "version"], nv, fmt));
            deps.push(`${d.name} -> ${nv}`);
          }
        });
        return t;
      });
    } else {
      for (const d of p.app.dependencies) {
        const nv = newVersions.get(d.id);
        if (nv && d.version !== nv) deps.push(`${d.name} -> ${nv}`);
      }
    }
    if ((own && own !== p.app.version) || deps.length || (own && o.application))
      changes.push({ project: p.app.name, file, from: p.app.version, to: own ?? p.app.version, dependencyUpdates: deps });
  }
  return { dryRun: !!o.dryRun, changes };
}

/**
 * Create/refresh a launch.json configuration named "bc-whale: <target>" in every project,
 * preserving all other configurations and comments.
 */
export function writeLaunchConfigs(repo: RepoModel, targetName: string, target: Target, connection: Connection, o: { projects?: string[]; startupObjectId?: number } = {}) {
  const name = `bc-whale: ${targetName}`;
  const written: string[] = [];
  for (const p of selectProjects(repo, o.projects)) {
    const file = join(p.path, ".vscode", "launch.json");
    let text = existsSync(file) ? readFileSync(file, "utf8").replace(/^\ufeff/, "") : '{\n  "version": "0.2.0",\n  "configurations": []\n}\n';
    const raw = parse(text, [], { allowTrailingComma: true }) ?? {};
    const configs: any[] = raw.configurations ?? [];
    const idx = configs.findIndex((c) => c.name === name);
    const cfg = {
      name,
      type: "al",
      request: "launch",
      ...connection.launch,
      startupObjectId: o.startupObjectId ?? 22,
      startupObjectType: "Page",
      breakOnError: "All",
      launchBrowser: true,
      enableLongRunningSqlStatements: true,
      enableSqlInformationDebugger: true,
      schemaUpdateMode: "Synchronize",
      ...(target.type === "docker" ? { usePublicURLFromServer: false } : {}),
    };
    const fmt = { formattingOptions: { insertSpaces: true, tabSize: 4 } };
    text = applyEdits(text, modify(text, ["configurations", idx >= 0 ? idx : configs.length], cfg, { ...fmt, isArrayInsertion: idx < 0 }));
    mkdirSync(join(p.path, ".vscode"), { recursive: true });
    writeFileSync(file, text);
    written.push(file);
  }
  return { configuration: name, files: written };
}
