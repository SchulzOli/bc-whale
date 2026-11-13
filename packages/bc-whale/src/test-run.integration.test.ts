import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { exec } from "./exec.js";

const dist = dirname(fileURLToPath(import.meta.url));

function fixture(mode: string) {
  const root = mkdtempSync(join(tmpdir(), "bc-whale-test-control-"));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "Tests"));
  writeFileSync(join(root, "Tests", "app.json"), JSON.stringify({
    id: "11111111-1111-1111-1111-111111111111", name: "Probe Tests", publisher: "Validation", version: "1.0.0.0",
  }));
  writeFileSync(join(root, "Tests", "Probe.al"), "codeunit 50100 Probe { Subtype = Test; }");
  writeFileSync(join(root, "bc-whale.json"), JSON.stringify({
    analyzers: [], targets: { fake: { type: "onprem", server: "http://unused", authentication: "Windows" } },
  }));
  const preload = join(root, "altool-fixture.mjs");
  writeFileSync(preload, `
import fs from 'node:fs'; import path from 'node:path';
const args=process.argv.slice(1), cmd=path.basename(args[0]??'');
const audit=process.env.TEST_AUDIT, mode=process.env.TEST_MODE;
const option=(name)=>args[args.indexOf(name)+1];
if (['workspace','listtests','runtests'].includes(cmd)) {
 fs.appendFileSync(audit,cmd+'\\n');
 if(cmd==='workspace') {
  if(mode==='compile-hang') { setInterval(()=>{},1000); await new Promise(()=>{}); }
  const folders=JSON.parse(fs.readFileSync(args[2],'utf8')).folders;
  for(const f of folders) {
   const app=JSON.parse(fs.readFileSync(path.join(f.path,'app.json'),'utf8'));
   fs.writeFileSync(path.join(option('--errorlogdirectory'),app.name+'_20261106_120000.errorLog.json'),JSON.stringify({issues: mode==='compile-error' ? [{ruleId:'AL0001',shortMessage:'Synthetic compile error',properties:{severity:'Error'}}] : []}));
   if(mode!=='compile-error') fs.writeFileSync(path.join(option('-o'),app.publisher+'_'+app.name+'_'+app.version+'.app'),'fixture');
  }
  process.exit(mode==='compile-error'?1:0);
 }
 if(cmd==='listtests') {
  if(mode==='discovery-hang') { setInterval(()=>{},1000); await new Promise(()=>{}); }
  if(mode==='shared-budget') await new Promise(r=>setTimeout(r,1100));
  console.log(JSON.stringify({codeunits:[{id:50100,name:'Probe',methods:[{name:'Run'}]}]})); process.exit(0);
 }
 if(cmd==='runtests') {
  fs.writeFileSync(process.env.TEST_PID,String(process.pid));
  if(mode==='test-hang') { setInterval(()=>{},1000); await new Promise(()=>{}); }
  if(mode==='shared-budget') await new Promise(r=>setTimeout(r,1100));
  console.log(JSON.stringify({succeeded:true,tests:[{method:'Run',result:'Passed'}]})); process.exit(0);
 }
}
`);
  const env = {
    ...process.env, BC_WHALE_ALTOOL: process.execPath, BC_WHALE_HOME: join(root, "home"),
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, TEST_AUDIT: join(root, "audit"),
    TEST_MODE: mode, TEST_PID: join(root, "pid"),
  };
  return { root, env, audit: () => existsSync(env.TEST_AUDIT) ? readFileSync(env.TEST_AUDIT, "utf8") : "" };
}

it("compile errors block MCP test execution before discovery or target access", { timeout: 15000 }, async () => {
  const f = fixture("compile-error");
  const client = new Client({ name: "test-control", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(dist, "mcp.js")], env: f.env, stderr: "pipe" }));
    const result = await client.callTool({ name: "bc_whale_test", arguments: { repo: f.root, target: "fake", timeoutMs: 5000 } });
    assert.equal(result.isError, true);
    const content = result.content;
    assert.ok(Array.isArray(content) && content[0].type === "text");
    const data = JSON.parse(content[0].text);
    assert.equal(data.phase, "build");
    assert.equal(data.build.succeeded, false);
    assert.equal(data.build.projects[0].errors, 1);
    assert.equal(f.audit(), "workspace\n");
  } finally { await client.close(); rmSync(f.root, { recursive: true, force: true }); }
});

