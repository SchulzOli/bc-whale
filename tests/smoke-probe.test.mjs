import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const probeFile = fileURLToPath(new URL("../scripts/smoke-probe.mjs", import.meta.url));

test("stdio smoke probe honors its deadline instead of the SDK's 60 second default", { timeout: 75000 }, async () => {
  assert.ok(existsSync(probeFile), "smoke probe must expose the actual stdio probe for testing");
  const { probeStdio } = await import(pathToFileURL(probeFile).href);
  const server = `
    const rl = require("node:readline").createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const request = JSON.parse(line);
      if (request.method === "initialize") {
        setTimeout(() => console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
          protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "delayed", version: "1" }
        } })), 61000);
      } else if (request.method === "tools/list") {
        console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [
          { name: "ready", description: "ready", inputSchema: { type: "object" } }
        ] } }));
      }
    });
  `;
  assert.equal(await probeStdio({ command: process.execPath, args: ["-e", server] }, process.env, 70000), "1 tools");
});

test("stdio smoke probe fails within its deadline when the server does not respond", async () => {
  const { probeStdio } = await import(pathToFileURL(probeFile).href);
  const server = { command: process.execPath, args: ["-e", "process.stdin.resume()"] };
  await assert.rejects(probeStdio(server, process.env, 500), /no tool list within|Request timed out/);
});

test("stdio smoke probe uses one deadline for initialization and tool discovery", async () => {
  const { probeStdio } = await import(pathToFileURL(probeFile).href);
  const server = `
    require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
      const request = JSON.parse(line);
      if (request.method === "initialize") setTimeout(() => console.log(JSON.stringify({
        jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "delayed", version: "1" } }
      })), 400);
      if (request.method === "tools/list") setTimeout(() => console.log(JSON.stringify({
        jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "ready", inputSchema: { type: "object" } }] }
      })), 400);
    });
  `;
  await assert.rejects(probeStdio({ command: process.execPath, args: ["-e", server] }, process.env, 700), /no tool list within/);
});
