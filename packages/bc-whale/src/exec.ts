import { spawn, type ChildProcess } from "node:child_process";

export type Logger = (line: string) => void;

/** Default logger writes to stderr so stdout stays clean for JSON / MCP protocol. */
export const stderrLogger: Logger = (line) => process.stderr.write(line.endsWith("\n") ? line : line + "\n");
export const silentLogger: Logger = () => {};

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  log?: Logger;
  /** Stream each output line to the logger (default true). */
  stream?: boolean;
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** stdout + stderr interleaved in arrival order. */
  output: string;
  durationMs: number;
  timedOut: boolean;
  cancelled?: boolean;
  terminationError?: string;
  signal?: string;
}

/** Overrides replace existing variables case-insensitively (Windows env names are case-insensitive). */
export function mergeEnv(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!overrides) return env;
  for (const k of Object.keys(overrides)) {
    for (const existing of Object.keys(env)) if (existing.toLowerCase() === k.toLowerCase()) delete env[existing];
    env[k] = overrides[k];
  }
  return env;
}

export function exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  if (options.signal?.aborted) return Promise.reject(new Error("Operation cancelled before process start."));
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
    return Promise.reject(new Error("timeoutMs must be a positive integer."));
  }
  const log = options.log ?? silentLogger;
  const stream = options.stream ?? true;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: mergeEnv(options.env),
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let output = "";
    let pending = "";
    const onData = (chunk: Buffer, isErr: boolean) => {
      const text = chunk.toString("utf8");
      if (isErr) stderr += text;
      else stdout += text;
      output += text;
      if (stream) {
        pending += text;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const l of lines) if (l.trim().length) log(l);
      }
    };
    child.stdout.on("data", (c: Buffer) => onData(c, false));
    child.stderr.on("data", (c: Buffer) => onData(c, true));
    let timer: NodeJS.Timeout | undefined;
    let stopTimer: NodeJS.Timeout | undefined;
    let timedOut = false;
    let cancelled = false;
    let stopping = false;
    let terminationError: string | undefined;
    let termination: Promise<void> | undefined;
    let killer: ChildProcess | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (stopTimer) clearTimeout(stopTimer);
      options.signal?.removeEventListener("abort", abort);
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      stopTimer = setTimeout(() => {
        killer?.kill();
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
        cleanup();
        reject(new Error("Process tree termination could not be confirmed within 5 seconds; inspect target/server state."));
      }, 5000);
      if (!child.pid) return;
      if (process.platform === "win32") {
        const terminator = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer = terminator;
        termination = new Promise<void>((done) => {
          const failed = (message: string) => {
            terminationError = message;
            onData(Buffer.from(`${message}\n`), true);
            done();
          };
          terminator.on("error", (error) => failed(`Process tree termination failed: ${error.message}; inspect server state before retrying.`));
          terminator.on("close", (code) => {
            if (code === 0) done();
            else if (!terminationError) failed(`Process tree termination failed (exit ${code}); inspect server state before retrying.`);
          });
        });
      } else {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
            cleanup();
            reject(error);
          }
        }
      }
    };
    const abort = () => {
      if (options.signal?.reason instanceof Error && options.signal.reason.name === "TimeoutError") timedOut = true;
      else cancelled = true;
      stop();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    if (options.timeoutMs) {
      timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    }
    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("close", async (code, signal) => {
      try { await termination; }
      catch (error) { cleanup(); reject(error); return; }
      cleanup();
      if (stream && pending.trim().length) log(pending);
      resolve({ exitCode: timedOut || cancelled ? -1 : code ?? -1, stdout, stderr, output, durationMs: Date.now() - started, timedOut, cancelled, terminationError, signal: signal ?? undefined });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

/**
 * altool commands print progress text followed by one structured JSON document.
 * Returns the last parseable top-level JSON object/array in the text.
 */
export function extractTrailingJson<T = unknown>(text: string): T | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // fall through
  }
  const candidates: number[] = [];
  const re = /(^|\n)[{[]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) candidates.push(m.index + m[1].length);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const slice = text.slice(candidates[i]).trim();
    try {
      return JSON.parse(slice) as T;
    } catch {
      // try an earlier start
    }
  }
  return undefined;
}

/** Quote a single argument for display only (not for shell execution). */
export function displayCommand(command: string, args: string[]): string {
  const q = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  return [command, ...args].map(q).join(" ");
}
