import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { unzipSync } from "fflate";
import { z } from "zod";

const MAX_FILE = 64 * 1024 * 1024;
const MAX_EXPANDED = 128 * 1024 * 1024;
const number = z.number().finite().nonnegative();
const frameSchema = z.object({
  functionName: z.string(), scriptId: z.string(), url: z.string(),
  lineNumber: z.number().int(), columnNumber: z.number().int(),
});
const cpuSchema = z.object({
  nodes: z.array(z.object({
    id: z.number().int().positive(), callFrame: frameSchema,
    children: z.array(z.number().int().positive()).optional(),
  })).max(200_000),
  samples: z.array(z.number().int().positive()).max(2_000_000),
  timeDeltas: z.array(number).max(2_000_000),
  startTime: number, endTime: number,
  totalMemoryUsed: number.optional(), totalObjectCount: number.optional(),
});
const activitySchema = z.object({
  activityId: z.string(), activityDescription: z.string().optional(),
  activityDurationMs: number.optional(), sampledAlCallsDurationMs: number.optional(),
  sqlStatementCount: number.optional(), sqlCallDurationMs: number.optional(),
  httpCallCount: number.optional(), httpCallDurationMs: number.optional(),
});
export const activityOverviewSchema = z.array(activitySchema).max(1000);

export interface Hotspot {
  functionName: string;
  object: string;
  url: string;
  lineNumber: number;
  kind: "al" | "sql" | "runtime";
  selfMs: number;
  inclusiveMs: number;
}

export function analyzeCpuProfile(input: unknown, name: string, top = 10) {
  if (!Number.isInteger(top) || top < 1 || top > 50) throw new Error("top must be an integer from 1 to 50.");
  const cpu = cpuSchema.parse(input);
  if (cpu.endTime < cpu.startTime) throw new Error(`${name}: endTime precedes startTime.`);
  if (cpu.samples.length !== cpu.timeDeltas.length) throw new Error(`${name}: samples/timeDeltas length mismatch.`);
  const nodes = new Map<number, (typeof cpu.nodes)[number]>();
  const parent = new Map<number, number>();
  for (const node of cpu.nodes) {
    if (nodes.has(node.id)) throw new Error(`${name}: duplicate node ${node.id}.`);
    nodes.set(node.id, node);
  }
  for (const node of cpu.nodes) {
    for (const child of node.children ?? []) {
      if (!nodes.has(child)) throw new Error(`${name}: unknown child ${child}.`);
      if (parent.has(child)) throw new Error(`${name}: node ${child} has multiple parents.`);
      parent.set(child, node.id);
    }
  }
  const validated = new Set<number>();
  for (const node of cpu.nodes) {
    const path = new Set<number>();
    let id: number | undefined = node.id;
    while (id !== undefined && !validated.has(id)) {
      if (path.has(id)) throw new Error(`${name}: cycle in CPU call tree.`);
      path.add(id);
      if (path.size > 512) throw new Error(`${name}: CPU call tree exceeds 512 levels.`);
      id = parent.get(id);
    }
    for (const value of path) validated.add(value);
  }
  const idle = (id: number) => /^(?:IdleTime|\(idle\))$/i.test(nodes.get(id)!.callFrame.functionName);
  const keyFor = (id: number) => {
    const f = nodes.get(id)!.callFrame;
    return JSON.stringify([f.functionName, f.scriptId, f.url, f.lineNumber, f.columnNumber]);
  };
  const totals = new Map<string, Hotspot>();
  const entry = (id: number) => {
    const key = keyFor(id);
    let value = totals.get(key);
    if (!value) {
      const f = nodes.get(id)!.callFrame;
      value = {
        functionName: f.functionName, object: f.scriptId, url: f.url, lineNumber: f.lineNumber,
        kind: /^(?:SELECT|INSERT|UPDATE|DELETE|EXEC|WITH)\b/i.test(f.functionName) ? "sql"
          : f.functionName.startsWith("(") ? "runtime" : "al",
        selfMs: 0, inclusiveMs: 0,
      };
      totals.set(key, value);
    }
    return value;
  };
  let idleMs = 0;
  let sampledDurationMs = 0;
  for (let i = 0; i < cpu.samples.length; i++) {
    const id = cpu.samples[i], ms = cpu.timeDeltas[i] / 1000;
    if (!nodes.has(id)) throw new Error(`${name}: unknown sampled node ${id}.`);
    sampledDurationMs += ms;
    if (idle(id)) { idleMs += ms; continue; }
    entry(id).selfMs += ms;
    const counted = new Set<string>();
    let ancestor: number | undefined = id;
    let depth = 0;
    while (ancestor !== undefined) {
      if (++depth > 512) throw new Error(`${name}: CPU call tree exceeds 512 levels.`);
      const key = keyFor(ancestor);
      if (!idle(ancestor) && !counted.has(key)) {
        entry(ancestor).inclusiveMs += ms;
        counted.add(key);
      }
      ancestor = parent.get(ancestor);
    }
  }
  const warnings: string[] = [];
  if (cpu.samples.length < 100) warnings.push("Sparse samples (<100): capture evidence, not a reliable benchmark.");
  if (!cpu.samples.length) warnings.push("No CPU samples captured; runtime profiling is unverified.");
  const bytes = cpu.totalMemoryUsed;
  const sessionMemory = bytes === undefined ? undefined : {
    bytes, objects: cpu.totalObjectCount,
    display: bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB`
      : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(2)} MiB`
      : bytes >= 1024 ? `${(bytes / 1024).toFixed(2)} KiB` : `${bytes} bytes`,
  };
  return {
    name, nodeCount: cpu.nodes.length, sampleCount: cpu.samples.length,
    sampledDurationMs, idleMs, sessionMemory,
    hotspots: [...totals.values()].sort((a, b) => b.selfMs - a.selfMs || b.inclusiveMs - a.inclusiveMs).slice(0, top),
    warnings,
  };
}

