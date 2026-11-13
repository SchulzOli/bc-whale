import { createHash } from "node:crypto";
import type { Tool } from "./catalog.js";
import { pluginName } from "./catalog.js";
import { detectInstalled, installHint, isAllowedCommand, isAvailable } from "./commands.js";
import { type Runner, run, splitCommand } from "./exec.js";
import { type HostId, type HostOptions, findEquivalent, hostFile, mergeEntry, readEntries, renderEntry, substitute } from "./hosts.js";
import { launcherFiles, launcherFolder, launcherState, launcherTools, writeLauncher } from "./launchers.js";
import { type InstalledPlugins, installedPlugins } from "./status.js";

export interface PlanStep {
  tool: string;
  kind: "mcp" | "command" | "manual" | "launcher";
  action: "create" | "update" | "unchanged" | "run" | "blocked" | "manual";
  host?: HostId;
  file?: string;
  name?: string;
  entry?: Record<string, unknown>;
  content?: string;
  mode?: number;
  command?: string;
  detail: string;
}

export interface PlanOptions extends HostOptions {
  tools: Tool[];
  hosts: HostId[];
  inputs?: Record<string, string>;
  /** Also put the CLIs of own plugins on PATH (launchers in npm's global folder). */
  launchers?: boolean;
  runner?: Runner;
  plugins?: InstalledPlugins;
}

export interface Plan {
  steps: PlanStep[];
  planHash: string;
}

export interface StepResult extends PlanStep {
  result: "applied" | "unchanged" | "skipped" | "failed" | "manual" | "blocked";
  output?: string;
}

