import type { Connection } from "./targets.js";

export type ProxyKind = "profile" | "snapshot";

/** Troubleshooting proxies share the API/OData endpoint, not the development endpoint. */
export function proxyArguments(kind: ProxyKind, connection: Connection, profileFolder: string, apiPort?: number) {
  if (apiPort !== undefined && (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535 || apiPort === 7049)) throw new Error("apiPort must be an API/OData port, not the development port 7049.");
  const args = [kind === "profile" ? "launchprofilingmcpproxy" : "launchsnapshotmcpproxy"];
  for (let i = 0; i < connection.args.length; i++) {
    if (connection.args[i] === "--port") { i++; continue; }
    args.push(connection.args[i]);
  }
  if (apiPort !== undefined) args.push("--port", String(apiPort));
  if (kind === "profile") args.push("--profilefolder", profileFolder);
  return args;
}
