import { compareVersions } from "./altool.js";

export interface ValidationApp {
  id: string;
  name: string;
  publisher: string;
  version: string;
}

export function assertUpgradeApps(baseline: ValidationApp[], candidate: ValidationApp[]): void {
  const valid = (apps: ValidationApp[]) => apps.length > 0 &&
    new Set(apps.map((a) => a.id.toLowerCase())).size === apps.length &&
    apps.every((a) => /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(a.id) &&
      a.name.trim() && a.publisher.trim() && /^\d+\.\d+\.\d+\.\d+$/.test(a.version));
  if (!valid(baseline) || !valid(candidate) || baseline.length !== candidate.length) {
    throw new Error("Upgrade requires matching nonempty unique app identities and four-part numeric versions.");
  }
  for (const old of baseline) {
    const next = candidate.find((a) => a.id.toLowerCase() === old.id.toLowerCase());
    if (!next || next.name !== old.name || next.publisher !== old.publisher || compareVersions(next.version, old.version) <= 0) {
      throw new Error(`Candidate must retain identity and increase version of ${old.name} (${old.id}).`);
    }
  }
}

export function assertInstalledApps(expected: ValidationApp[], installed: ValidationApp[]): void {
  for (const app of expected) {
    const found = installed.filter((a) => a.id.toLowerCase() === app.id.toLowerCase());
    if (found.length !== 1 || found[0].name !== app.name || found[0].publisher !== app.publisher || found[0].version !== app.version) {
      throw new Error(`Installed app does not match ${app.name} ${app.version} (${app.id}). Inspect target state before retrying.`);
    }
  }
}

export function assertTestSelection(codeunits: unknown, selectors: string[], methods: string[]): void {
  if (!Array.isArray(codeunits)) throw new Error("Test discovery returned no codeunits.");
  const selected = codeunits.filter((c) => selectors.some((s) => s.toLowerCase() === String(c.id).toLowerCase() || s.toLowerCase() === String(c.name).toLowerCase()) &&
    Array.isArray(c.methods) && c.methods.some((t: { name?: unknown }) => typeof t.name === "string" && methods.map((m) => m.toLowerCase()).includes(t.name.toLowerCase())));
  if (selectors.some((s) => !selected.some((c) => s.toLowerCase() === String(c.id).toLowerCase() || s.toLowerCase() === String(c.name).toLowerCase())) ||
      methods.some((m) => !selected.some((c) => Array.isArray(c.methods) && c.methods.some((t: { name?: unknown }) => typeof t.name === "string" && t.name.toLowerCase() === m.toLowerCase())))) {
    throw new Error("Every explicit codeunit/method selector must resolve before deployment.");
  }
}

export type StageStatus = "passed" | "failed" | "blocked" | "not-run" | "running";
export interface StageResult {
  status: "passed" | "failed" | "blocked";
  reason?: string;
  evidence?: unknown;
}
export interface ValidationStage extends Omit<StageResult, "status"> {
  name: string;
  status: StageStatus;
  startedAt?: string;
  finishedAt?: string;
}
export interface ValidationReport {
  succeeded: boolean;
  status: "passed" | "failed" | "blocked" | "running";
  stages: ValidationStage[];
}

export async function runValidationStages(
  stages: { name: string; run: () => Promise<StageResult> }[],
  persist: (report: ValidationReport) => void,
): Promise<ValidationReport> {
  if (!stages.length) throw new Error("At least one validation stage is required.");
  const report: ValidationReport = { succeeded: false, status: "running", stages: stages.map((s) => ({ name: s.name, status: "not-run" })) };
  persist(report);
  for (let i = 0; i < stages.length; i++) {
    const stage = report.stages[i];
    stage.status = "running";
    stage.startedAt = new Date().toISOString();
    persist(report);
    let result: StageResult;
    try {
      result = await stages[i].run();
    } catch (error) {
      result = { status: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
    Object.assign(stage, result, { finishedAt: new Date().toISOString() });
    if (result.status !== "passed") {
      report.status = result.status;
      persist(report);
      return report;
    }
    persist(report);
  }
  report.status = "passed";
  report.succeeded = true;
  persist(report);
  return report;
}
