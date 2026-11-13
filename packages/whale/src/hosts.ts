import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import type { McpDefinition, Tool } from "./catalog.js";

export type HostId = "copilot" | "vscode" | "repo";
export const HOSTS: HostId[] = ["copilot", "vscode", "repo"];

export interface HostOptions {
  home?: string;
  repo?: string;
  platform?: NodeJS.Platform;
  appData?: string;
}

export function hostFile(host: HostId, options: HostOptions = {}): string {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  switch (host) {
    case "copilot":
      return join(home, ".copilot", "mcp-config.json");
    case "vscode":
      if (platform === "win32") return join(options.appData ?? process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Code", "User", "mcp.json");
      if (platform === "darwin") return join(home, "Library", "Application Support", "Code", "User", "mcp.json");
      return join(home, ".config", "Code", "User", "mcp.json");
    case "repo":
      if (!options.repo) throw new Error("Host 'repo' requires a repository path");
      return join(options.repo, ".vscode", "mcp.json");
    default:
      throw new Error(`Unknown host: ${host}`);
  }
}

export const rootKey = (host: HostId) => (host === "copilot" ? "mcpServers" : "servers");

export function substitute(tool: Tool, inputs: Record<string, string>): McpDefinition {
  if (!tool.mcp) throw new Error(`${tool.id} has no MCP definition`);
  const replace = (value: string) => value.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, name: string) => {
    const supplied = inputs[name];
    if (supplied === undefined || supplied === "") throw new Error(`Missing input ${name} for ${tool.id}`);
    return supplied;
  });
  const { type, command, args, url } = tool.mcp;
  return type === "http"
    ? { type, url: replace(url!) }
    : { type, command: replace(command!), args: (args ?? []).map(replace) };
}

export function renderEntry(host: HostId, tool: Tool, inputs: Record<string, string>): Record<string, unknown> {
  const mcp = substitute(tool, inputs);
  if (host === "copilot") {
    return mcp.type === "http"
      ? { type: "http", url: mcp.url, tools: ["*"] }
      : { type: "local", command: mcp.command, args: mcp.args, tools: ["*"] };
  }
  return mcp.type === "http" ? { type: "http", url: mcp.url } : { type: "stdio", command: mcp.command, args: mcp.args };
}

function readText(file: string): { text: string; bom: boolean } {
  let text = readFileSync(file, "utf8");
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) text = text.slice(1);
  return { text, bom };
}

export function readEntries(file: string, host: HostId): Record<string, Record<string, unknown>> {
  if (!existsSync(file)) return {};
  const errors: ParseError[] = [];
  const data = parse(readText(file).text, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error(`Cannot parse ${file}; fix it before running whale`);
  return (data?.[rootKey(host)] ?? {}) as Record<string, Record<string, unknown>>;
}

const normalizeCommand = (command: unknown) => basename(String(command ?? "")).toLowerCase().replace(/\.(cmd|exe|ps1|bat)$/, "");

/** Whether a host entry runs the same server as the catalog definition; `{{INPUT}}` placeholders match any value. */
export function matches(definition: McpDefinition, entry: Record<string, unknown>): boolean {
  const url = typeof entry.url === "string" ? entry.url : undefined;
  if (definition.type === "http") return url !== undefined && url.replace(/\/$/, "") === definition.url!.replace(/\/$/, "");
  if (url !== undefined || normalizeCommand(entry.command) !== normalizeCommand(definition.command)) return false;
  const actual = Array.isArray(entry.args) ? entry.args.map(String) : [];
  const expected = definition.args ?? [];
  return actual.length === expected.length && expected.every((value, index) => {
    const pattern = new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{\\\{[A-Z0-9_]+\\\}\\\}/g, ".+")}$`);
    return pattern.test(actual[index]);
  });
}

export function findEquivalent(entries: Record<string, Record<string, unknown>>, definition: McpDefinition): string | undefined {
  return Object.keys(entries).find((name) => matches(definition, entries[name]));
}

const canonical = (value: unknown): string => JSON.stringify(value, (_, item) =>
  item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

export function sameEntry(a: unknown, b: unknown) {
  return canonical(a) === canonical(b);
}

export function backupName(file: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${file}.whale-${stamp}.bak`;
}

/** Fields whale owns in a host entry; everything else (env, headers, tools, ...) belongs to the user. */
const OWNED = ["type", "command", "args", "url"] as const;
const owned = (entry: Record<string, unknown>) => Object.fromEntries(OWNED.map((key) => [key, entry[key]]));

export interface MergeOptions {
  now?: Date;
  /** Files already backed up during this run; each file is backed up once, before its first change. */
  backedUp?: Set<string>;
}

function backup(file: string, now: Date) {
  const base = backupName(file, now);
  for (let index = 0; ; index++) {
    const target = index ? base.replace(/\.bak$/, `-${index}.bak`) : base;
    if (existsSync(target)) continue;
    copyFileSync(file, target, constants.COPYFILE_EXCL);
    return target;
  }
}

/**
 * Adds a named entry, or updates only whale-owned fields of an existing one; never touches other entries
 * or user fields. Backs up an existing file before its first change.
 */
export function mergeEntry(file: string, host: HostId, name: string, entry: Record<string, unknown>, options: MergeOptions = {}): "created" | "updated" | "unchanged" {
  const existed = existsSync(file);
  const current = readEntries(file, host)[name];
  if (current && sameEntry(owned(current), owned(entry))) return "unchanged";
  const { text, bom } = existed ? readText(file) : { text: "{}", bom: false };
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol };
  let updated = text;
  if (current) {
    for (const key of OWNED) {
      if (!sameEntry(current[key], entry[key])) updated = applyEdits(updated, modify(updated, [rootKey(host), name, key], entry[key], { formattingOptions }));
    }
  } else {
    updated = applyEdits(updated, modify(updated, [rootKey(host), name], entry, { formattingOptions }));
  }
  if (existed && !options.backedUp?.has(file)) {
    backup(file, options.now ?? new Date());
    options.backedUp?.add(file);
  } else if (!existed) {
    mkdirSync(dirname(file), { recursive: true });
  }
  writeFileSync(file, (bom ? "\ufeff" : "") + updated, "utf8");
  return current ? "updated" : "created";
}
