import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";
import { analyzeProfileFile } from "./profile-analysis.js";

try {
  const input = z.object({ file: z.string(), top: z.number().optional(), reportFile: z.string().optional() }).parse(workerData);
  parentPort!.postMessage({ result: analyzeProfileFile(input.file, input) });
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
