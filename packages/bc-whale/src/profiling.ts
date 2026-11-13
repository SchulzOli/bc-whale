import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { analyzeProfileFile, analyzeProfileFileAsync, activityOverviewSchema } from "./profile-analysis.js";
import { exec, type Logger } from "./exec.js";

export interface ProfileProxy {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}
export interface ProfileClient {
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  read(uri: string, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}
type Connector = (proxy: ProfileProxy, signal: AbortSignal, log?: Logger) => Promise<ProfileClient>;
interface CommonOptions {
  root: string;
  target: string;
  targetFingerprint: string;
  proxy: ProfileProxy;
  signal?: AbortSignal;
  timeoutMs?: number;
  log?: Logger;
  connect?: Connector;
}
const captureSchema = z.object({
  id: z.string().uuid(), target: z.string().min(1), targetFingerprint: z.string().min(1),
  sessionId: z.number().int().positive(),
  durationSeconds: z.number().int().min(1).max(3600),
  samplingIntervalMs: z.union([z.literal(50), z.literal(100), z.literal(150)]),
  profileCreationThresholdMs: z.number().int().nonnegative(),
  apiPort: z.number().int().positive().max(65535).optional(),
  createdAt: z.string(),
  status: z.enum(["scheduling", "armed", "pending", "collected", "failed", "unknown"]),
  scheduleId: z.string().uuid().optional(),
  windowEndUtc: z.string().optional(), nextStep: z.string().optional(),
});
type Capture = z.infer<typeof captureSchema>;
const scheduleSchema = z.object({
  scheduleId: z.string().uuid(), targetSessionId: z.number().int().positive(),
  windowEndUtc: z.string().datetime({ offset: true }), nextStep: z.string().min(1),
});
const collectionSchema = z.object({
  scheduleId: z.string().uuid(), targetSessionId: z.number().int().positive(),
  capturedActivityCount: z.number().int().nonnegative().max(1000),
  profilesOverview: activityOverviewSchema,
  resourceUri: z.string().optional(),
});
const contentSchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({
    type: z.string(), text: z.string().optional(),
    resource: z.object({ mimeType: z.string().optional(), blob: z.string().optional() }).optional(),
  })),
});

export interface CaptureResult {
  succeeded: boolean;
  id: string;
  captureFile: string;
  scheduleId?: string;
  sessionId: number;
  windowEndUtc?: string;
  nextStep?: string;
  attempts?: number;
  timedOut?: boolean;
  cancelled?: boolean;
  error?: string;
  warning?: string;
  archiveFile?: string;
  analysis?: ReturnType<typeof analyzeProfileFile>;
}

