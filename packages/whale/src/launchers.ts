import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Tool } from "./catalog.js";
import type { Runner } from "./exec.js";

/** Marker that identifies files whale may overwrite; anything else in the folder is left alone. */
const MARKER = "managed by whale";
const MARKETPLACE = "bc-whale";

export interface LauncherFile {
  tool: string;
  file: string;
  content: string;
  mode?: number;
}

/** Folder of the installed Copilot plugin; the CLI lives in runtime/cli.js and moves with plugin updates. */
export function pluginRoot(id: string, home = homedir()): string {
  return join(home, ".copilot", "installed-plugins", MARKETPLACE, id);
}

/** Own plugins with a CLI get launchers; third-party tools ship their own installers. */
export function launcherTools(tools: Tool[]): Tool[] {
  return tools.filter((tool) => tool.kind === "internal-plugin" && tool.path && tool.status !== "planned");
}

/** npm's global prefix is on PATH wherever Node.js was installed normally (Windows: the folder itself; else bin/). */
export async function launcherFolder(runner: Runner, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  const result = await runner("npm", ["prefix", "-g"], { timeoutMs: 30_000 });
  const prefix = result.started && result.code === 0 ? result.stdout.trim().split(/\r?\n/).pop() : undefined;
  if (!prefix) return undefined;
  return platform === "win32" ? prefix : join(prefix, "bin");
}

export function launcherFiles(tool: Tool, folder: string, options: { home?: string; platform?: NodeJS.Platform } = {}): LauncherFile[] {
  const platform = options.platform ?? process.platform;
  const cli = join(pluginRoot(tool.id, options.home), "runtime", "cli.js");
  if (platform === "win32") {
    return [
      { tool: tool.id, file: join(folder, `${tool.id}.cmd`), content: `@echo off\r\nrem ${MARKER}\r\nnode "${cli}" %*\r\n` },
      { tool: tool.id, file: join(folder, `${tool.id}.ps1`), content: `# ${MARKER}\r\n& node "${cli}" @args\r\nexit $LASTEXITCODE\r\n` },
    ];
  }
  return [{ tool: tool.id, file: join(folder, tool.id), content: `#!/bin/sh\n# ${MARKER}\nexec node "${cli}" "$@"\n`, mode: 0o755 }];
}

export type LauncherState = "create" | "update" | "unchanged" | "foreign";

export function launcherState(launcher: LauncherFile): LauncherState {
  if (!existsSync(launcher.file)) return "create";
  const current = readFileSync(launcher.file, "utf8");
  if (current === launcher.content) return "unchanged";
  return current.includes(MARKER) ? "update" : "foreign";
}

export function writeLauncher(launcher: LauncherFile): void {
  if (launcherState(launcher) === "foreign") throw new Error(`${launcher.file} exists and is not managed by whale`);
  mkdirSync(dirname(launcher.file), { recursive: true });
  writeFileSync(launcher.file, launcher.content, "utf8");
  if (launcher.mode) chmodSync(launcher.file, launcher.mode);
}
