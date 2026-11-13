import type { Tool } from "./catalog.js";
import { pluginName } from "./catalog.js";
import { detectInstalled, installHint, isAvailable, requiredExecutables } from "./commands.js";
import { type Runner, run } from "./exec.js";
import { type HostId, type HostOptions, findEquivalent, hostFile, readEntries } from "./hosts.js";

export interface Prerequisite {
  name: string;
  found: boolean;
  version?: string;
  purpose: string;
}

const PREREQUISITES: { name: string; args: string[]; purpose: string }[] = [
  { name: "node", args: ["--version"], purpose: "bc-whale and whale runtimes, npx-based MCP servers" },
  { name: "npx", args: ["--version"], purpose: "npm-distributed MCP servers" },
  { name: "uvx", args: ["--version"], purpose: "Python-distributed MCP servers" },
  { name: "copilot", args: ["--version"], purpose: "Copilot plugin installs and updates" },
  { name: "git", args: ["--version"], purpose: "repositories and AL-Go" },
  { name: "docker", args: ["--version"], purpose: "local BC containers (bc-whale)" },
  { name: "az", args: ["version", "--output", "tsv"], purpose: "Azure MCP and cloud sandboxes" },
];

export interface ToolPrerequisite {
  tool: string;
  executable: string;
  found: boolean;
  hint?: string;
}

/** Executables the given tools need, checked once each. */
export async function toolDoctor(tools: Tool[], runner: Runner = run): Promise<ToolPrerequisite[]> {
  const found = new Map<string, Promise<boolean>>();
  const rows = tools.flatMap((tool) => requiredExecutables(tool).map((executable) => ({ tool: tool.id, executable })));
  return Promise.all(rows.map(async (row) => {
    if (!found.has(row.executable)) found.set(row.executable, isAvailable(row.executable, runner));
    const ok = await found.get(row.executable)!;
    const hint = ok ? undefined : installHint(row.executable);
    return { ...row, found: ok, ...(hint ? { hint } : {}) };
  }));
}

export async function doctor(runner: Runner = run): Promise<Prerequisite[]> {
  return Promise.all(PREREQUISITES.map(async ({ name, args, purpose }) => {
    const result = await runner(name, args, { timeoutMs: 30_000 });
    const found = result.started && result.code === 0;
    const version = found ? result.stdout.trim().split(/\r?\n/)[0] : undefined;
    return { name, found, purpose, ...(version ? { version } : {}) };
  }));
}

export interface InstalledPlugins {
  available: boolean;
  plugins: Map<string, string>;
  marketplaces: string;
}

/** Parses `copilot plugin list` lines such as "  • superpowers@superpowers-marketplace (v7.0.2)". */
export function parsePluginList(text: string): Map<string, string> {
  const plugins = new Map<string, string>();
  for (const match of text.matchAll(/^\s*[•*-]\s+([^\s@(]+)(?:@\S+)?\s+\(v?([^)\s]+)\)/gm)) {
    plugins.set(match[1].toLowerCase(), match[2]);
  }
  return plugins;
}

export async function installedPlugins(runner: Runner = run): Promise<InstalledPlugins> {
  const list = await runner("copilot", ["plugin", "list"], { timeoutMs: 60_000 });
  if (!list.started || list.code !== 0) return { available: false, plugins: new Map(), marketplaces: "" };
  const marketplaces = await runner("copilot", ["plugin", "marketplace", "list"], { timeoutMs: 60_000 });
  return { available: true, plugins: parsePluginList(list.stdout), marketplaces: marketplaces.code === 0 ? marketplaces.stdout : "" };
}

export interface ToolStatus {
  id: string;
  via: "mcp" | "plugin" | "marketplace" | "cli" | "unknown";
  installed: boolean;
  hosts: HostId[];
  /** Host entry names, when installed under a different name than the catalog id. */
  names?: Partial<Record<HostId, string>>;
  version?: string;
}

export function availableHosts(options: HostOptions): HostId[] {
  return options.repo ? ["copilot", "vscode", "repo"] : ["copilot", "vscode"];
}

/** "https://github.com/owner/repo" -> "owner/repo" (marketplace lists show "(GitHub: owner/repo)"). */
export function githubSlug(url: string | undefined): string | undefined {
  return url ? /^https:\/\/github\.com\/([^/]+\/[^/#?]+)/.exec(url)?.[1].replace(/\.git$/, "") : undefined;
}

export async function status(tools: Tool[], options: HostOptions & { runner?: Runner; plugins?: InstalledPlugins } = {}): Promise<ToolStatus[]> {
  const runner = options.runner ?? run;
  const hosts = availableHosts(options);
  const entries = Object.fromEntries(hosts.map((host) => [host, readEntries(hostFile(host, options), host)]));
  const needsPlugins = tools.some((tool) => pluginName(tool) || tool.kind === "external-marketplace");
  const plugins = options.plugins ?? (needsPlugins ? await installedPlugins(runner) : undefined);
  return Promise.all(tools.map(async (tool): Promise<ToolStatus> => {
    const plugin = pluginName(tool);
    if (plugin) {
      if (!plugins?.available) return { id: tool.id, via: "unknown", installed: false, hosts: [] };
      const version = plugins.plugins.get(plugin);
      return { id: tool.id, via: "plugin", installed: version !== undefined, hosts: version ? ["copilot"] : [], ...(version ? { version } : {}) };
    }
    if (tool.kind === "external-marketplace") {
      const slug = githubSlug(tool.source);
      if (!plugins?.available || !slug) return { id: tool.id, via: "unknown", installed: false, hosts: [] };
      const installed = plugins.marketplaces.toLowerCase().includes(`github: ${slug.toLowerCase()})`);
      return { id: tool.id, via: "marketplace", installed, hosts: installed ? ["copilot"] : [] };
    }
    if (tool.mcp || tool.detect?.mcpArgs) {
      const found: HostId[] = [];
      const names: Partial<Record<HostId, string>> = {};
      const tokens = tool.detect?.mcpArgs ?? [];
      for (const host of hosts) {
        const name = tool.mcp
          ? findEquivalent(entries[host], tool.mcp)
          : Object.keys(entries[host]).find((key) => {
            const args = entries[host][key].args;
            return Array.isArray(args) && args.some((arg) => tokens.includes(String(arg)));
          });
        if (name) {
          found.push(host);
          if (name !== tool.id) names[host] = name;
        }
      }
      return { id: tool.id, via: "mcp", installed: found.length > 0, hosts: found, ...(Object.keys(names).length ? { names } : {}) };
    }
    const detected = await detectInstalled(tool, runner);
    if (detected) return { id: tool.id, via: "cli", installed: detected.installed, hosts: [], ...(detected.version ? { version: detected.version } : {}) };
    return { id: tool.id, via: "unknown", installed: false, hosts: [] };
  }));
}