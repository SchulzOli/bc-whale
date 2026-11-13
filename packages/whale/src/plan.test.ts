import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findTool, loadCatalog } from "./catalog.js";
import type { Runner } from "./exec.js";
import { hostFile } from "./hosts.js";
import { apply, plan } from "./plan.js";
import { doctor, parsePluginList, status } from "./status.js";

const catalog = loadCatalog();
const tools = (...ids: string[]) => ids.map((id) => findTool(catalog, id));

/** Fake copilot: optional plugin list, records invocations. */
function fakeRunner(options: { copilot?: boolean; plugins?: string; marketplaces?: string; fail?: string; npmPrefix?: string; bcl?: boolean } = {}) {
  const calls: string[] = [];
  const runner: Runner = async (command, args) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    if (line === "bcl --version") return options.bcl ? { code: 0, stdout: "bcl 0.8.0\n", stderr: "", started: true } : { code: null, stdout: "", stderr: "", started: false };
    if (line === "npm prefix -g" && options.npmPrefix) return { code: 0, stdout: `${options.npmPrefix}\n`, stderr: "", started: true };
    if (command !== "copilot" || options.copilot === false) return { code: null, stdout: "", stderr: "not found", started: false };
    if (line === "copilot plugin list") return { code: 0, stdout: options.plugins ?? "Installed plugins:\n", stderr: "", started: true };
    if (line === "copilot plugin marketplace list") return { code: 0, stdout: options.marketplaces ?? "", stderr: "", started: true };
    return { code: options.fail && line.includes(options.fail) ? 1 : 0, stdout: "ok", stderr: "", started: true };
  };
  return { runner, calls };
}

