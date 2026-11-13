import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const text = (value) => typeof value === "string" && value.trim().length > 0;
const https = (value) => { try { return new URL(value).protocol === "https:"; } catch { return false; } };
const identifier = /^[a-z][a-z0-9-]*$/;
const version = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const pluginSchema = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const mcpSchema = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

function frontmatter(file) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(readFileSync(file, "utf8"));
  requireValue(match, `${file}: missing YAML frontmatter`);
  const metadata = parseYaml(match[1]);
  requireValue(text(metadata?.description), `${file}: missing frontmatter description`);
  return metadata;
}

function localPath(root, path) {
  requireValue(text(path) && !isAbsolute(path), `Invalid local path: ${path}`);
  const resolved = resolve(root, path);
  requireValue(!relative(root, resolved).startsWith(".."), `Path escapes library: ${path}`);
  requireValue(existsSync(resolved), `Missing path: ${path}`);
  requireValue(!relative(realpathSync(root), realpathSync(resolved)).startsWith(".."), `Path escapes library through a link: ${path}`);
  return resolved;
}

const enums = {
  kind: ["internal-plugin", "external-plugin", "external-marketplace", "external-mcp", "external-cli"],
  category: ["management", "al-lifecycle", "bc-data", "quality", "knowledge", "devops", "azure", "testing", "workflow"],
  status: ["core", "recommended", "optional", "experimental", "planned"],
  access: ["read-only", "read-write", "destructive"],
  auth: ["none", "host-oauth", "host-credentials", "api-key-env", "azure-cli"],
};
const sections = ["oli-tech"];
const fields = new Set(["id", "kind", "section", "category", "status", "owner", "source", "path", "description", "documentation",
  "access", "auth", "prerequisites", "inputs", "setup", "mcp", "update", "verify", "gaps"]);
const commandList = (value) => Array.isArray(value) && value.length > 0 && value.every(text);
// whale executes setup/update commands, so only the Copilot plugin lifecycle is allowed.
const executable = (value) => value === undefined || value.every((command) => /^copilot plugin [a-z][\w@./ -]*$/i.test(command));

function validateStep(entry, name) {
  const step = entry[name];
  requireValue(step && typeof step === "object", `${entry.id}: missing ${name}`);
  requireValue(Object.keys(step).every((key) => ["commands", "description"].includes(key)), `${entry.id}: unknown ${name} field`);
  requireValue(commandList(step.commands) || text(step.description), `${entry.id}: ${name} needs commands or description`);
  if (name === "update") requireValue(executable(step.commands), `${entry.id}: update commands must be 'copilot plugin ...'`);
}

function validateConnection(entry) {
  if (entry.setup !== undefined) {
    requireValue(["copilot-plugin", "mcp-local", "manual"].includes(entry.setup.method), `${entry.id}: invalid setup method`);
    requireValue(commandList(entry.setup.commands) || text(entry.setup.note), `${entry.id}: setup needs commands or note`);
    requireValue(executable(entry.setup.commands), `${entry.id}: setup commands must be 'copilot plugin ...'`);
  }
  if (entry.mcp !== undefined) {
    const { mcp } = entry;
    requireValue(Object.keys(mcp).every((key) => ["type", "command", "args", "url"].includes(key)), `${entry.id}: unknown mcp field (credentials and headers are not allowed)`);
    if (mcp.type === "stdio") {
      requireValue(text(mcp.command) && !isAbsolute(mcp.command), `${entry.id}: stdio MCP needs a portable command`);
      requireValue((mcp.args ?? []).every((argument) => text(argument) && !isAbsolute(argument)), `${entry.id}: machine-specific MCP argument`);
    } else {
      requireValue(mcp.type === "http" && https(mcp.url), `${entry.id}: MCP must be stdio or HTTPS http`);
    }
    const declared = new Set(entry.inputs ?? []);
    for (const [, name] of JSON.stringify(mcp).matchAll(/\{\{([^}]*)\}\}/g)) {
      requireValue(declared.has(name), `${entry.id}: undeclared input {{${name}}}`);
    }
  }
  requireValue(entry.setup !== undefined || entry.mcp !== undefined, `${entry.id}: missing setup or mcp`);
  validateStep(entry, "update");
  validateStep(entry, "verify");
}