function captureFile(root: string, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw new Error("Invalid capture id; expected a UUID.");
  return join(root, id, "capture.json");
}
export function readCapture(root: string, id: string) {
  const state = captureSchema.parse(JSON.parse(readFileSync(captureFile(root, id), "utf8")));
  if (state.id !== id) throw new Error("Capture identity does not match its directory.");
  return state;
}
function saveCapture(root: string, state: Capture) {
  const file = captureFile(root, state.id);
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${file}.tmp`, file);
}
export function createProfileBudget(timeoutMs: number, signal?: AbortSignal) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw new Error("timeoutMs must be between 1 and 3600000.");
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException("Profiling deadline exceeded", "TimeoutError")), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  return { signal: combined, dispose: () => clearTimeout(timer) };
}
async function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    signal.throwIfAborted();
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
const connectProxy: Connector = async (proxy, signal) => {
  signal.throwIfAborted();
  const transport = new StdioClientTransport({ ...proxy, stderr: "pipe", maxBufferSize: 96 * 1024 * 1024 });
  // Drain diagnostics without echoing authentication messages or sensitive profile data to the MCP host.
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "bc-whale-profiling", version: "0.1.0" });
  let closed: Promise<void> | undefined;
  const close = () => closed ??= (async () => {
    const pid = transport.pid;
    if (signal.aborted && pid && process.platform === "win32") {
      const killed = await exec("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stream: false, timeoutMs: 4000 });
      if (killed.exitCode !== 0 && transport.pid !== null) {
        await client.close();
        throw new Error(`Could not confirm local profiling process-tree termination (PID ${pid}, exit ${killed.exitCode}). Inspect local processes; the BC schedule may remain armed until its window ends.`);
      }
    }
    await client.close();
    if (pid) {
      try { process.kill(pid, 0); }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
        throw error;
      }
      throw new Error(`Profiling proxy PID ${pid} still exists after cleanup; inspect local processes.`);
    }
  })();
  try {
    await bounded(client.connect(transport, { signal, timeout: 3_600_000 }), signal);
    return {
      call: (name, args, requestSignal) => client.callTool({ name, arguments: args }, undefined, { signal: requestSignal, timeout: 3_600_000 }),
      read: (uri, requestSignal) => client.readResource({ uri }, { signal: requestSignal, timeout: 3_600_000 }),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
};

async function withClient<T>(options: CommonOptions, signal: AbortSignal, fn: (client: ProfileClient) => Promise<T>) {
  signal.throwIfAborted();
  const client = await (options.connect
    ? bounded(options.connect(options.proxy, signal, options.log), signal)
    : connectProxy(options.proxy, signal, options.log));
  try { return await fn(client); }
  finally {
    const cleanup = createProfileBudget(6000);
    try { await bounded(client.close(), cleanup.signal); }
    finally { cleanup.dispose(); }
  }
}
function metadata(result: unknown) {
  const response = contentSchema.parse(result);
  if (response.isError) throw new Error(response.content.filter(c => c.type === "text").map(c => c.text).join("\n") || "Profiling MCP returned an error.");
  const json = response.content.find(c => c.type === "text" && c.text?.trim().startsWith("{"))?.text;
  if (!json) throw new Error("Profiling MCP response contains no structured metadata.");
  return { response, data: JSON.parse(json) as unknown };
}
function failure(error: unknown, signal: AbortSignal) {
  const timedOut = signal.aborted && signal.reason instanceof Error && signal.reason.name === "TimeoutError";
  return {
    succeeded: false as const, timedOut, cancelled: signal.aborted && !timedOut,
    error: error instanceof Error ? error.message : String(error),
    warning: "Capture is unverified. Recollect this same schedule; do not rerun the workload automatically. Local cancellation does not terminate BC sessions. A schedule whose stop was not confirmed may remain armed until its window ends.",
  };
}

export async function scheduleProfile(options: CommonOptions & {
  sessionId: number; authorizedSession: boolean; apiPort?: number;
  durationSeconds?: number; samplingIntervalMs?: number; profileCreationThresholdMs?: number; description?: string;
}): Promise<CaptureResult> {
  if (!options.authorizedSession) throw new Error("Profiling requires explicit authorization for the selected session.");
  if (!Number.isInteger(options.sessionId) || options.sessionId <= 0) throw new Error("sessionId must be a positive Business Central NST session id.");
  if ((options.description?.length ?? 0) > 200) throw new Error("description must not exceed 200 characters.");
  const state = captureSchema.parse({
    id: randomUUID(), target: options.target, targetFingerprint: options.targetFingerprint,
    sessionId: options.sessionId, apiPort: options.apiPort,
    durationSeconds: options.durationSeconds ?? 300, samplingIntervalMs: options.samplingIntervalMs ?? 100,
    profileCreationThresholdMs: options.profileCreationThresholdMs ?? 200,
    createdAt: new Date().toISOString(), status: "scheduling",
  });
  const file = captureFile(options.root, state.id);
  mkdirSync(join(options.root, state.id), { recursive: true });
  saveCapture(options.root, state);
  const b = createProfileBudget(options.timeoutMs ?? 60_000, options.signal);
  try {
    await withClient(options, b.signal, async client => {
      options.log?.(`Arming profiling on explicitly authorized session ${state.sessionId}.`);
      const raw = await bounded(client.call("schedule_profiling", {
        targetSessionId: state.sessionId, durationSeconds: state.durationSeconds,
        samplingIntervalMs: state.samplingIntervalMs, profileCreationThresholdMs: state.profileCreationThresholdMs,
        description: options.description ?? "",
      }, b.signal), b.signal);
      writeFileSync(join(options.root, state.id, "schedule.json"), JSON.stringify(raw, null, 2));
      const data = scheduleSchema.parse(metadata(raw).data);
      if (data.targetSessionId !== state.sessionId) throw new Error("Profiling response session identity mismatch.");
      Object.assign(state, { scheduleId: data.scheduleId, windowEndUtc: data.windowEndUtc, nextStep: data.nextStep, status: "armed" });
      saveCapture(options.root, state);
    });
    return { succeeded: true, id: state.id, captureFile: file, sessionId: state.sessionId, scheduleId: state.scheduleId, windowEndUtc: state.windowEndUtc, nextStep: state.nextStep };
  } catch (error) {
    state.status = "unknown";
    saveCapture(options.root, state);
    return { ...failure(error, b.signal), id: state.id, captureFile: file, sessionId: state.sessionId, scheduleId: state.scheduleId };
  } finally { b.dispose(); }
}

async function archiveBlob(client: ProfileClient, response: z.infer<typeof contentSchema>, uri: string | undefined, scheduleId: string, signal: AbortSignal) {
  let blob = response.content.find(c => c.type === "resource" && c.resource?.mimeType === "application/zip")?.resource?.blob;
  if (!blob && uri) {
    if (!uri.startsWith(`alprofile://schedule/${scheduleId}_`)) throw new Error("Unexpected profiling artifact resource identity.");
    const read = z.object({ contents: z.array(z.object({ mimeType: z.string().optional(), blob: z.string().optional() })) }).parse(await bounded(client.read(uri, signal), signal));
    blob = read.contents.find(c => c.mimeType === "application/zip")?.blob;
  }
  if (!blob) throw new Error("Nonempty capture response did not supply a ZIP artifact or readable resource.");
  if (blob.length > 90 * 1024 * 1024 || blob.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(blob)) throw new Error("Invalid or oversized base64 profiling archive.");
  const bytes = Buffer.from(blob, "base64");
  if (bytes.toString("base64") !== blob) throw new Error("Invalid base64 profiling archive.");
  if (bytes.length > 64 * 1024 * 1024) throw new Error("Profiling archive exceeds 64 MiB.");
  return bytes;
}

