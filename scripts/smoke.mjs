// Smoke check of a customer-like setup: a fresh user profile, `whale setup --profile full`,
// then every configured MCP server must start and every update source must answer.
// Usage: node scripts/smoke.mjs [--install] [--allow-blocked copilot,code] [--report smoke-report.json]
//   --install  really install (CI); without it the setup is planned only and MCP servers are probed from the catalog.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const install = flag("--install");
const allowBlocked = new Set(option("--allow-blocked", "").split(",").filter(Boolean));
const reportFile = option("--report", join(root, "smoke-report.json"));
const INPUTS = ["--input", "ORGANIZATION=bc-whale-smoke"];
const PROBE_TIMEOUT_MS = Number(option("--probe-timeout-ms", "240000"));

const sdk = createRequire(join(root, "packages", "whale", "package.json"));
const { Client } = await import(pathToFileURL(sdk.resolve("@modelcontextprotocol/sdk/client/index.js")).href);
const { StdioClientTransport } = await import(pathToFileURL(sdk.resolve("@modelcontextprotocol/sdk/client/stdio.js")).href);

// A brand-new user: host files, plugin state, pipx and dotnet tools all live in this folder.
const home = mkdtempSync(join(tmpdir(), "bc-whale-smoke-"));
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), BC_WHALE_HOME: join(home, ".bc-whale"), COPILOT_HOME: join(home, ".copilot") };
delete env.BC_WHALE_CATALOG;
// What `pipx ensurepath` and the .NET tool installer add for a real user.
env.PATH = [join(home, ".local", "bin"), join(home, ".dotnet", "tools"), env.PATH ?? env.Path].join(delimiter);
delete env.Path;
mkdirSync(env.APPDATA, { recursive: true });

const whaleCli = join(root, "packages", "whale", "runtime", "cli.js");
const checks = [];
const record = (area, name, ok, detail = "") => {
  checks.push({ area, name, ok, detail });
  process.stderr.write(`${ok ? "PASS" : "FAIL"} ${area} ${name}${detail ? `: ${detail}` : ""}\n`);
};

function whale(...whaleArgs) {
  const result = spawnSync(process.execPath, [whaleCli, "--json", ...whaleArgs], { env, encoding: "utf8", timeout: 1_800_000, maxBuffer: 64 * 1024 * 1024 });
  let json;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = undefined;
  }
  return { status: result.status, json, stderr: result.stderr };
}

const catalog = JSON.parse(readFileSync(join(root, "packages", "whale", "runtime", "catalog.json"), "utf8"));
const full = catalog.tools.filter((tool) => ["core", "recommended", "optional"].includes(tool.status));

// 1. Setup of the full profile on a fresh profile.
const setup = whale("setup", "--profile", "full", "--host", "copilot", "vscode", ...INPUTS, "--yes", ...(install ? [] : ["--dry-run"]));
const steps = install ? setup.json : setup.json?.steps;
record("setup", `whale setup --profile full${install ? "" : " --dry-run"}`, Array.isArray(steps), Array.isArray(steps) ? `${steps.length} steps` : setup.stderr.trim().slice(-500));
for (const step of steps ?? []) {
  const outcome = step.result ?? step.action;
  if (outcome === "failed") record("setup", `${step.tool}${step.host ? ` -> ${step.host}` : ""}`, false, (step.output ?? step.detail).slice(-500));
  else if (outcome === "blocked") {
    const executable = /^(\S+) not found on PATH/.exec(step.detail)?.[1] ?? (/copilot CLI not found/.test(step.detail) ? "copilot" : undefined);
    record("setup", `${step.tool} (blocked)`, executable !== undefined && allowBlocked.has(executable), step.detail);
  }
}

// 2. After a real install, status must report every non-blocked tool as installed.
if (install) {
  const blockedTools = new Set((steps ?? []).filter((step) => step.result === "blocked" || step.result === "manual").map((step) => step.tool));
  const states = whale("status").json ?? [];
  for (const tool of full) {
    if (blockedTools.has(tool.id)) continue;
    const state = states.find((entry) => entry.id === tool.id);
    record("status", tool.id, state?.installed === true, state ? `${state.via}${state.version ? ` ${state.version}` : ""}` : "missing from status");
  }
}

// 3. Every MCP server of the profile starts and lists tools (stdio) or answers (http).
function definitions() {
  const configFile = join(home, ".copilot", "mcp-config.json");
  if (install && existsSync(configFile)) {
    const servers = JSON.parse(readFileSync(configFile, "utf8")).mcpServers ?? {};
    return full.filter((tool) => tool.mcp).map((tool) => ({ id: tool.id, ...(servers[tool.id] ?? substitute(tool.mcp)) }));
  }
  return full.filter((tool) => tool.mcp).map((tool) => ({ id: tool.id, ...substitute(tool.mcp) }));
}

function substitute(mcp) {
  return JSON.parse(JSON.stringify(mcp).replaceAll("{{ORGANIZATION}}", "bc-whale-smoke"));
}

