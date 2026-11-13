import { spawn } from "node:child_process";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** False when the executable could not be started (not on PATH). */
  started: boolean;
}

export type Runner = (command: string, args: string[], options?: { timeoutMs?: number }) => Promise<RunResult>;

/** Runs a fixed executable; on Windows through cmd.exe so npx/.cmd/.ps1 shims resolve. Arguments come from the reviewed catalog only. */
export const run: Runner = (command, args, options = {}) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const windows = process.platform === "win32";
    const child = windows
      ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${[command, ...args].join(" ")}"`], { windowsHide: true, windowsVerbatimArguments: true, stdio: ["ignore", "pipe", "pipe"] })
      : spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: null, stdout, stderr: `${stderr}\nTimed out`, started: true });
    }, options.timeoutMs ?? 120_000);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => finish({ code: null, stdout, stderr: error.message, started: false }));
    child.on("close", (code) => {
      // cmd.exe reports a missing command with exit code 9009 instead of a spawn error.
      const missing = process.platform === "win32" && (code === 9009 || /is not recognized as an internal or external command/.test(stderr));
      finish({ code, stdout, stderr, started: !missing });
    });
  });

/** Splits a catalog command into executable and arguments (catalog commands never contain quoted spaces). */
export function splitCommand(command: string): [string, string[]] {
  const [executable, ...args] = command.trim().split(/\s+/);
  return [executable, args];
}
