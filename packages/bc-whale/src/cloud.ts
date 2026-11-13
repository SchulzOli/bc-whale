import { exec } from "./exec.js";

const BC_RESOURCE = "https://api.businesscentral.dynamics.com";
const ADMIN_API = `${BC_RESOURCE}/admin/v2.24`;

export interface TokenOptions {
  tenant?: string;
}

/**
 * Access token for the BC admin center API. Order:
 * 1. BC_ACCESS_TOKEN env var
 * 2. client credentials (BC_WHALE_CLIENT_ID / BC_WHALE_CLIENT_SECRET [+ BC_WHALE_TENANT]) - for CI
 * 3. Azure CLI (az login) - interactive developer machines
 */
export async function getAdminToken(o: TokenOptions = {}): Promise<string> {
  if (process.env.BC_ACCESS_TOKEN) return process.env.BC_ACCESS_TOKEN;
  const tenant = o.tenant ?? process.env.BC_WHALE_TENANT;
  if (process.env.BC_WHALE_CLIENT_ID && process.env.BC_WHALE_CLIENT_SECRET) {
    if (!tenant) throw new Error("BC_WHALE_TENANT (or target tenant) is required for client credentials.");
    const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: process.env.BC_WHALE_CLIENT_ID,
        client_secret: process.env.BC_WHALE_CLIENT_SECRET,
        scope: `${BC_RESOURCE}/.default`,
      }),
    });
    const body: any = await res.json();
    if (!res.ok) throw new Error(`Token request failed: ${body.error_description ?? res.status}`);
    return body.access_token;
  }
  const args = ["account", "get-access-token", "--resource", BC_RESOURCE, "--query", "accessToken", "-o", "tsv"];
  if (tenant) args.push("--tenant", tenant);
  const encodedArgs = Buffer.from(JSON.stringify(args), "utf8").toString("base64");
  const script = `$cliArgs = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedArgs}')) | ConvertFrom-Json; & az.cmd @cliArgs; exit $LASTEXITCODE`;
  const r = await (process.platform === "win32"
    ? exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { stream: false })
    : exec("az", args, { stream: false })).catch((e) => ({ exitCode: -1, stdout: "", stderr: String(e) }));
  if (r.exitCode !== 0 || !r.stdout.trim()) {
    throw new Error(`No admin token. Run 'az login${tenant ? ` --tenant ${tenant}` : ""}', or set BC_ACCESS_TOKEN / BC_WHALE_CLIENT_ID+BC_WHALE_CLIENT_SECRET. ${r.stderr.trim()}`);
  }
  return r.stdout.trim();
}

async function call(method: string, path: string, o: TokenOptions & { body?: unknown } = {}) {
  const token = await getAdminToken(o);
  const res = await fetch(`${ADMIN_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  let data: any = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const hint = res.status === 403 ? " (the signed-in identity needs BC admin rights - D365 admin / Global admin / delegated admin - in this tenant)" : "";
    throw new Error(`${method} ${path} -> ${res.status}${hint}: ${data?.message ?? data?.error?.message ?? text}`);
  }
  return data;
}

export const cloud = {
  listEnvironments: (o: TokenOptions) => call("GET", "/applications/businesscentral/environments", o).then((d) => d.value ?? d),
  getEnvironment: (name: string, o: TokenOptions) => call("GET", `/applications/businesscentral/environments/${encodeURIComponent(name)}`, o),
  createEnvironment: (name: string, o: TokenOptions & { countryCode: string; applicationVersion?: string; ringName?: string }) =>
    call("PUT", `/applications/businesscentral/environments/${encodeURIComponent(name)}`, {
      ...o,
      body: { environmentType: "Sandbox", countryCode: o.countryCode, ...(o.applicationVersion ? { applicationVersion: o.applicationVersion } : {}), ...(o.ringName ? { ringName: o.ringName } : {}) },
    }),
  copyEnvironment: (source: string, target: string, o: TokenOptions) =>
    call("POST", `/applications/businesscentral/environments/${encodeURIComponent(source)}/copy`, { ...o, body: { environmentName: target, type: "Sandbox" } }),
  deleteEnvironment: (name: string, o: TokenOptions) => call("DELETE", `/applications/businesscentral/environments/${encodeURIComponent(name)}`, o),
  operations: (name: string, o: TokenOptions) => call("GET", `/applications/businesscentral/environments/${encodeURIComponent(name)}/operations`, o).then((d) => d.value ?? d),
  listApps: (name: string, o: TokenOptions) => call("GET", `/applications/businesscentral/environments/${encodeURIComponent(name)}/apps`, o).then((d) => d.value ?? d),
  /** Install an AppSource / Microsoft app (e.g. a dependency) into an online environment. */
  installApp: (name: string, appId: string, o: TokenOptions & { version?: string }) =>
    call("POST", `/applications/businesscentral/environments/${encodeURIComponent(name)}/apps/${appId}/install`, {
      ...o,
      body: { useEnvironmentUpdateWindow: false, acceptIsvEula: true, installOrUpdateNeededDependencies: true, ...(o.version ? { targetVersion: o.version } : {}) },
    }),
  uninstallApp: (name: string, appId: string, o: TokenOptions) =>
    call("POST", `/applications/businesscentral/environments/${encodeURIComponent(name)}/apps/${appId}/uninstall`, { ...o, body: { useEnvironmentUpdateWindow: false, deleteData: false } }),
};
