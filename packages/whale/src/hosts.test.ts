import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findTool, loadCatalog } from "./catalog.js";
import { findEquivalent, hostFile, mergeEntry, readEntries, renderEntry } from "./hosts.js";

const catalog = loadCatalog();
const learn = findTool(catalog, "microsoft-learn");
const playwright = findTool(catalog, "playwright");
const devops = findTool(catalog, "azure-devops");

function temp(run: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "whale-hosts-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("renders host-specific entries and substitutes inputs", () => {
  assert.deepEqual(renderEntry("copilot", learn, {}), { type: "http", url: "https://learn.microsoft.com/api/mcp", tools: ["*"] });
  assert.deepEqual(renderEntry("vscode", playwright, {}), { type: "stdio", command: "npx", args: ["@playwright/mcp@latest"] });
  assert.deepEqual(renderEntry("copilot", devops, { ORGANIZATION: "contoso" }).args, ["-y", "@azure-devops/mcp@latest", "contoso"]);
  assert.throws(() => renderEntry("vscode", devops, {}), /Missing input ORGANIZATION for azure-devops/);
});

test("host files follow each client's location", () => {
  assert.equal(hostFile("copilot", { home: "/h" }), join("/h", ".copilot", "mcp-config.json"));
  assert.equal(hostFile("vscode", { home: "/h", platform: "linux" }), join("/h", ".config", "Code", "User", "mcp.json"));
  assert.equal(hostFile("repo", { repo: "/r" }), join("/r", ".vscode", "mcp.json"));
  assert.throws(() => hostFile("repo", {}), /repository/);
  const previous = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = join("/custom", "copilot");
  try {
    assert.equal(hostFile("copilot"), join("/custom", "copilot", "mcp-config.json"));
    assert.equal(hostFile("copilot", { home: "/h" }), join("/h", ".copilot", "mcp-config.json"));
  } finally {
    if (previous === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = previous;
  }
});

test("a missing host file is created with the right root key and no backup", () => temp((directory) => {
  const file = join(directory, "sub", "mcp.json");
  assert.equal(mergeEntry(file, "vscode", "playwright", renderEntry("vscode", playwright, {})), "created");
  assert.ok(JSON.parse(readFileSync(file, "utf8")).servers.playwright);
  assert.equal(readdirSync(join(directory, "sub")).length, 1);
}));

test("merging keeps comments and foreign entries, backs up changes and is idempotent", () => temp((directory) => {
  const file = join(directory, "mcp-config.json");
  writeFileSync(file, '{\n  // mine\n  "mcpServers": { "other": { "type": "local", "command": "x" }, },\n}\n');
  const entry = renderEntry("copilot", learn, {});
  assert.equal(mergeEntry(file, "copilot", "microsoft-learn", entry, { now: new Date("2026-01-02T03:04:05Z") }), "created");
  const text = readFileSync(file, "utf8");
  assert.match(text, /\/\/ mine/);
  assert.deepEqual(Object.keys(readEntries(file, "copilot")), ["other", "microsoft-learn"]);
  assert.ok(existsSync(`${file}.whale-20260102030405.bak`));
  assert.equal(mergeEntry(file, "copilot", "microsoft-learn", entry, { now: new Date("2026-01-02T03:04:06Z") }), "unchanged");
  assert.ok(!existsSync(`${file}.whale-20260102030406.bak`));
}));

test("updates change only whale-owned fields and keep user settings", () => temp((directory) => {
  const file = join(directory, "mcp.json");
  const user = { type: "stdio", command: "npx", args: ["-y", "@azure-devops/mcp@latest", "old"], env: { A: "1" }, headers: { X: "${input:token}" } };
  writeFileSync(file, JSON.stringify({ servers: { "azure-devops": user } }));
  assert.equal(mergeEntry(file, "vscode", "azure-devops", { ...user, env: undefined, headers: undefined }), "unchanged");
  assert.equal(mergeEntry(file, "vscode", "azure-devops", renderEntry("vscode", devops, { ORGANIZATION: "new" })), "updated");
  const saved = readEntries(file, "vscode")["azure-devops"];
  assert.deepEqual(saved.args, ["-y", "@azure-devops/mcp@latest", "new"]);
  assert.deepEqual(saved.env, { A: "1" });
  assert.deepEqual(saved.headers, { X: "${input:token}" });
}));

test("several changes to one file in a run keep the original as the single backup", () => temp((directory) => {
  const file = join(directory, "mcp-config.json");
  const original = '{ "mcpServers": { "mine": { "type": "local", "command": "x" } } }';
  writeFileSync(file, original);
  const backedUp = new Set<string>();
  const now = new Date("2026-01-02T03:04:05Z");
  mergeEntry(file, "copilot", "microsoft-learn", renderEntry("copilot", learn, {}), { now, backedUp });
  mergeEntry(file, "copilot", "playwright", renderEntry("copilot", playwright, {}), { now, backedUp });
  const backups = readdirSync(directory).filter((name) => name.endsWith(".bak"));
  assert.deepEqual(backups, ["mcp-config.json.whale-20260102030405.bak"]);
  assert.equal(readFileSync(join(directory, backups[0]), "utf8"), original);
  mergeEntry(file, "copilot", "markitdown", renderEntry("copilot", findTool(catalog, "markitdown"), {}), { now });
  assert.equal(readdirSync(directory).filter((name) => name.endsWith(".bak")).length, 2);
}));

test("equivalent entries are found under other names, with placeholders as wildcards", () => {
  const entries = {
    "microsoftdocs/mcp": { type: "http", url: "https://learn.microsoft.com/api/mcp/" },
    ado: { type: "local", command: "npx.cmd", args: ["-y", "@azure-devops/mcp@latest", "fabrikam"] },
  };
  assert.equal(findEquivalent(entries, learn.mcp!), "microsoftdocs/mcp");
  assert.equal(findEquivalent(entries, devops.mcp!), "ado");
  assert.equal(findEquivalent(entries, playwright.mcp!), undefined);
});

test("unparseable host files are reported instead of overwritten", () => temp((directory) => {
  const file = join(directory, "mcp.json");
  mkdirSync(directory, { recursive: true });
  writeFileSync(file, "{ not json");
  assert.throws(() => mergeEntry(file, "vscode", "x", { type: "http", url: "https://x" }), /Cannot parse/);
  assert.equal(readFileSync(file, "utf8"), "{ not json");
}));