export function analyzeProfileFile(file: string, options: { top?: number; reportFile?: string } = {}) {
  const source = resolve(file);
  if (statSync(source).size > MAX_FILE) throw new Error("Profile input exceeds the 64 MiB limit.");
  const data = readFileSync(source);
  const profiles: ReturnType<typeof analyzeCpuProfile>[] = [];
  let activities: z.infer<typeof activityOverviewSchema> = [];
  const parse = (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString("utf8").replace(/^\uFEFF/, "")) as unknown;
  if (extname(source).toLowerCase() === ".zip") {
    let size = 0, count = 0;
    const files = unzipSync(data, {
      filter: entry => {
        if (!/\.alcpuprofile$/i.test(entry.name) && !entry.name.endsWith("performance-profiles-overview.json")) return false;
        size += entry.originalSize;
        if (++count > 1001 || entry.originalSize > MAX_FILE || size > MAX_EXPANDED) throw new Error("Profile archive exceeds entry/expanded-size limits.");
        return true;
      },
    });
    for (const [name, bytes] of Object.entries(files)) {
      if (/\.alcpuprofile$/i.test(name)) profiles.push(analyzeCpuProfile(parse(bytes), name, options.top));
      else activities = activityOverviewSchema.parse(parse(bytes));
    }
    if (!profiles.length) throw new Error("Archive contains no CPU profiles.");
  } else if (extname(source).toLowerCase() === ".alcpuprofile") {
    profiles.push(analyzeCpuProfile(parse(data), basename(source), options.top));
  } else throw new Error("Expected a .zip or .alcpuprofile input.");
  const warnings = [
    "Profiles may contain sensitive SQL, object names and business data. Keep evidence local.",
    "Sampled self/inclusive durations are not activity wall-clock durations; inclusive frames overlap.",
    "Memory estimates, when present, are session totals; never sum them across activities or treat them as server memory.",
    ...new Set(profiles.flatMap(p => p.warnings)),
  ];
  const memory = profiles.find(p => p.sessionMemory)?.sessionMemory;
  const summary = [
    `${profiles.length} CPU profile(s), ${profiles.reduce((sum, p) => sum + p.sampleCount, 0)} samples.`,
    ...(memory ? [`Session memory: ${memory.display}${memory.objects === undefined ? "" : ` / ${memory.objects} objects`}.`] : ["Session memory: not captured."]),
    ...profiles.map(p => `${p.name}: ${p.sampleCount} samples; ${p.hotspots.slice(0, 3).map(h => `${h.functionName.slice(0, 120)} [${h.kind}] self ${h.selfMs.toFixed(3)} ms / inclusive ${h.inclusiveMs.toFixed(3)} ms`).join("; ")}`),
  ].join("\n");
  const reportFile = resolve(options.reportFile ?? `${source}.analysis.json`);
  const sourceStat = statSync(source);
  const reportStat = existsSync(reportFile) ? statSync(reportFile) : undefined;
  if (reportFile === source || (reportStat && reportStat.dev === sourceStat.dev && reportStat.ino === sourceStat.ino)) throw new Error("Analysis report must not overwrite the source profile.");
  const report = {
    succeeded: profiles.some(p => p.sampleCount > 0),
    source, sourceSha256: createHash("sha256").update(data).digest("hex"),
    profiles, activities, warnings, summary, reportFile,
  };
  writeFileSync(reportFile, JSON.stringify(report, null, 2));
  return report;
}

export async function analyzeProfileFileAsync(file: string, options: { top?: number; reportFile?: string; signal?: AbortSignal } = {}) {
  options.signal?.throwIfAborted();
  const worker = new Worker(new URL("./profile-analysis-worker.js", import.meta.url), {
    workerData: { file, top: options.top, reportFile: options.reportFile }, execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 512 },
  });
  let abort: (() => void) | undefined;
  try {
    return await new Promise<ReturnType<typeof analyzeProfileFile>>((resolve, reject) => {
      abort = () => reject(options.signal?.reason ?? new Error("Profile analysis cancelled."));
      options.signal?.addEventListener("abort", abort, { once: true });
      worker.once("message", (message: { result?: ReturnType<typeof analyzeProfileFile>; error?: string }) => {
        if (message.result) resolve(message.result);
        else reject(new Error(message.error ?? "Profile analysis worker returned no result."));
      });
      worker.once("error", reject);
      worker.once("exit", code => reject(new Error(`Profile analysis worker exited without a result (exit ${code}).`)));
      if (options.signal?.aborted) abort();
    });
  } finally {
    if (abort) options.signal?.removeEventListener("abort", abort);
    await worker.terminate();
  }
}