it("successful build and tests still pass without publishing", { timeout: 15000 }, async () => {
  const f = fixture("pass");
  try {
    const result = await exec(process.execPath, [join(dist, "cli.js"), "-r", f.root, "test", "-t", "fake", "--timeout-ms", "7000"], { env: f.env, timeoutMs: 12000 });
    assert.equal(result.exitCode, 0, result.output);
    const data = JSON.parse(result.stdout);
    assert.equal(data.succeeded, true);
    assert.equal(data.projects[0].passed, 1);
    assert.match(data.deploymentNote, /does not publish/);
    assert.equal(f.audit(), "workspace\nlisttests\nruntests\n");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

it("test apps share the same deadline rather than renewing it for each subprocess", { timeout: 18000 }, async () => {
  const f = fixture("shared-budget");
  try {
    mkdirSync(join(f.root, "SecondTests"));
    writeFileSync(join(f.root, "SecondTests", "app.json"), JSON.stringify({
      id: "22222222-2222-2222-2222-222222222222", name: "Second Tests", publisher: "Validation", version: "1.0.0.0",
    }));
    writeFileSync(join(f.root, "SecondTests", "Probe.al"), "codeunit 50101 SecondProbe { Subtype = Test; }");
    const result = await exec(process.execPath, [join(dist, "cli.js"), "-r", f.root, "test", "-t", "fake", "--timeout-ms", "3500"], { env: f.env, timeoutMs: 12000 });
    assert.equal(result.exitCode, 1);
    const data = JSON.parse(result.stdout);
    assert.equal(data.timedOut, true, result.output);
    assert.equal(data.succeeded, false);
    assert.ok(result.durationMs < 10000);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

it("a hanging discovery returns under the total deadline without starting tests", { timeout: 15000 }, async () => {
  const f = fixture("discovery-hang");
  try {
    const result = await exec(process.execPath, [join(dist, "cli.js"), "-r", f.root, "test", "-t", "fake", "--timeout-ms", "2500"], { env: f.env, timeoutMs: 10000 });
    assert.equal(result.exitCode, 1);
    const data = JSON.parse(result.stdout);
    assert.equal(data.succeeded, false);
    assert.equal(data.phase, "discovery");
    assert.equal(data.timedOut, true);
    assert.equal(f.audit(), "workspace\nlisttests\n");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

it("a hanging compiler times out before discovery or target access", { timeout: 15000 }, async () => {
  const f = fixture("compile-hang");
  try {
    const result = await exec(process.execPath, [join(dist, "cli.js"), "-r", f.root, "test", "-t", "fake", "--timeout-ms", "2500"], { env: f.env, timeoutMs: 10000 });
    assert.equal(result.exitCode, 1, result.output);
    const data = JSON.parse(result.stdout);
    assert.equal(data.succeeded, false);
    assert.equal(data.phase, "build");
    assert.equal(data.timedOut, true);
    assert.equal(f.audit(), "workspace\n");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

it("a hanging runtime returns failure and warns about the BC server session", { timeout: 15000 }, async () => {
  const f = fixture("test-hang");
  try {
    const result = await exec(process.execPath, [join(dist, "cli.js"), "-r", f.root, "test", "-t", "fake", "--timeout-ms", "2500"], { env: f.env, timeoutMs: 10000 });
    assert.equal(result.exitCode, 1, result.output);
    const data = JSON.parse(result.stdout);
    assert.equal(data.succeeded, false);
    assert.equal(data.phase, "test");
    assert.equal(data.timedOut, true);
    assert.equal(data.projects[0].succeeded, false);
    assert.match(data.serverStateWarning, /server session may still be running/);
    const pid = Number(readFileSync(f.env.TEST_PID, "utf8"));
    assert.throws(() => process.kill(pid, 0), "the local runtime process has stopped");
    assert.equal(f.audit(), "workspace\nlisttests\nruntests\n");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

it("real MCP cancellation terminates the owned running test process", { timeout: 20000 }, async () => {
  const f = fixture("test-hang");
  const client = new Client({ name: "cancel-test", version: "1" });
  const controller = new AbortController();
  let running: Promise<unknown> | undefined;
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(dist, "mcp.js")], env: f.env, stderr: "pipe" }));
    running = client.callTool({ name: "bc_whale_test", arguments: { repo: f.root, target: "fake", timeoutMs: 12000 } }, undefined, { signal: controller.signal }).catch((e: unknown) => e);
    const deadline = Date.now() + 8000;
    while (!existsSync(f.env.TEST_PID) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(f.env.TEST_PID), "test process started");
    const pid = Number(readFileSync(f.env.TEST_PID, "utf8"));
    controller.abort();
    await running;
    const stoppedBy = Date.now() + 6500;
    let alive = true;
    while (alive && Date.now() < stoppedBy) {
      try { process.kill(pid, 0); } catch { alive = false; }
      if (alive) await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(alive, false, "cancel notification stopped the altool process");
    assert.equal(f.audit(), "workspace\nlisttests\nruntests\n");
  } finally {
    controller.abort();
    await running;
    await client.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
