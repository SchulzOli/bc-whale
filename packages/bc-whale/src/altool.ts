import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { exec, extractTrailingJson, type ExecResult, type Logger, displayCommand, silentLogger } from "./exec.js";

export interface AltoolInfo {
  path: string;
  version: string;
  source: "env" | "vscode-extension" | "dotnet-tool";
}

/** Compare dotted numeric versions. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function extensionCandidates(): { path: string; version: string }[] {
  const roots = [
    join(homedir(), ".vscode", "extensions"),
    join(homedir(), ".vscode-insiders", "extensions"),
    join(homedir(), ".vscode-server", "extensions"),
  ];
  const found: { path: string; version: string }[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root)) {
      const m = /^ms-dynamics-smb\.al-(\d+\.\d+\.\d+)/i.exec(dir);
      if (!m) continue;
      for (const rel of [["bin", "altool.exe"], ["bin", "win32", "altool.exe"], ["bin", "linux", "altool"], ["bin", "darwin", "altool"]]) {
        const p = join(root, dir, ...rel);
        if (existsSync(p)) {
          found.push({ path: p, version: m[1] });
          break;
        }
      }
    }
  }
  return found.sort((a, b) => compareVersions(b.version, a.version));
}

let cached: AltoolInfo | undefined;

/**
 * Resolution order: BC_WHALE_ALTOOL env var, newest AL VS Code extension, `al` dotnet global tool.
 * The VS Code extension is preferred because the global dotnet tool is usually outdated.
 */
export async function resolveAltool(signal?: AbortSignal): Promise<AltoolInfo> {
  signal?.throwIfAborted();
  if (cached) return cached;
  const fromEnv = process.env.BC_WHALE_ALTOOL;
  if (fromEnv && existsSync(fromEnv)) {
    cached = { path: fromEnv, version: await readVersion(fromEnv, signal), source: "env" };
    return cached;
  }
  const ext = extensionCandidates()[0];
  if (ext) {
    cached = { path: ext.path, version: await readVersion(ext.path, signal), source: "vscode-extension" };
    return cached;
  }
  try {
    const v = await readVersion("al", signal);
    cached = { path: "al", version: v, source: "dotnet-tool" };
    return cached;
  } catch {
    signal?.throwIfAborted();
    throw new Error(
      "altool not found. Install the AL Language VS Code extension or run 'dotnet tool install -g microsoft.dynamics.businesscentral.development.tools --prerelease', or set BC_WHALE_ALTOOL.",
    );
  }
}

async function readVersion(path: string, signal?: AbortSignal): Promise<string> {
  const r = await exec(path, ["--version"], { stream: false, signal });
  if (r.terminationError) throw new Error(r.terminationError);
  signal?.throwIfAborted();
  return r.stdout.trim().split(/\s+/)[0]?.split("+")[0] ?? "unknown";
}

export interface AltoolRun<T = unknown> extends ExecResult {
  command: string;
  json?: T;
}

export async function runAltool<T = unknown>(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; log?: Logger; stream?: boolean; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<AltoolRun<T>> {
  const tool = await resolveAltool();
  const log = opts.log ?? silentLogger;
  const command = displayCommand("altool", args);
  log(`> ${command}`);
  const r = await exec(tool.path, args, { ...opts, log });
  return { ...r, command, json: extractTrailingJson<T>(r.stdout) };
}

/** Major version of altool, used to gate features. */
export async function altoolMajor(): Promise<number> {
  const t = await resolveAltool();
  return parseInt(t.version.split(".")[0], 10) || 0;
}