export async function collectProfile(options: CommonOptions & { id: string; retryIntervalMs?: number }): Promise<CaptureResult> {
  const state = readCapture(options.root, options.id);
  if (state.target !== options.target || state.targetFingerprint !== options.targetFingerprint) throw new Error("Capture target configuration changed. Restore the original target before collecting.");
  if (!state.scheduleId) throw new Error("No confirmed schedule id was recorded. Inspect the selected BC session; do not automatically schedule again.");
  const scheduleId = state.scheduleId;
  const retryMs = options.retryIntervalMs ?? 10_000;
  if (!Number.isInteger(retryMs) || retryMs < 1 || retryMs > 60_000) throw new Error("retryIntervalMs must be between 1 and 60000.");
  const captureDir = join(options.root, state.id), file = captureFile(options.root, state.id);
  const dir = join(captureDir, "collections", randomUUID());
  const lockFile = join(captureDir, "collect.lock");
  const b = createProfileBudget(options.timeoutMs ?? 180_000, options.signal);
  let lock: number;
  try { lock = openSync(lockFile, "wx"); }
  catch (error) {
    b.dispose();
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new Error(`Capture collection is already locked: ${lockFile}. Remove only after confirming no collector is running.`);
    throw error;
  }
  let attempts = 0;
  try {
    mkdirSync(dir, { recursive: true });
    return await withClient(options, b.signal, async client => {
      while (true) {
        b.signal.throwIfAborted();
        attempts++;
        options.log?.(`Collecting profiling schedule ${scheduleId}, attempt ${attempts}.`);
        const raw = await bounded(client.call("stop_schedule_and_get_profiles", { scheduleId, targetSessionId: state.sessionId }, b.signal), b.signal);
        const { response, data: input } = metadata(raw);
        const data = collectionSchema.parse(input);
        if (data.scheduleId !== scheduleId || data.targetSessionId !== state.sessionId) throw new Error("Profiling response schedule/session identity mismatch.");
        writeFileSync(join(dir, `collect-${attempts}.json`), JSON.stringify(data, null, 2));
        if (data.capturedActivityCount > 0) {
          const archiveFile = join(dir, "profiles.zip");
          writeFileSync(archiveFile, await archiveBlob(client, response, data.resourceUri, scheduleId, b.signal));
          const analysis = await analyzeProfileFileAsync(archiveFile, { signal: b.signal });
          if (!analysis.succeeded || analysis.profiles.length !== data.capturedActivityCount) throw new Error("Nonempty capture metadata does not match actual sampled CPU profile evidence.");
          state.status = "collected";
          saveCapture(options.root, state);
          return { succeeded: true, id: state.id, captureFile: file, sessionId: state.sessionId, scheduleId, attempts, archiveFile, analysis };
        }
        state.status = "pending";
        saveCapture(options.root, state);
        await delay(retryMs, undefined, { signal: b.signal });
      }
    });
  } catch (error) {
    const result = failure(error, b.signal);
    state.status = result.cancelled || result.timedOut ? "pending" : "failed";
    saveCapture(options.root, state);
    return { ...result, id: state.id, captureFile: file, sessionId: state.sessionId, scheduleId, attempts };
  } finally {
    b.dispose();
    closeSync(lock);
    unlinkSync(lockFile);
  }
}
