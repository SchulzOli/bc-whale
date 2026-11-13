import type { Tool } from "./catalog.js";
import { pluginName } from "./catalog.js";
import { type Runner, splitCommand } from "./exec.js";

/**
 * Commands whale may execute from the catalog. Package-manager installs only, one package, no shell syntax.
 * Keep in sync with scripts/validate.mjs.
 */
const PACKAGE = "[@a-z0-9][\\w@./-]*";
export const ALLOWED_COMMANDS = [
  /^copilot plugin [a-z][\w@./ -]*$/i,
  new RegExp(`^pipx (install|upgrade) ${PACKAGE}$`, "i"),
  new RegExp(`^dotnet tool (install|update) --global ${PACKAGE}( --prerelease)?$`, "i"),
  new RegExp(`^npm install --global ${PACKAGE}$`, "i"),
  /^code --install-extension [a-z0-9][\w-]*\.[a-z0-9][\w-]*( --force)?$/i,
];

export const isAllowedCommand = (command: string) => ALLOWED_COMMANDS.some((pattern) => pattern.test(command));

/** Where to get a missing package manager; shown when a step is blocked. */
const INSTALL_HINTS: Record<string, string> = {
  pipx: "python -m pip install --user pipx && python -m pipx ensurepath",
  dotnet: "install the .NET SDK from https://dot.net",
  npm: "install Node.js from https://nodejs.org",
  npx: "install Node.js from https://nodejs.org",
  uvx: "install uv from https://docs.astral.sh/uv/",
  copilot: "install GitHub Copilot CLI",
  code: "install VS Code and enable the `code` command (Command Palette: Shell Command: Install 'code' command in PATH)",
};

export const installHint = (executable: string) => INSTALL_HINTS[executable];

/** Executables a tool needs to be set up, run or detected. */
export function requiredExecutables(tool: Tool): string[] {
  const names = new Set<string>();
  if (pluginName(tool) || tool.kind === "external-marketplace") names.add("copilot");
  if (tool.mcp?.type === "stdio" && tool.mcp.command) names.add(tool.mcp.command);
  for (const command of [...(tool.setup?.commands ?? []), ...(tool.update?.commands ?? [])]) names.add(splitCommand(command)[0]);
  if (tool.detect?.command) names.add(splitCommand(tool.detect.command)[0]);
  if (tool.detect?.vscodeExtension) names.add("code");
  return [...names];
}

export async function isAvailable(executable: string, runner: Runner): Promise<boolean> {
  const result = await runner(executable, ["--version"], { timeoutMs: 30_000 });
  return result.started && result.code === 0;
}

/** Whether a tool with a `detect.command` is installed; undefined when the catalog gives no way to tell. */
export async function detectInstalled(tool: Tool, runner: Runner): Promise<{ installed: boolean; version?: string } | undefined> {
  if (tool.detect?.vscodeExtension) {
    const id = tool.detect.vscodeExtension.toLowerCase();
    const result = await runner("code", ["--list-extensions", "--show-versions"], { timeoutMs: 60_000 });
    if (!result.started || result.code !== 0) return { installed: false };
    const line = result.stdout.split(/\r?\n/).find((entry) => entry.toLowerCase().startsWith(`${id}@`));
    return line ? { installed: true, version: line.split("@")[1].trim() } : { installed: false };
  }
  if (!tool.detect?.command) return undefined;
  const [executable, args] = splitCommand(tool.detect.command);
  const result = await runner(executable, args, { timeoutMs: 30_000 });
  const installed = result.started && result.code === 0;
  const version = installed ? /\d+\.\d+[\w.-]*/.exec(result.stdout)?.[0] : undefined;
  return { installed, ...(version ? { version } : {}) };
}
