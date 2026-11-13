import type { Tool } from "./catalog.js";
import { pluginName } from "./catalog.js";
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
  via: "mcp" | "plugin" | "unknown";
  installed: boolean;
  hosts: HostId[];
  /** Host entry names, when installed under a different name than the catalog id. */
  names?: Partial<Record<HostId, string>>;
  version?: string;
}

export function availableHosts(options: HostOptions): HostId[] {
  return options.repo ? ["copilot", "vscode", "repo"] : ["copilot", "vscode"];
}

export async function status(tools: Tool[], options: HostOptions & { runner?: Runner; plugins?: InstalledPlugins } = {}): Promise<ToolStatus[]> {
  const hosts = availableHosts(options);
  const entries = Object.fromEntries(hosts.map((host) => [host, readEntries(hostFile(host, options), host)]));
  const needsPlugins = tools.some((tool) => pluginName(tool));
  const plugins = options.plugins ?? (needsPlugins ? await installedPlugins(options.runner) : undefined);
  return tools.map((tool): ToolStatus => {
    const plugin = pluginName(tool);
    if (plugin) {
      if (!plugins?.available) return { id: tool.id, via: "unknown", installed: false, hosts: [] };
      const version = plugins.plugins.get(plugin);
      return { id: tool.id, via: "plugin", installed: version !== undefined, hosts: version ? ["copilot"] : [], ...(version ? { version } : {}) };
    }
    if (tool.mcp) {
      const found: HostId[] = [];
      const names: Partial<Record<HostId, string>> = {};
      for (const host of hosts) {
        const name = findEquivalent(entries[host], tool.mcp);
        if (name) {
          found.push(host);
          if (name !== tool.id) names[host] = name;
        }
      }
      return { id: tool.id, via: "mcp", installed: found.length > 0, hosts: found, ...(Object.keys(names).length ? { names } : {}) };
    }
    return { id: tool.id, via: "unknown", installed: false, hosts: [] };
  });
}
