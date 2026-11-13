import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { release } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { USER_DIR } from "./config.js";
import { exec, type Logger, silentLogger } from "./exec.js";
import { encryptWithKey, generatePassword, protectSecret, unprotectSecret } from "./secrets.js";

export const ARTIFACTS_CDN = "https://bcartifacts-exdbf9fwegejdqak.b02.azurefd.net";
export const DEFAULT_IMAGE_REPO = "mcr.microsoft.com/businesscentral";

export interface ContainerInfo {
  name: string;
  status: string;
  running: boolean;
  healthy?: string;
  ip?: string;
  image: string;
  bcVersion?: string;
  country?: string;
  artifactUrl?: string;
  auth?: string;
  useSSL: boolean;
  username?: string;
  managedByBcWhale: boolean;
}

async function docker(args: string[], log: Logger = silentLogger, stream = false, signal?: AbortSignal) {
  const r = await exec("docker", args, { log, stream, signal });
  if (r.terminationError) throw new Error(r.terminationError);
  signal?.throwIfAborted();
  if (r.exitCode !== 0) throw new Error(`docker ${args[0]} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

export async function inspectContainer(name: string, signal?: AbortSignal): Promise<ContainerInfo> {
  const raw = JSON.parse(await docker(["inspect", name], silentLogger, false, signal))[0];
  const env: Record<string, string> = {};
  for (const e of raw.Config?.Env ?? []) {
    const i = e.indexOf("=");
    env[e.slice(0, i).toLowerCase()] = e.slice(i + 1);
  }
  const nets = raw.NetworkSettings?.Networks ?? {};
  const ip = Object.values<any>(nets).map((n) => n.IPAddress).find((x) => x) as string | undefined;
  const labels = raw.Config?.Labels ?? {};
  return {
    name: String(raw.Name).replace(/^\//, ""),
    status: raw.State?.Status,
    running: !!raw.State?.Running,
    healthy: raw.State?.Health?.Status,
    ip,
    image: raw.Config?.Image,
    bcVersion: labels.version ?? env.artifacturl?.match(/\/(\d+\.\d+\.\d+\.\d+)\//)?.[1],
    country: labels.country ?? env.artifacturl?.match(/\/\d+\.\d+\.\d+\.\d+\/([a-z0-9]{2})(?:[/?]|$)/i)?.[1],
    artifactUrl: env.artifacturl,
    auth: env.auth ?? "NavUserPassword",
    useSSL: (env.usessl ?? "N").toUpperCase() === "Y",
    username: env.username,
    managedByBcWhale: labels["bc-whale"] === "1",
  };
}

export async function listContainers(): Promise<ContainerInfo[]> {
  // BcContainerHelper containers carry label "nav", bc-whale containers "bc-whale=1".
  const names = new Set<string>();
  for (const label of ["nav", "bc-whale=1"]) {
    for (const n of (await docker(["ps", "-a", "--filter", `label=${label}`, "--format", "{{.Names}}"])).split(/\r?\n/)) if (n) names.add(n);
  }
  return Promise.all([...names].map(name => inspectContainer(name)));
}

// ---------- artifacts ----------

export interface ArtifactSpec {
  type: "sandbox" | "onprem";
  version: string; // "latest", "29", "29.1", or full version
  country: string;
}

/** Accepts "sandbox/29/de", "onprem/latest/w1", AL-Go style "/(asterisk)/latest", "29.0.54011.55816/de" or a full URL. */
export function parseArtifactSpec(spec: string, defaultCountry = "w1"): ArtifactSpec | { url: string } {
  if (/^https?:\/\//i.test(spec)) return { url: spec };
  const parts = spec.replace(/^\/+/, "").split("/").map((p) => p.trim());
  let type: "sandbox" | "onprem" = "sandbox";
  if (parts[0] === "sandbox" || parts[0] === "onprem") type = parts.shift() as "sandbox" | "onprem";
  else if (parts[0] === "" || parts[0] === "*") parts.shift();
  const version = parts[0] && parts[0] !== "*" ? parts[0] : "latest";
  const country = parts[1] && parts[1] !== "*" && parts[1] !== "" ? parts[1] : defaultCountry;
  return { type, version, country };
}

export async function resolveArtifactUrl(spec: string, defaultCountry = "w1"): Promise<{ url: string; version: string; country: string; type: string }> {
  const parsed = parseArtifactSpec(spec, defaultCountry);
  if ("url" in parsed) {
    const m = /\/(sandbox|onprem)\/([\d.]+)\/(\w+)/i.exec(parsed.url);
    return { url: parsed.url, version: m?.[2] ?? "?", country: m?.[3] ?? "?", type: m?.[1] ?? "?" };
  }
  const index = await fetchJson<{ Version: string }[]>(`${ARTIFACTS_CDN}/${parsed.type}/indexes/${parsed.country}.json`);
  const versions = index.map((x) => x.Version);
  let match: string | undefined;
  if (parsed.version === "latest") match = versions.sort(cmp).at(-1);
  else if (/^\d+(\.\d+){3}$/.test(parsed.version)) match = versions.find((v) => v === parsed.version);
  else match = versions.filter((v) => v === parsed.version || v.startsWith(parsed.version + ".")).sort(cmp).at(-1);
  if (!match) throw new Error(`No ${parsed.type} artifact '${parsed.version}' for country '${parsed.country}'.`);
  return { url: `${ARTIFACTS_CDN}/${parsed.type}/${match}/${parsed.country}`, version: match, country: parsed.country, type: parsed.type };
}

function cmp(a: string, b: string) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 4; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return (await res.json()) as T;
}

/** Download + extract one artifact into <cache>/<url path>, atomically (the image skips existing folders). */
async function ensureArtifact(url: string, cache: string, log: Logger): Promise<string> {
  const u = new URL(url);
  const dest = join(cache, ...decodeURIComponent(u.pathname).split("/").filter(Boolean));
  if (existsSync(join(dest, "manifest.json"))) {
    log(`Artifact cached: ${dest}`);
    return dest;
  }
  rmSync(dest, { recursive: true, force: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  const zip = `${tmp}.zip`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  log(`Downloading ${u.pathname}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`GET ${url} -> ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  let received = 0;
  let lastPct = -10;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      const pct = total ? Math.floor((received / total) * 100) : 0;
      if (total && pct >= lastPct + 10) {
        lastPct = pct;
        log(`  ${pct}% of ${(total / 1048576).toFixed(0)} MB`);
      }
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as any), counter, createWriteStream(zip));
  log(`Extracting ${u.pathname}`);
  const r = await exec("tar", ["-xf", zip, "-C", tmp], { stream: false });
  rmSync(zip, { force: true });
  if (r.exitCode !== 0) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(`Extracting ${url} failed: ${(r.stderr || r.stdout).trim().slice(-500)}`);
  }
  renameSync(tmp, dest);
  return dest;
}

/**
 * Download application + platform artifacts on the host into the shared cache that is mounted as c:\dl,
 * mirroring the image's Download-Artifacts logic (manifest redirects, platformUrl).
 */
export async function downloadArtifacts(artifactUrl: string, cache: string, log: Logger = silentLogger) {
  let url = artifactUrl;
  let appPath: string;
  let manifest: any;
  for (;;) {
    appPath = await ensureArtifact(url, cache, log);
    manifest = JSON.parse(readFileSync(join(appPath, "manifest.json"), "utf8").replace(/^\uFEFF/, ""));
    if (!manifest.applicationUrl) break;
    const u = new URL(url);
    url = /^https:\/\//.test(manifest.applicationUrl) ? manifest.applicationUrl : `https://${u.host}/${manifest.applicationUrl}${u.search}`;
  }
  const u = new URL(url);
  let platformUrl: string = manifest.platformUrl ?? `${u.pathname.slice(0, u.pathname.lastIndexOf("/"))}/platform`.replace(/^\//, "");
  if (!/^https:\/\//.test(platformUrl)) platformUrl = `https://${u.host}/${platformUrl}${u.search}`;
  const platformPath = await ensureArtifact(platformUrl, cache, log);
  return { appPath, platformPath };
}

// ---------- credentials ----------

function containerDir(name: string) {
  return join(USER_DIR, "containers", name);
}

export interface ContainerCredential {
  username: string;
  password: string;
}

export async function saveContainerCredential(name: string, cred: ContainerCredential) {
  const dir = containerDir(name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "credential.json"), JSON.stringify({ username: cred.username, password: await protectSecret(cred.password) }, null, 2));
}

export async function loadContainerCredential(name: string, signal?: AbortSignal): Promise<ContainerCredential | undefined> {
  const f = join(containerDir(name), "credential.json");
  if (!existsSync(f)) return undefined;
  const raw = JSON.parse(readFileSync(f, "utf8"));
  return { username: raw.username, password: await unprotectSecret(raw.password, signal) };
}

// ---------- lifecycle ----------

export interface CreateContainerOptions {
  name: string;
  artifact: string;
  country?: string;
  username?: string;
  password?: string;
  auth?: "NavUserPassword" | "Windows";
  memory?: string;
  image?: string;
  isolation?: "process" | "hyperv";
  licenseFile?: string;
  publishPorts?: boolean;
  artifactCache?: string;
  replace?: boolean;
  wait?: boolean;
  timeoutMinutes?: number;
  log?: Logger;
}

/** Pick the generic image tag that matches the host OS build. */
export function defaultImage(): { image: string; isolation: "process" | "hyperv" } {
  const build = parseInt(release().split(".")[2] ?? "0", 10);
  if (process.platform !== "win32") return { image: `${DEFAULT_IMAGE_REPO}:ltsc2022`, isolation: "hyperv" };
  if (build >= 26100) return { image: `${DEFAULT_IMAGE_REPO}:ltsc2025`, isolation: "process" };
  if (build >= 20348) return { image: `${DEFAULT_IMAGE_REPO}:ltsc2022`, isolation: "process" };
  return { image: `${DEFAULT_IMAGE_REPO}:ltsc2022`, isolation: "hyperv" };
}

export async function createContainer(o: CreateContainerOptions) {
  const log = o.log ?? silentLogger;
  if (!/^[a-z][a-z0-9-]{1,14}$/i.test(o.name)) throw new Error("Container name must be 2-15 chars, letters/digits/hyphen, starting with a letter (NetBIOS limit).");
  const art = await resolveArtifactUrl(o.artifact, o.country ?? "w1");
  log(`Artifact: ${art.url}`);
  const existing = await exec("docker", ["inspect", o.name], { stream: false });
  if (existing.exitCode === 0) {
    if (!o.replace) throw new Error(`Container '${o.name}' already exists. Use replace to recreate it.`);
    log(`Removing existing container ${o.name}`);
    await docker(["rm", "-f", o.name]);
  }
  const def = defaultImage();
  const image = o.image ?? def.image;
  const isolation = o.isolation ?? def.isolation;
  const auth = o.auth ?? "NavUserPassword";
  const username = o.username ?? "admin";
  const password = o.password ?? generatePassword();

  const dir = containerDir(o.name);
  const myDir = join(dir, "my");
  rmSync(myDir, { recursive: true, force: true });
  mkdirSync(myDir, { recursive: true });
  // The generic image decrypts securePassword with this key and deletes the key file afterwards.
  const key = randomBytes(32);
  // SetupVariables.ps1 reads it with Get-Content and casts to byte[] -> one decimal byte per line.
  writeFileSync(join(myDir, "aes.key"), Array.from(key).join("\r\n") + "\r\n");
  const securePassword = await encryptWithKey(password, key);

  const cache = o.artifactCache ?? (process.platform === "win32" ? "C:\\bcartifacts.cache" : undefined);
  if (cache) {
    mkdirSync(cache, { recursive: true });
    await downloadArtifacts(art.url, cache, log);
  }

  const args = [
    "run", "-d",
    "--name", o.name,
    "--hostname", o.name,
    "--isolation", isolation,
    "--memory", o.memory ?? "8G",
    "--restart", "unless-stopped",
    "--label", "bc-whale=1",
    "-v", `${myDir}:c:\\run\\my`,
    "-e", "accept_eula=Y",
    "-e", "accept_outdated=Y",
    "-e", `artifactUrl=${art.url}`,
    "-e", `auth=${auth}`,
    "-e", `username=${username}`,
    "-e", `securePassword=${securePassword}`,
    "-e", "passwordKeyFile=c:\\run\\my\\aes.key",
    "-e", "removePasswordKeyFile=Y",
    "-e", "useSSL=N",
    "-e", "enableApiServices=Y",
    "-e", "ExitOnError=N",
  ];
  if (art.type === "sandbox") args.push("-e", "isBcSandbox=Y");
  if (cache) args.push("-v", `${cache}:c:\\dl`);
  if (o.licenseFile) {
    const lic = join(myDir, "license" + (o.licenseFile.toLowerCase().endsWith(".flf") ? ".flf" : ".bclicense"));
    writeFileSync(lic, readFileSync(o.licenseFile));
    args.push("-e", `licenseFile=c:\\run\\my\\${lic.split(/[\\/]/).pop()}`);
  }
  if (o.publishPorts) args.push("-p", "80:80", "-p", "7048:7048", "-p", "7049:7049", "-p", "7085:7085", "-p", "7086:7086");
  args.push(image);

  await saveContainerCredential(o.name, { username, password });
  log(`Starting container ${o.name} (${image}, ${isolation})`);
  await docker(args);
  const result = { name: o.name, artifactUrl: art.url, version: art.version, country: art.country, image, username, auth };
  if (o.wait === false) return { ...result, ready: false };
  await waitForContainer(o.name, { timeoutMinutes: o.timeoutMinutes ?? 60, log });
  const info = await inspectContainer(o.name);
  return { ...result, ready: true, ip: info.ip, webClient: `http://${info.ip}/BC/` };
}

export async function waitForContainer(name: string, o: { timeoutMinutes?: number; log?: Logger } = {}) {
  const log = o.log ?? silentLogger;
  const deadline = Date.now() + (o.timeoutMinutes ?? 60) * 60_000;
  let printed = 0;
  for (;;) {
    const logs = await exec("docker", ["logs", name], { stream: false });
    const lines = (logs.stdout + logs.stderr).split(/\r?\n/).filter((l) => l.trim());
    for (const l of lines.slice(printed)) log(`[${name}] ${l}`);
    printed = lines.length;
    if (lines.some((l) => l.includes("Ready for connections!"))) return;
    const fatal = lines.find((l) => /^ERROR|Initializing\.\.\. failed|Exception/i.test(l.trim()));
    const scriptError = lines.findIndex((l) => /^at .*C:\\Run\\\w+\.ps1: line \d+/i.test(l.trim()));
    if (scriptError > 0) throw new Error(`Container ${name} setup failed: ${lines.slice(Math.max(0, scriptError - 3), scriptError + 1).join(" | ")}`);
    const info = await inspectContainer(name);
    if (!info.running) throw new Error(`Container ${name} stopped during setup. ${fatal ?? ""}`);
    if (Date.now() > deadline) throw new Error(`Timeout waiting for container ${name} to become ready.`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

export async function containerAction(name: string, action: "start" | "stop" | "restart" | "remove") {
  if (action === "remove") {
    await docker(["rm", "-f", name]);
    rmSync(containerDir(name), { recursive: true, force: true });
    return { name, removed: true };
  }
  await docker([action, name]);
  return { name, action };
}

export async function containerLogs(name: string, tail = 200) {
  const r = await exec("docker", ["logs", "--tail", String(tail), name], { stream: false });
  return (r.stdout + r.stderr).trim();
}

/** Run a PowerShell script inside the container with the NAV/BC management cmdlets loaded. */
export async function invokeInContainer(name: string, script: string, log: Logger = silentLogger) {
  const prelude =
    "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';" +
    // prompt.ps1 is the image's own module loader and knows every BC version's admin module layout.
    ". 'c:\\run\\prompt.ps1' -silent *> $null;";
  const encoded = Buffer.from(prelude + script, "utf16le").toString("base64");
  const r = await exec("docker", ["exec", name, "powershell", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", encoded], { log, stream: true });
  if (r.exitCode !== 0) throw new Error(`Script in container ${name} failed: ${(r.stderr || r.stdout).trim().split(/\r?\n/).slice(-5).join(" | ")}`);
  return r.stdout;
}

export const TEST_TOOLKIT_APPS = [
  "Permissions Mock",
  "Test Runner",
  "Any",
  "Library Assert",
  "Library Variable Storage",
  "System Application Test Library",
  "Business Foundation Test Libraries",
  "Application Test Library",
  "Tests-TestLibraries",
];

/**
 * Publish, sync and install Microsoft apps that ship with the artifact (e.g. test toolkit or any
 * Microsoft dependency) by app name. Already installed apps are skipped. Retries until no more
 * progress so dependency order does not matter.
 */
export async function installArtifactApps(name: string, appNames: string[], log: Logger = silentLogger) {
  const script = `
$names = '${JSON.stringify(appNames).replace(/'/g, "''")}' | ConvertFrom-Json
$installed = @(Get-NAVAppInfo -ServerInstance BC -Tenant default -TenantSpecificProperties | Where-Object { $_.IsInstalled } | ForEach-Object { $_.Name })
$files = Get-ChildItem 'C:\\Applications*' -Recurse -Filter '*.app' -ErrorAction SilentlyContinue
$todo = @()
foreach ($n in $names) {
  if ($installed -contains $n) { Write-Host "already installed: $n"; continue }
  $f = $files | Where-Object { $_.Name -ieq ("Microsoft_" + $n + ".app") } | Sort-Object { $_.FullName -like 'C:\\Applications.*' } -Descending | Select-Object -First 1
  if (-not $f) { Write-Host "not found in artifact: $n"; continue }
  $todo += $f
}
$result = @{ installed = @(); failed = @(); skipped = @($installed | Where-Object { $names -contains $_ }) }
for ($round = 0; $round -lt 6 -and $todo.Count -gt 0; $round++) {
  $next = @()
  foreach ($f in $todo) {
    try {
      $info = Get-NAVAppInfo -Path $f.FullName
      $pub = Get-NAVAppInfo -ServerInstance BC -Name $info.Name -Publisher $info.Publisher -Version $info.Version -ErrorAction SilentlyContinue
      if (-not $pub) { Publish-NAVApp -ServerInstance BC -Path $f.FullName -SkipVerification | Out-Null }
      Sync-NAVApp -ServerInstance BC -Name $info.Name -Publisher $info.Publisher -Version $info.Version -Tenant default | Out-Null
      Install-NAVApp -ServerInstance BC -Name $info.Name -Publisher $info.Publisher -Version $info.Version -Tenant default | Out-Null
      Write-Host "installed: $($info.Name) $($info.Version)"
      $result.installed += "$($info.Name) $($info.Version)"
    } catch { $next += $f; $lastErr = $_.Exception.Message }
  }
  if ($next.Count -eq $todo.Count) { break }
  $todo = $next
}
foreach ($f in $todo) { $result.failed += $f.Name; Write-Host "FAILED: $($f.Name) $lastErr" }
Write-Output ('##RESULT##' + ($result | ConvertTo-Json -Compress))
`;
  const out = await invokeInContainer(name, script, log);
  const line = out.split(/\r?\n/).find((l) => l.startsWith("##RESULT##"));
  return line ? JSON.parse(line.slice(10)) : { raw: out };
}

export async function listInstalledApps(name: string) {
  const out = await invokeInContainer(
    name,
    "Write-Output ('##RESULT##' + (@(Get-NAVAppInfo -ServerInstance BC -Tenant default -TenantSpecificProperties | Select-Object Name,Publisher,@{n='Version';e={\"$($_.Version)\"}},IsInstalled,@{n='AppId';e={\"$($_.AppId)\"}}) | ConvertTo-Json -Compress))",
  );
  const line = out.split(/\r?\n/).find((l) => l.startsWith("##RESULT##"));
  const parsed = line ? JSON.parse(line.slice(10)) : [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function importLicense(name: string, licenseFile: string, log: Logger = silentLogger) {
  const target = `c:\\run\\${licenseFile.split(/[\\/]/).pop()}`;
  await docker(["cp", licenseFile, `${name}:${target}`]);
  await invokeInContainer(name, `Import-NAVServerLicense -ServerInstance BC -LicenseFile '${target}' -Database NavDatabase; Restart-NAVServerInstance -ServerInstance BC | Out-Null; Write-Host 'License imported'`, log);
  return { name, license: licenseFile, imported: true };
}