export function validateLibrary(root) {
  const catalog = read(join(root, "catalog.json"));
  requireValue(catalog.contractVersion === 2 && Array.isArray(catalog.tools), "Unsupported catalog contract");
  const ids = new Set();
  for (const entry of catalog.tools) {
    requireValue(text(entry.id) && identifier.test(entry.id), `Invalid id: ${entry.id}`);
    requireValue(!ids.has(entry.id), `Duplicate id: ${entry.id}`);
    ids.add(entry.id);
    for (const field of Object.keys(entry)) requireValue(fields.has(field), `${entry.id}: unknown field ${field}`);
    for (const field of ["owner", "description", "documentation"]) {
      requireValue(text(entry[field]), `${entry.id}: missing ${field}`);
    }
    for (const [field, allowed] of Object.entries(enums)) {
      requireValue(allowed.includes(entry[field]), `${entry.id}: invalid ${field} ${entry[field]}`);
    }
    requireValue(entry.section === undefined || sections.includes(entry.section), `${entry.id}: invalid section ${entry.section}`);
    if (!https(entry.documentation)) localPath(root, entry.documentation);
    if (entry.status === "planned") {
      requireValue(entry.path === undefined, `${entry.id}: planned tools must not declare a path`);
      continue;
    }
    validateConnection(entry);
    if (entry.kind === "internal-plugin") {
      const directory = localPath(root, entry.path);
      const manifest = read(join(directory, "plugin.json"));
      requireValue(manifest.$schema === pluginSchema, `${entry.id}: unsupported plugin schema`);
      requireValue(manifest.name === entry.id && version.test(manifest.version), `${entry.id}: invalid plugin identity/version`);
      requireValue(text(manifest.description) && text(manifest.author?.name), `${entry.id}: missing plugin description/author`);
      for (const file of ["README.md", "CHANGELOG.md", "EVALUATIONS.md"]) localPath(directory, file);
      const mcpFile = join(directory, "mcp.json");
      if (existsSync(mcpFile)) {
        const mcp = read(mcpFile);
        requireValue(mcp.$schema === mcpSchema && Object.keys(mcp.mcpServers ?? {}).length > 0, `${entry.id}: invalid MCP configuration`);
        for (const [name, server] of Object.entries(mcp.mcpServers)) {
          requireValue(["stdio", "streamable-http", "sse"].includes(server.type), `${name}: unsupported transport`);
          if (server.type === "stdio") {
            requireValue(text(server.command), `${name}: missing command`);
            for (const argument of server.args ?? []) {
              if (argument.startsWith("${PLUGIN_ROOT}/")) localPath(directory, argument.slice("${PLUGIN_ROOT}/".length));
              requireValue(!isAbsolute(argument), `${name}: machine-specific argument`);
            }
          } else requireValue(https(server.url), `${name}: HTTPS URL required`);
          requireValue(!Object.keys(server.headers ?? {}).some((key) => /authorization|api[-_]?key/i.test(key)), `${name}: credentials must not be committed`);
        }
      } else {
        const skills = localPath(directory, "skills");
        requireValue(readdirSync(skills).length > 0, `${entry.id}: plugin has no capabilities`);
      }
      const skills = join(directory, "skills");
      if (existsSync(skills)) {
        for (const name of readdirSync(skills)) {
          const metadata = frontmatter(localPath(directory, `skills/${name}/SKILL.md`));
          requireValue(metadata.name === name && identifier.test(name), `${entry.id}: skill name must match directory ${name}`);
        }
      }
      const agents = join(directory, "com.github.copilot", "agents");
      if (existsSync(agents)) {
        for (const name of readdirSync(agents)) {
          requireValue(name.endsWith(".agent.md"), `${entry.id}: invalid agent file ${name}`);
          frontmatter(localPath(directory, `com.github.copilot/agents/${name}`));
        }
      }
    } else {
      requireValue(https(entry.source), `${entry.id}: missing HTTPS upstream source`);
      requireValue(entry.path === undefined, `${entry.id}: external tools must not vendor local sources`);
    }
  }
  return catalog;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const catalog = validateLibrary(root);
  const marketplace = read(fileURLToPath(new URL("../.github/plugin/marketplace.json", import.meta.url)));
  const internal = catalog.tools.filter((entry) => entry.kind === "internal-plugin" && entry.status !== "planned");
  requireValue(marketplace.name === "bc-whale", "Unexpected marketplace identity");
  requireValue(marketplace.plugins.length === internal.length, "Marketplace/catalog plugin count mismatch");
  for (const entry of internal) {
    const plugin = marketplace.plugins.find((item) => item.name === entry.id);
    const manifest = read(join(root, entry.path, "plugin.json"));
    requireValue(plugin?.source === `./${entry.path}` && plugin?.version === manifest.version, `${entry.id}: marketplace identity/source/version mismatch`);
    const packageFile = join(root, entry.path, "package.json");
    if (existsSync(packageFile)) requireValue(read(packageFile).version === manifest.version, `${entry.id}: package/plugin version mismatch`);
  }
  console.log(`bc-whale catalog: ${internal.length} internal plugin(s), ${catalog.tools.length - internal.length} other tool(s) validated.`);
}