async function withHome(run: (home: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), "whale-plan-"));
  try {
    await run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("parses copilot plugin list output", () => {
  const plugins = parsePluginList("Built-in plugins:\n  • computer-use (v0.1.97) [disabled]\nInstalled plugins:\n  • superpowers@superpowers-marketplace (v7.0.2)\n  • bcquality (v1.10.0)\n");
  assert.equal(plugins.get("superpowers"), "7.0.2");
  assert.equal(plugins.get("bcquality"), "1.10.0");
});

test("doctor reports missing executables without failing", async () => {
  const { runner } = fakeRunner({ copilot: false });
  const result = await doctor(runner);
  assert.equal(result.find((p) => p.name === "copilot")?.found, false);
});

test("status matches MCP entries by command or URL and reports unknown plugins without copilot", () => withHome(async (home) => {
  const file = hostFile("copilot", { home });
  mkdirSync(join(home, ".copilot"));
  writeFileSync(file, JSON.stringify({ mcpServers: { "microsoftdocs/mcp": { type: "http", url: "https://learn.microsoft.com/api/mcp" } } }));
  const { runner } = fakeRunner({ copilot: false });
  const result = await status(tools("microsoft-learn", "bcquality", "playwright"), { home, platform: "linux", runner });
  assert.deepEqual(result[0], { id: "microsoft-learn", via: "mcp", installed: true, hosts: ["copilot"], names: { copilot: "microsoftdocs/mcp" } });
  assert.equal(result[1].via, "unknown");
  assert.equal(result[2].installed, false);
}));

test("plan covers mcp, plugin, manual and blocked steps", () => withHome(async (home) => {
  const { runner } = fakeRunner({ copilot: false });
  const result = await plan({ tools: tools("al-mcp", "bcquality", "microsoft-learn"), hosts: ["copilot", "vscode"], home, platform: "linux", runner });
  const byTool = (id: string) => result.steps.filter((step) => step.tool === id);
  assert.equal(byTool("al-mcp")[0].action, "manual");
  assert.match(byTool("al-mcp")[0].detail, /mcp register --almcp/);
  assert.deepEqual(byTool("bcquality").map((s) => s.action), ["blocked"]);
  assert.deepEqual(byTool("microsoft-learn").map((s) => [s.host, s.action]), [["copilot", "create"], ["vscode", "create"]]);
  assert.match(result.planHash, /^[0-9a-f]{64}$/);
}));

test("CLI-only tools become manual steps with their install note", () => withHome(async (home) => {
  const result = await plan({ tools: tools("bc-lantern"), hosts: ["copilot"], home });
  assert.deepEqual(result.steps.map((s) => [s.action, s.detail]), [["manual", "pipx install bc-lantern"]]);
}));

test("plan skips installed plugins and registered marketplaces", () => withHome(async (home) => {
  const { runner } = fakeRunner({ plugins: "  • whale@bc-whale (v0.2.0)\n", marketplaces: "  • superpowers-marketplace (GitHub: obra/superpowers-marketplace)\n" });
  const result = await plan({ tools: tools("whale", "superpowers"), hosts: ["copilot"], home, runner });
  assert.deepEqual(result.steps.map((s) => [s.tool, s.action]), [["whale", "unchanged"], ["superpowers", "unchanged"], ["superpowers", "run"]]);
}));

test("a command shared by several tools runs once", () => withHome(async (home) => {
  const { runner } = fakeRunner();
  const result = await plan({ tools: tools("whale", "bc-whale"), hosts: ["copilot"], home, runner });
  const add = result.steps.filter((s) => s.command === "copilot plugin marketplace add SchulzOli/bc-whale");
  assert.deepEqual(add.map((s) => [s.tool, s.action]), [["whale", "run"], ["bc-whale", "unchanged"]]);
  assert.equal(result.steps.filter((s) => s.action === "run").length, 3);
}));

test("an entry under the catalog id with extra user fields is left unchanged", () => withHome(async (home) => {
  mkdirSync(join(home, ".copilot"));
  writeFileSync(hostFile("copilot", { home }), JSON.stringify({ mcpServers: { "microsoft-learn": { type: "http", url: "https://learn.microsoft.com/api/mcp", headers: { X: "1" }, tools: ["search"] } } }));
  const result = await plan({ tools: tools("microsoft-learn"), hosts: ["copilot"], home });
  assert.equal(result.steps[0].action, "unchanged");
}));

test("missing inputs fail the plan before anything is written", () => withHome(async (home) => {
  await assert.rejects(plan({ tools: tools("azure-devops"), hosts: ["copilot"], home }), /Missing input ORGANIZATION/);
  assert.ok(!existsSync(join(home, ".copilot")));
}));

test("apply refuses a changed plan and writes nothing", () => withHome(async (home) => {
  const { runner } = fakeRunner();
  const options = { tools: tools("microsoft-learn"), hosts: ["copilot" as const], home, runner };
  await assert.rejects(apply(options, "0".repeat(64), { confirmCommands: true }), /Plan changed/);
  assert.ok(!existsSync(hostFile("copilot", { home })));
}));

test("apply writes MCP entries, skips unconfirmed commands, and is idempotent", () => withHome(async (home) => {
  const { runner, calls } = fakeRunner();
  const options = { tools: tools("microsoft-learn", "bcquality"), hosts: ["copilot" as const], home, runner };
  const first = await plan(options);
  const results = await apply(options, first.planHash, { confirmCommands: false });
  assert.deepEqual(results.map((r) => [r.tool, r.result]), [["microsoft-learn", "applied"], ["bcquality", "skipped"]]);
  assert.ok(!calls.some((call) => call.includes("install")));
  assert.equal(JSON.parse(readFileSync(hostFile("copilot", { home }), "utf8")).mcpServers["microsoft-learn"].url, "https://learn.microsoft.com/api/mcp");
  const second = await plan(options);
  assert.equal(second.steps[0].action, "unchanged");
}));

test("a failed command stops later commands of the same tool", () => withHome(async (home) => {
  const { runner, calls } = fakeRunner({ fail: "marketplace add" });
  const options = { tools: tools("superpowers"), hosts: ["copilot" as const], home, runner };
  const { planHash } = await plan(options);
  const results = await apply(options, planHash, { confirmCommands: true });
  assert.deepEqual(results.map((r) => r.result), ["failed", "skipped"]);
  assert.ok(!calls.some((call) => call.startsWith("copilot plugin install")));
}));

test("launchers are opt-in, written for own plugins only, idempotent and never overwrite foreign files", () => withHome(async (home) => {
  const bin = join(home, "npm");
  const { runner } = fakeRunner({ plugins: "  • whale@bc-whale (v0.2.1)\n  • bc-whale@bc-whale (v0.1.0)\n", npmPrefix: bin });
  const base = { tools: tools("whale", "bc-whale", "microsoft-learn"), hosts: ["copilot" as const], home, platform: "win32" as const, runner };
  assert.ok(!(await plan(base)).steps.some((s) => s.kind === "launcher"));
  const options = { ...base, launchers: true };
  const first = await plan(options);
  const launchers = first.steps.filter((s) => s.kind === "launcher");
  assert.deepEqual(launchers.map((s) => [s.file, s.action]), [
    [join(bin, "whale.cmd"), "create"], [join(bin, "whale.ps1"), "create"],
    [join(bin, "bc-whale.cmd"), "create"], [join(bin, "bc-whale.ps1"), "create"],
  ]);
  await apply(options, first.planHash, { confirmCommands: false });
  const cmd = readFileSync(join(bin, "whale.cmd"), "utf8");
  assert.ok(cmd.includes(join(home, ".copilot", "installed-plugins", "bc-whale", "whale", "runtime", "cli.js")));
  assert.ok((await plan(options)).steps.filter((s) => s.kind === "launcher").every((s) => s.action === "unchanged"));
  writeFileSync(join(bin, "bc-whale.cmd"), "@echo off\r\nnode something-else.js %*\r\n");
  const foreign = await plan(options);
  assert.equal(foreign.steps.find((s) => s.file === join(bin, "bc-whale.cmd"))?.action, "blocked");
  await apply(options, foreign.planHash, { confirmCommands: false });
  assert.match(readFileSync(join(bin, "bc-whale.cmd"), "utf8"), /something-else/);
}));

test("launchers use npm's bin folder outside Windows and block without npm", () => withHome(async (home) => {
  const { runner } = fakeRunner({ plugins: "  • whale@bc-whale (v0.2.1)\n", npmPrefix: "/usr/local" });
  const unix = await plan({ tools: tools("whale"), hosts: ["copilot"], home, platform: "linux", runner, launchers: true });
  const step = unix.steps.find((s) => s.kind === "launcher")!;
  assert.equal(step.file, join("/usr/local", "bin", "whale"));
  assert.match(step.content!, /^#!\/bin\/sh\n/);
  const { runner: noNpm } = fakeRunner({ plugins: "  • whale@bc-whale (v0.2.1)\n" });
  const blocked = await plan({ tools: tools("whale"), hosts: ["copilot"], home, runner: noNpm, launchers: true });
  assert.equal(blocked.steps.find((s) => s.kind === "launcher")?.action, "blocked");
}));
test("status detects AL MCP entries by arguments, CLIs by version command and marketplaces by source", () => withHome(async (home) => {
  mkdirSync(join(home, ".copilot"));
  writeFileSync(hostFile("copilot", { home }), JSON.stringify({ mcpServers: { "almcp-MyApp": { type: "local", command: "node", args: ["cli.js", "almcp", "--repo", "C:\\r"] } } }));
  const marketplaces = "Included with GitHub Copilot:\n  ◆ awesome-copilot (GitHub: github/awesome-copilot)\n";
  const { runner } = fakeRunner({ marketplaces, bcl: true });
  const result = await status(tools("al-mcp", "bc-lantern", "awesome-copilot"), { home, platform: "linux", runner });
  assert.deepEqual(result, [
    { id: "al-mcp", via: "mcp", installed: true, hosts: ["copilot"], names: { copilot: "almcp-MyApp" } },
    { id: "bc-lantern", via: "cli", installed: true, hosts: [], version: "0.8.0" },
    { id: "awesome-copilot", via: "marketplace", installed: true, hosts: ["copilot"] },
  ]);
  const { runner: bare } = fakeRunner();
  const missing = await status(tools("bc-lantern", "awesome-copilot"), { home, platform: "linux", runner: bare });
  assert.deepEqual(missing.map((s) => [s.via, s.installed]), [["cli", false], ["marketplace", false]]);
}));