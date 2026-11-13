import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { runAltool } from "./altool.js";
import { workDir } from "./config.js";
import type { Logger } from "./exec.js";
import type { AlProject, RepoModel } from "./repo.js";

export const EDGE_KINDS = ["Direct", "Event", "Interface", "Run", "Trigger"] as const;
export const DIRECTIONS = ["callees", "callers", "both"] as const;
export const EXPORT_FORMATS = ["dgml", "graphml", "sarif"] as const;

export interface GraphSelection {
  from?: string;
  to?: string;
  direction?: (typeof DIRECTIONS)[number];
  edgeKinds?: (typeof EDGE_KINDS)[number][];
  depth?: number;
  resolvedOnly?: boolean;
  frontier?: string;
  exclude?: string;
}

export interface GraphQueryOptions extends GraphSelection {
  scope?: "cloud" | "onprem";
  paths?: boolean;
  maxPaths?: number;
}

export interface GraphFile {
  file: string;
  rebuilt: boolean;
  projects: string[];
  nodes?: number;
  edges?: number;
}

const SKIP = new Set([".alpackages", ".bc-whale", ".snapshots", ".git", "node_modules", ".vscode"]);

/** Content fingerprint of the AL sources and manifests of the selected projects; any change rebuilds the graph. */
export function sourceFingerprint(projects: AlProject[]): string {
  const hash = createHash("sha256");
  const walk = (root: string, dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (SKIP.has(name)) continue;
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(root, path);
      else if (extname(name).toLowerCase() === ".al" || name.toLowerCase() === "app.json") {
        hash.update(`${relative(root, path)}\0`).update(readFileSync(path)).update("\0");
      }
    }
  };
  for (const project of [...projects].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`project:${project.path}\0`);
    walk(project.path, project.path);
  }
  return hash.digest("hex");
}

function selectionKey(projects: AlProject[]): string {
  return createHash("sha256").update(projects.map((p) => p.path).sort().join("\n")).digest("hex").slice(0, 12);
}

/** altool graph commands report bad input as an unhandled exception but still exit 0. */
export function graphFailure(output: string, exitCode: number): string | undefined {
  const exception = /Unhandled exception:\s*(?:[\w.]+Exception:\s*)?(.+)/.exec(output);
  if (exception) return exception[1].trim();
  if (exitCode !== 0) return output.trim().split(/\r?\n/).slice(-5).join("\n") || `altool exited with ${exitCode}`;
  return undefined;
}

function checkSelector(name: string, value: string | undefined) {
  if (value === undefined) return;
  if (!value.trim() || value.startsWith("-")) throw new Error(`Invalid ${name} selector: '${value}'`);
}

export function selectionArgs(o: GraphSelection): string[] {
  for (const [name, value] of [["from", o.from], ["to", o.to], ["frontier", o.frontier], ["exclude", o.exclude]] as const) checkSelector(name, value);
  if (o.depth !== undefined && (!Number.isInteger(o.depth) || o.depth < 0)) throw new Error("depth must be a non-negative integer");
  const args: string[] = [];
  if (o.from) args.push("--from", o.from);
  if (o.to) args.push("--to", o.to);
  if (o.direction) args.push("--direction", o.direction);
  if (o.edgeKinds?.length) args.push("--edge-kinds", o.edgeKinds.join(","));
  if (o.depth !== undefined) args.push("--depth", String(o.depth));
  if (o.resolvedOnly) args.push("--resolved-only");
  if (o.frontier) args.push("--frontier", o.frontier);
  if (o.exclude) args.push("--exclude", o.exclude);
  return args;
}

export function queryArgs(graph: string, o: GraphQueryOptions): string[] {
  if (!o.from && !o.to) throw new Error("Give a 'from' or 'to' selector, e.g. obj:Codeunit/My Codeunit or ns:MyCompany.Sales*");
  if (o.maxPaths !== undefined && (!Number.isInteger(o.maxPaths) || o.maxPaths <= 0)) throw new Error("maxPaths must be a positive integer");
  const args = ["graph", "query", "--graph", graph, ...selectionArgs(o)];
  if (o.scope) args.push("--scope", o.scope);
  if (o.paths) args.push("--paths");
  if (o.maxPaths !== undefined) args.push("--max-paths", String(o.maxPaths));
  return args;
}

/** "3 node(s):" / "2 path(s):" followed by indented lines. */
export function parseQueryOutput(output: string): { kind: "nodes" | "paths"; count: number; items: string[] } {
  const lines = output.split(/\r?\n/);
  const header = lines.findIndex((line) => /^\d+ (node|path)\(s\):/.test(line.trim()));
  if (header < 0) throw new Error(`Unexpected altool graph query output:\n${output.slice(-2000)}`);
  const [, count, kind] = /^(\d+) (node|path)\(s\):/.exec(lines[header].trim())!;
  const items = lines.slice(header + 1).filter((line) => /^\s+\S/.test(line)).map((line) => line.trim());
  return { kind: kind === "node" ? "nodes" : "paths", count: Number(count), items };
}

/** Builds (or reuses) the stitched cross-app graph of the selected projects. */
export async function ensureGraph(repo: RepoModel, projects: AlProject[], o: { force?: boolean; log?: Logger; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<GraphFile> {
  const dir = workDir(repo, "graph", selectionKey(projects));
  const file = join(dir, "graph.jsonl");
  const metaFile = join(dir, "graph.meta.json");
  const names = projects.map((p) => p.app.name);
  const fingerprint = sourceFingerprint(projects);
  if (!o.force && existsSync(file) && existsSync(metaFile)) {
    const meta = JSON.parse(readFileSync(metaFile, "utf8"));
    if (meta.fingerprint === fingerprint) return { file, rebuilt: false, projects: names, nodes: meta.nodes, edges: meta.edges };
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const args = ["graph", "extract-whole", ...projects.flatMap((p) => ["--corpus", p.path]), "--out", join(dir, "whole"), "--graph", file];
  const r = await runAltool(args, { log: o.log, timeoutMs: o.timeoutMs ?? 600_000, signal: o.signal });
  const failure = graphFailure(r.output, r.exitCode) ?? (existsSync(file) ? undefined : "altool did not write the graph file");
  if (failure) throw new Error(`Graph extraction failed: ${failure}`);
  const stitched = /Stitched (\d+) node\(s\), (\d+) edge\(s\)/.exec(r.output);
  const meta = { fingerprint, projects: names, nodes: stitched ? Number(stitched[1]) : undefined, edges: stitched ? Number(stitched[2]) : undefined, builtAt: new Date().toISOString() };
  writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  return { file, rebuilt: true, projects: names, nodes: meta.nodes, edges: meta.edges };
}