async function probeStdio(server) {
  const client = new Client({ name: "bc-whale-smoke", version: "1.0.0" });
  let stderr = "";
  const transport = new StdioClientTransport({ command: server.command, args: server.args ?? [], env, stderr: "pipe" });
  transport.stderr?.on("data", (chunk) => (stderr = (stderr + chunk).slice(-2000)));
  const timer = new Promise((_, reject) => setTimeout(() => reject(new Error(`no tool list within ${PROBE_TIMEOUT_MS / 1000}s`)), PROBE_TIMEOUT_MS));
  try {
    const { tools } = await Promise.race([client.connect(transport).then(() => client.listTools()), timer]);
    if (!tools.length) throw new Error("server listed no tools");
    return `${tools.length} tools`;
  } catch (error) {
    throw new Error(`${error.message}${stderr ? `; stderr: ${stderr.trim().slice(-400)}` : ""}`);
  } finally {
    await client.close().catch(() => {});
  }
}

async function probeHttp(server) {
  const response = await fetch(server.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bc-whale-smoke", version: "1.0.0" } } }),
    signal: AbortSignal.timeout(60_000),
  });
  // Servers behind OAuth answer 401/403 without a token: reachable, auth is the host's job.
  if (response.ok || response.status === 401 || response.status === 403) return `HTTP ${response.status}`;
  throw new Error(`HTTP ${response.status}`);
}

const servers = definitions();
for (let index = 0; index < servers.length; index += 3) {
  await Promise.all(servers.slice(index, index + 3).map(async (server) => {
    try {
      const detail = server.url ? await probeHttp(server) : await probeStdio(server);
      record("mcp", server.id, true, detail);
    } catch (error) {
      record("mcp", server.id, false, error.message);
    }
  }));
}

// 3b. MCP servers shipped inside installed Copilot plugins start from the installed copy.
if (install) {
  const pluginsRoot = join(env.COPILOT_HOME, "installed-plugins");
  const pluginDirs = existsSync(pluginsRoot)
    ? readdirSync(pluginsRoot).flatMap((marketplace) => readdirSync(join(pluginsRoot, marketplace), { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => join(pluginsRoot, marketplace, entry.name)))
    : [];
  for (const dir of pluginDirs) {
    const mcpFile = join(dir, "mcp.json");
    if (!existsSync(mcpFile)) continue;
    for (const [name, server] of Object.entries(JSON.parse(readFileSync(mcpFile, "utf8")).mcpServers ?? {})) {
      const resolved = JSON.parse(JSON.stringify(server).replaceAll("${PLUGIN_ROOT}", dir.replaceAll("\\", "\\\\")));
      try {
        record("plugin-mcp", name, true, resolved.url ? await probeHttp(resolved) : await probeStdio(resolved));
      } catch (error) {
        record("plugin-mcp", name, false, error.message);
      }
    }
  }
}

// 4. The AL MCP is repository-specific: bc-whale launches it for an AL repository (needs altool).
{
  try {
    const detail = await probeStdio({ command: process.execPath, args: [join(root, "packages", "bc-whale", "runtime", "cli.js"), "almcp", "--repo", join(root, "packages", "bc-whale", "fixtures", "upgrade", "candidate")] });
    record("mcp", "al-mcp (via bc-whale almcp)", true, detail);
  } catch (error) {
    record("mcp", "al-mcp (via bc-whale almcp)", false, error.message);
  }
}

// 5. Update sources answer for every tool of the profile, and GitHub sources exist.
const updates = whale("update", "--check", "--refresh").json ?? [];
for (const tool of full) {
  const info = updates.find((entry) => entry.id === tool.id);
  record("updates", tool.id, info !== undefined && !info.error, info?.error ?? info?.latest ?? info?.source ?? "missing");
}
const headers = { accept: "application/vnd.github+json", "user-agent": "bc-whale-smoke", ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
for (const tool of full) {
  const slug = tool.source && /^https:\/\/github\.com\/([^/]+\/[^/#?]+)/.exec(tool.source)?.[1];
  if (!slug) continue;
  const response = await fetch(`https://api.github.com/repos/${slug}`, { headers }).catch((error) => ({ ok: false, status: error.message }));
  const data = response.ok ? await response.json() : undefined;
  record("source", tool.id, response.ok, response.ok ? `${slug}${data.archived ? " (archived)" : ""}` : `${slug}: ${response.status}`);
}

const failed = checks.filter((check) => !check.ok);
const report = { install, platform: process.platform, node: process.version, home, passed: checks.length - failed.length, failed: failed.length, checks };
writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = checks.map((check) => `| ${check.ok ? "✅" : "❌"} | ${check.area} | ${check.name} | ${String(check.detail).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, 200)} |`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, [`## bc-whale smoke (${process.platform}${install ? ", install" : ", dry-run"})`, "", `${report.passed} passed, ${report.failed} failed`, "", "| | Area | Check | Detail |", "| --- | --- | --- | --- |", ...rows, ""].join("\n"));
}
process.stderr.write(`\n${report.passed} passed, ${report.failed} failed. Report: ${reportFile}\n`);
process.exit(failed.length ? 1 : 0);
