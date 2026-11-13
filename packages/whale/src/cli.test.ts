import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));

function isolatedEnv(home: string): Record<string, string> {
  return { ...process.env as Record<string, string>, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData"), BC_WHALE_HOME: join(home, ".bc-whale") };
}

function cli(home: string, ...args: string[]) {
  return spawnSync(process.execPath, [join(here, "cli.js"), ...args], { encoding: "utf8", env: isolatedEnv(home), timeout: 30_000 });
}

test("CLI dry-run shows the plan and writes nothing; missing inputs fail", () => {
  const home = mkdtempSync(join(tmpdir(), "whale-cli-"));
  try {
    const dry = cli(home, "setup", "--tool", "microsoft-learn", "--host", "vscode", "--yes", "--dry-run");
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /\[create\] microsoft-learn -> vscode/);
    assert.deepEqual(readdirSync(home), []);
    const missing = cli(home, "setup", "--tool", "azure-devops", "--host", "vscode", "--yes");
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Missing input ORGANIZATION/);
    const applied = cli(home, "--json", "setup", "--tool", "azure-devops", "--host", "copilot", "--input", "ORGANIZATION=contoso", "--yes");
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout)[0].result, "applied");
    assert.ok(existsSync(join(home, ".copilot", "mcp-config.json")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("CLI setup, status and doctor accept tool ids", () => {
  const home = mkdtempSync(join(tmpdir(), "whale-cli-"));
  try {
    const dry = cli(home, "--json", "setup", "microsoft-learn", "--host", "vscode", "--yes", "--dry-run");
    assert.equal(dry.status, 0, dry.stderr);
    assert.deepEqual(JSON.parse(dry.stdout).steps.map((s: { tool: string }) => s.tool), ["microsoft-learn"]);
    const statusRun = cli(home, "--json", "status", "microsoft-learn", "playwright");
    assert.deepEqual(JSON.parse(statusRun.stdout).map((s: { id: string }) => s.id), ["microsoft-learn", "playwright"]);
    const doctorRun = cli(home, "--json", "doctor", "playwright");
    assert.deepEqual(JSON.parse(doctorRun.stdout).map((r: { executable: string }) => r.executable), ["npx"]);
    assert.equal(cli(home, "status", "nope").status, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("CLI explain and list read the catalog", () => {
  const home = mkdtempSync(join(tmpdir(), "whale-cli-"));
  try {
    const explained = cli(home, "explain", "bcquality");
    assert.equal(explained.status, 0, explained.stderr);
    assert.match(explained.stdout, /Access: read-only/);
    assert.equal(cli(home, "explain", "nope").status, 1);
    const list = JSON.parse(cli(home, "--json", "list").stdout);
    assert.ok(list.some((tool: { id: string }) => tool.id === "whale"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("MCP server exposes the whale tools and rejects unreviewed plans", { timeout: 30_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "whale-mcp-"));
  const client = new Client({ name: "whale-test", version: "1.0.0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(here, "mcp.js")], env: isolatedEnv(home), stderr: "pipe" }));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["whale_apply", "whale_doctor", "whale_explain", "whale_list", "whale_plan", "whale_status", "whale_updates"]);
    const rejected = await client.callTool({ name: "whale_apply", arguments: { planHash: "0".repeat(64), confirmCommands: true } });
    assert.equal(rejected.isError, true);
    const planned = await client.callTool({ name: "whale_plan", arguments: { tools: ["microsoft-learn"], hosts: ["copilot"] } });
    const { planHash } = JSON.parse((planned.content as { text: string }[])[0].text);
    assert.ok(!existsSync(join(home, ".copilot")));
    const applied = await client.callTool({ name: "whale_apply", arguments: { planHash, confirmCommands: false } });
    assert.notEqual(applied.isError, true, JSON.stringify(applied.content));
    assert.ok(existsSync(join(home, ".copilot", "mcp-config.json")));
  } finally {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  }
});
