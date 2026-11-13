import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Kind = "internal-plugin" | "external-plugin" | "external-marketplace" | "external-mcp" | "external-cli" | "external-extension";
export type Status = "core" | "recommended" | "optional" | "experimental" | "planned";
export type Profile = "core" | "recommended" | "full";

export interface McpDefinition {
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
}

export interface Step {
  commands?: string[];
  description?: string;
}

export interface Tool {
  id: string;
  kind: Kind;
  section?: "oli-tech";
  category: string;
  status: Status;
  owner: string;
  source?: string;
  path?: string;
  description: string;
  documentation: string;
  access: "read-only" | "read-write" | "destructive";
  auth: string;
  prerequisites?: string[];
  inputs?: string[];
  setup?: { method: "copilot-plugin" | "command" | "mcp-local" | "manual"; commands?: string[]; note?: string };
  mcp?: McpDefinition;
  update?: Step;
  verify?: Step;
  gaps?: string;
  /** How status recognizes tools without an MCP definition or plugin. */
  detect?: { command?: string; mcpArgs?: string[]; vscodeExtension?: string };
}

export interface Catalog {
  contractVersion: number;
  name: string;
  tools: Tool[];
}

export const PROFILES: Profile[] = ["core", "recommended", "full"];
const PROFILE_STATUSES: Record<Profile, Status[]> = {
  core: ["core"],
  recommended: ["core", "recommended"],
  full: ["core", "recommended", "optional"],
};

/** Packaged runtime ships a copy next to the bundle; in a checkout the repository root catalog is found by walking up. */
export function defaultCatalogFile(): string {
  if (process.env.BC_WHALE_CATALOG) return process.env.BC_WHALE_CATALOG;
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(directory, "catalog.json");
    if (existsSync(candidate)) return candidate;
    directory = dirname(directory);
  }
  throw new Error("catalog.json not found; set BC_WHALE_CATALOG");
}

export function loadCatalog(file = defaultCatalogFile()): Catalog {
  const catalog = JSON.parse(readFileSync(file, "utf8")) as Catalog;
  if (catalog.contractVersion !== 2 || !Array.isArray(catalog.tools)) throw new Error(`Unsupported catalog contract in ${file}`);
  return catalog;
}

export function findTool(catalog: Catalog, id: string): Tool {
  const tool = catalog.tools.find((entry) => entry.id === id);
  if (!tool) throw new Error(`Unknown tool: ${id}`);
  return tool;
}

/** Profile selects by status; explicit ids add any non-planned tool (including experimental). */
export function selectTools(catalog: Catalog, options: { profile?: Profile; ids?: string[] }): Tool[] {
  const selected = new Map<string, Tool>();
  if (options.profile) {
    if (!PROFILES.includes(options.profile)) throw new Error(`Unknown profile: ${options.profile}`);
    for (const tool of catalog.tools) {
      if (PROFILE_STATUSES[options.profile].includes(tool.status)) selected.set(tool.id, tool);
    }
  }
  for (const id of options.ids ?? []) {
    const tool = findTool(catalog, id);
    if (tool.status === "planned") throw new Error(`Tool ${id} is planned and not available yet`);
    selected.set(id, tool);
  }
  return catalog.tools.filter((tool) => selected.has(tool.id));
}

/** Copilot plugin name of a tool installed through `copilot plugin install <spec>`. */
export function pluginName(tool: Tool): string | undefined {
  const install = tool.setup?.commands?.find((command) => /^copilot plugin install /.test(command));
  if (!install) return undefined;
  const spec = install.split(/\s+/)[3];
  const name = spec.split("@")[0];
  return (name.includes("/") ? name.split("/").pop()! : name).toLowerCase();
}

export function explain(tool: Tool): string {
  const lines = [
    `${tool.id} (${tool.kind}, ${tool.category}, ${tool.status}${tool.section ? `, ${tool.section}` : ""})`,
    tool.description,
    `Owner: ${tool.owner}${tool.source ? ` - ${tool.source}` : ""}`,
    `Access: ${tool.access} · Auth: ${tool.auth}`,
  ];
  if (tool.prerequisites?.length) lines.push(`Prerequisites: ${tool.prerequisites.join(", ")}`);
  if (tool.inputs?.length) lines.push(`Inputs: ${tool.inputs.join(", ")}`);
  if (tool.mcp) lines.push(`MCP: ${tool.mcp.type === "http" ? tool.mcp.url : [tool.mcp.command, ...(tool.mcp.args ?? [])].join(" ")}`);
  if (tool.setup) lines.push(`Setup (${tool.setup.method}): ${[...(tool.setup.commands ?? []), tool.setup.note ?? ""].filter(Boolean).join(" ; ")}`);
  if (tool.update) lines.push(`Update: ${tool.update.commands?.join(" ; ") ?? tool.update.description}`);
  if (tool.verify) lines.push(`Verify: ${tool.verify.commands?.join(" ; ") ?? tool.verify.description}`);
  if (tool.gaps) lines.push(`Gaps: ${tool.gaps}`);
  lines.push(`Docs: ${tool.documentation}`);
  return lines.join("\n");
}
