import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { exec } from "./exec.js";
import { zipSync, strToU8 } from "fflate";

const dist = dirname(fileURLToPath(import.meta.url));
const sdk = (file: string) => pathToFileURL(join(dist, "..", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", file)).href;
function fixture(mode = "pass", production = false) {
  const root = mkdtempSync(join(tmpdir(), "bc-whale-profile-integration-"));
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "app.json"), JSON.stringify({ id: "11111111-1111-4111-8111-111111111111", name: "Probe", publisher: "Validation", version: "1.0.0.0" }));
  writeFileSync(join(root, "bc-whale.json"), JSON.stringify({ targets: { fake: { type: "cloud", environmentName: "Unused", environmentType: production ? "Production" : "Sandbox" } } }));
  const blob = Buffer.from(zipSync({
    "activity.alcpuprofile": strToU8(JSON.stringify({
      nodes: [{ id: 1, callFrame: { functionName: "RunWorkload", scriptId: "Page_50101", url: "al-preview://test", lineNumber: 0, columnNumber: 0 } }],
      samples: [1], timeDeltas: [1000], startTime: 0, endTime: 1000,
    })),
  })).toString("base64");
  const preload = join(root, "proxy.mjs");
  writeFileSync(preload, `
import fs from 'node:fs'; import path from 'node:path';
if (process.env.PROFILE_MODE === 'inspect-hang' && path.basename(process.argv[1]??'') === 'inspect') {
 fs.writeFileSync(process.env.PROFILE_PID, String(process.pid));
 setInterval(()=>{},1000); await new Promise(()=>{});
}
if (path.basename(process.argv[1]??'') === 'launchprofilingmcpproxy') {
 fs.writeFileSync(process.env.PROFILE_PID, String(process.pid));
 if (process.env.PROFILE_MODE === 'init-hang') { setInterval(()=>{},1000); await new Promise(()=>{}); }
 const {Server}=await import(${JSON.stringify(sdk("server/index.js"))});
 const {StdioServerTransport}=await import(${JSON.stringify(sdk("server/stdio.js"))});
 const {CallToolRequestSchema,ListToolsRequestSchema}=await import(${JSON.stringify(sdk("types.js"))});
 const server=new Server({name:'profiling-fixture',version:'1'},{capabilities:{tools:{}}});
 server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[]}));
 server.setRequestHandler(CallToolRequestSchema,async req=>{
  fs.appendFileSync(process.env.PROFILE_AUDIT,JSON.stringify(req.params)+'\\n');
  if(process.env.PROFILE_MODE==='call-hang') { await new Promise(()=>{}); }
  const scheduleId='11111111-1111-4111-8111-111111111111';
  if(req.params.name==='schedule_profiling') return {content:[{type:'text',text:JSON.stringify({scheduleId,targetSessionId:10,windowEndUtc:'2026-11-06T10:05:00Z',nextStep:'Reproduce the slow scenario now.'})}]};
  return {content:[{type:'text',text:JSON.stringify({scheduleId,targetSessionId:10,capturedActivityCount:1,profilesOverview:[]})},{type:'resource',resource:{uri:'alprofile://schedule/test',mimeType:'application/zip',blob:${JSON.stringify(blob)}}}]};
 });
 await server.connect(new StdioServerTransport());
 await new Promise(()=>{});
}
`);
  const env = {
    ...process.env, BC_WHALE_ALTOOL: process.execPath, BC_WHALE_HOME: join(root, "home"),
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, PROFILE_MODE: mode,
    PROFILE_PID: join(root, "pid"), PROFILE_AUDIT: join(root, "audit"),
  };
  return { root, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function assertProxyStopped(file: string) {
  if (!existsSync(file)) return;
  assert.throws(() => process.kill(Number(readFileSync(file, "utf8")), 0), /ESRCH/);
}

test("CLI schedules and collects through a real stdio proxy, then analyzes without any AL repo", { timeout: 15000 }, async () => {
  const f = fixture();
  try {
    const scheduled = await exec(process.execPath, [join(dist, "cli.js"), "-r", f.root, "profile", "schedule", "-t", "fake", "--session-id", "10", "--authorized-session", "--timeout-ms", "5000"], { env: f.env, timeoutMs: 10000 });
    assert.equal(scheduled.exitCode, 0, scheduled.output);
    const s = JSON.parse(scheduled.stdout);
    assert.equal(s.succeeded, true);
    assertProxyStopped(f.env.PROFILE_PID);
    const collected = await exec(process.execPath, [join(dist, "cli.js"), "-r", f.root, "profile", "collect", s.id, "--timeout-ms", "5000"], { env: f.env, timeoutMs: 10000 });
    assert.equal(collected.exitCode, 0, collected.output);
    const c = JSON.parse(collected.stdout);
    assert.equal(c.analysis.profiles[0].hotspots[0].functionName, "RunWorkload");
    const analyzed = await exec(process.execPath, [join(dist, "cli.js"), "profile", "analyze", c.archiveFile], { env: f.env, cwd: tmpdir(), timeoutMs: 5000 });
    assert.equal(analyzed.exitCode, 0, analyzed.output);
    assert.equal(JSON.parse(analyzed.stdout).succeeded, true);
    const calls = readFileSync(f.env.PROFILE_AUDIT, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(calls[0].arguments.targetSessionId, 10);
    assert.equal(calls[1].arguments.scheduleId, s.scheduleId);
    assertProxyStopped(f.env.PROFILE_PID);
  } finally { f.cleanup(); }
});

test("CLI rejects unauthorized sessions and production before starting the proxy", { timeout: 10000 }, async () => {
  const f = fixture("pass", true);
  try {
    for (const flags of [[], ["--authorized-session"]]) {
      const r = await exec(process.execPath, [join(dist, "cli.js"), "-r", f.root, "profile", "schedule", "-t", "fake", "--session-id", "10", ...flags], { env: f.env, timeoutMs: 5000 });
      assert.equal(r.exitCode, 1, r.output);
      assert.equal(JSON.parse(r.stdout).succeeded, false);
      assert.equal(existsSync(f.env.PROFILE_PID), false);
    }
  } finally { f.cleanup(); }
});

test("MCP exposes capture tools and propagates cancellation to its owned profiling proxy", { timeout: 18000 }, async () => {
  const f = fixture("call-hang");
  const client = new Client({ name: "profile-integration", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(dist, "mcp.js")], env: f.env, stderr: "pipe" }));
    const tools = await client.listTools();
    assert.ok(tools.tools.some(t => t.name === "bc_whale_profile_analyze"));
    const controller = new AbortController();
    const promise = client.callTool({ name: "bc_whale_profile_schedule", arguments: { repo: f.root, target: "fake", sessionId: 10, authorizedSession: true, timeoutMs: 8000 } }, undefined, { signal: controller.signal });
    const rejected = assert.rejects(promise);
    for (let i = 0; i < 80 && !existsSync(f.env.PROFILE_AUDIT); i++) await new Promise(r => setTimeout(r, 50));
    assert.ok(existsSync(f.env.PROFILE_AUDIT), "Proxy did not reach schedule call");
    controller.abort();
    await rejected;
    const captureRoot = join(f.root, ".bc-whale", "profiles", "captures");
    let state: { status?: string } = {};
    for (let i = 0; i < 100; i++) {
      const id = readdirSync(captureRoot)[0];
      state = JSON.parse(readFileSync(join(captureRoot, id, "capture.json"), "utf8"));
      if (state.status === "unknown") break;
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(state.status, "unknown");
    assertProxyStopped(f.env.PROFILE_PID);
  } finally { await client.close(); f.cleanup(); }
});

test("proxy initialization hangs respect the deadline and leave no local proxy process", { timeout: 12000 }, async () => {
  const f = fixture("init-hang");
  try {
    const r = await exec(process.execPath, [join(dist, "cli.js"), "-r", f.root, "profile", "schedule", "-t", "fake", "--session-id", "10", "--authorized-session", "--timeout-ms", "1000"], { env: f.env, timeoutMs: 10000 });
    assert.equal(r.exitCode, 1, r.output);
    const data = JSON.parse(r.stdout);
    assert.equal(data.timedOut, true);
    assertProxyStopped(f.env.PROFILE_PID);
  } finally { f.cleanup(); }
});

test("the total deadline includes Docker target inspection before the profiling proxy starts", { timeout: 12000 }, async () => {
  const f = fixture("inspect-hang");
  try {
    writeFileSync(join(f.root, "bc-whale.json"), JSON.stringify({ targets: { fake: { type: "docker", container: "unused" } } }));
    copyFileSync(process.execPath, join(f.root, process.platform === "win32" ? "docker.exe" : "docker"));
    const env = { ...f.env, PATH: `${f.root}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}` };
    const r = await exec(process.execPath, [join(dist, "cli.js"), "-r", f.root, "profile", "schedule", "-t", "fake", "--session-id", "10", "--authorized-session", "--timeout-ms", "800"], { env, timeoutMs: 9000 });
    assert.ok(r.durationMs < 7000, r.output);
    assert.equal(r.exitCode, 1, r.output);
    assert.equal(JSON.parse(r.stdout).timedOut, true);
    assertProxyStopped(f.env.PROFILE_PID);
  } finally { f.cleanup(); }
});