const canonical = (value: unknown): string => JSON.stringify(value, (_, item) =>
  item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

export function hashSteps(steps: PlanStep[]): string {
  return createHash("sha256").update(canonical(steps)).digest("hex");
}

function marketplaceRegistered(marketplaces: string, slug: string) {
  return marketplaces.toLowerCase().includes(`github: ${slug.toLowerCase()})`);
}

function pluginSteps(tool: Tool, plugins: InstalledPlugins): PlanStep[] {
  const name = pluginName(tool)!;
  if (plugins.available && plugins.plugins.has(name)) {
    return [{ tool: tool.id, kind: "command", action: "unchanged", detail: `Plugin ${name} ${plugins.plugins.get(name)} is installed` }];
  }
  return (tool.setup?.commands ?? []).map((command): PlanStep => {
    if (!plugins.available) return { tool: tool.id, kind: "command", action: "blocked", command, detail: "copilot CLI not found on PATH" };
    const added = /^copilot plugin marketplace add (\S+)$/.exec(command);
    if (added && marketplaceRegistered(plugins.marketplaces, added[1])) {
      return { tool: tool.id, kind: "command", action: "unchanged", command, detail: `Marketplace ${added[1]} is registered` };
    }
    return { tool: tool.id, kind: "command", action: "run", command, detail: command };
  });
}

export async function plan(options: PlanOptions): Promise<Plan> {
  const inputs = options.inputs ?? {};
  const steps: PlanStep[] = [];
  const entries = new Map(options.hosts.map((host) => [host, readEntries(hostFile(host, options), host)]));
  const needsPlugins = options.tools.some((tool) => !tool.mcp && pluginName(tool));
  const plugins = options.plugins ?? (needsPlugins ? await installedPlugins(options.runner ?? run) : { available: false, plugins: new Map(), marketplaces: "" });
  for (const tool of options.tools) {
    if (tool.mcp) {
      const definition = substitute(tool, inputs);
      for (const host of options.hosts) {
        const file = hostFile(host, options);
        const existing = entries.get(host)!;
        const entry = renderEntry(host, tool, inputs);
        const equivalent = findEquivalent(existing, definition);
        if (equivalent) {
          const detail = equivalent === tool.id ? "Already configured" : `Already configured as '${equivalent}'`;
          steps.push({ tool: tool.id, kind: "mcp", action: "unchanged", host, file, name: equivalent, detail });
        } else {
          const action = existing[tool.id] ? "update" : "create";
          const detail = action === "create" ? `Add '${tool.id}' to ${file}` : `Point '${tool.id}' in ${file} to the catalog server (other fields kept)`;
          steps.push({ tool: tool.id, kind: "mcp", action, host, file, name: tool.id, entry, detail });
        }
      }
    } else if (pluginName(tool)) {
      for (const step of pluginSteps(tool, plugins)) {
        const earlier = step.action === "run" && steps.find((other) => other.action === "run" && other.command === step.command);
        steps.push(earlier ? { ...step, action: "unchanged", detail: `Same command already planned for ${earlier.tool}` } : step);
      }
    } else if (tool.setup?.method === "command" && tool.setup.commands?.length) {
      steps.push(...(await commandSteps(tool, options.runner ?? run)));
    } else {
      const note = tool.setup?.note ?? tool.setup?.commands?.join(" ; ") ?? `See ${tool.documentation}`;
      steps.push({ tool: tool.id, kind: "manual", action: "manual", detail: note });
    }
  }
  if (options.launchers) steps.push(...(await launcherSteps(options)));
  return { steps, planHash: hashSteps(steps) };
}

/** Package-manager installs: skipped when detect finds the tool, blocked when the package manager is missing. */
async function commandSteps(tool: Tool, runner: Runner): Promise<PlanStep[]> {
  const detected = await detectInstalled(tool, runner);
  if (detected?.installed) {
    return [{ tool: tool.id, kind: "command", action: "unchanged", detail: `Installed${detected.version ? ` (${detected.version})` : ""}` }];
  }
  const steps: PlanStep[] = [];
  for (const command of tool.setup!.commands!) {
    const executable = splitCommand(command)[0];
    if (!(await isAvailable(executable, runner))) {
      const hint = installHint(executable);
      steps.push({ tool: tool.id, kind: "command", action: "blocked", command, detail: `${executable} not found on PATH${hint ? `; first: ${hint}` : ""}` });
    } else {
      steps.push({ tool: tool.id, kind: "command", action: "run", command, detail: command });
    }
  }
  return steps;
}

async function launcherSteps(options: PlanOptions): Promise<PlanStep[]> {
  const tools = launcherTools(options.tools);
  if (!tools.length) return [];
  const folder = await launcherFolder(options.runner ?? run, options.platform);
  if (!folder) return tools.map((tool) => ({ tool: tool.id, kind: "launcher", action: "blocked", detail: "npm not found; cannot locate a folder on PATH" }));
  return tools.flatMap((tool) => launcherFiles(tool, folder, options).map((launcher): PlanStep => {
    const state = launcherState(launcher);
    const base = { tool: tool.id, kind: "launcher" as const, file: launcher.file };
    if (state === "unchanged") return { ...base, action: "unchanged", detail: `Launcher ${launcher.file} is up to date` };
    if (state === "foreign") return { ...base, action: "blocked", detail: `${launcher.file} exists and is not managed by whale; remove it to let whale manage it` };
    return { ...base, action: state, content: launcher.content, ...(launcher.mode ? { mode: launcher.mode } : {}), detail: `${state === "create" ? "Add" : "Refresh"} launcher ${launcher.file} (puts '${tool.id}' on PATH)` };
  }));
}

/** Re-plans with the same options and applies only when the result still hashes to the reviewed plan. */
export async function apply(options: PlanOptions, planHash: string, settings: { confirmCommands: boolean; now?: Date }): Promise<StepResult[]> {
  const current = await plan(options);
  if (current.planHash !== planHash) throw new Error("Plan changed; re-run plan and review it again");
  const runner = options.runner ?? run;
  const results: StepResult[] = [];
  const failedTools = new Set<string>();
  const backedUp = new Set<string>();
  for (const step of current.steps) {
    if (step.kind === "launcher" && (step.action === "create" || step.action === "update")) {
      if (failedTools.has(step.tool)) {
        results.push({ ...step, result: "skipped", output: "Plugin installation failed" });
        continue;
      }
      try {
        writeLauncher({ tool: step.tool, file: step.file!, content: step.content!, mode: step.mode });
        results.push({ ...step, result: "applied" });
      } catch (error) {
        results.push({ ...step, result: "failed", output: (error as Error).message });
      }
    } else if (step.action === "create" || step.action === "update") {
      try {
        const outcome = mergeEntry(step.file!, step.host!, step.name!, step.entry!, { now: settings.now, backedUp });
        results.push({ ...step, result: outcome === "unchanged" ? "unchanged" : "applied" });
      } catch (error) {
        results.push({ ...step, result: "failed", output: (error as Error).message });
      }
    } else if (step.action === "run") {
      if (!settings.confirmCommands) {
        results.push({ ...step, result: "skipped", output: "Commands not confirmed" });
      } else if (failedTools.has(step.tool)) {
        results.push({ ...step, result: "skipped", output: "Earlier command for this tool failed" });
      } else if (!isAllowedCommand(step.command!)) {
        failedTools.add(step.tool);
        results.push({ ...step, result: "failed", output: "Command is not an allowed package-manager install" });
      } else {
        const [executable, args] = splitCommand(step.command!);
        const outcome = await runner(executable, args, { timeoutMs: 300_000 });
        const ok = outcome.started && outcome.code === 0;
        if (!ok) failedTools.add(step.tool);
        results.push({ ...step, result: ok ? "applied" : "failed", output: (outcome.stdout + outcome.stderr).trim().slice(-2000) });
      }
    } else {
      results.push({ ...step, result: step.action === "unchanged" ? "unchanged" : step.action === "blocked" ? "blocked" : "manual" });
    }
  }
  return results;
}
