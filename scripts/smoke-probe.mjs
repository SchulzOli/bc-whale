import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const sdk = createRequire(fileURLToPath(new URL("../packages/whale/package.json", import.meta.url)));
const { Client } = await import(pathToFileURL(sdk.resolve("@modelcontextprotocol/sdk/client/index.js")).href);
const { StdioClientTransport } = await import(pathToFileURL(sdk.resolve("@modelcontextprotocol/sdk/client/stdio.js")).href);

export async function probeStdio(server, env, timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("probe timeout must be a positive integer");
  const client = new Client({ name: "bc-whale-smoke", version: "1.0.0" });
  let stderr = "";
  const transport = new StdioClientTransport({ command: server.command, args: server.args ?? [], env, stderr: "pipe" });
  transport.stderr?.on("data", (chunk) => (stderr = (stderr + chunk).slice(-2000)));
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no tool list within ${timeoutMs / 1000}s`)), timeoutMs); });
  try {
    const options = { timeout: timeoutMs };
    const { tools } = await Promise.race([client.connect(transport, options).then(() => client.listTools(undefined, options)), deadline]);
    if (!tools.length) throw new Error("server listed no tools");
    return `${tools.length} tools`;
  } catch (error) {
    throw new Error(`${error.message}${stderr ? `; stderr: ${stderr.trim().slice(-400)}` : ""}`);
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}
