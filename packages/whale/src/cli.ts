#!/usr/bin/env node
import { Command, Option } from "commander";
import { type Catalog, type Profile, PROFILES, type Tool, explain, findTool, loadCatalog, pluginName, selectTools } from "./catalog.js";
import { run, splitCommand } from "./exec.js";
import { HOSTS, type HostId, type HostOptions } from "./hosts.js";
import { launcherTools } from "./launchers.js";
import { type PlanOptions, type PlanStep, type StepResult, apply, plan } from "./plan.js";
import { createPrompt } from "./prompt.js";
import { doctor, status, toolDoctor } from "./status.js";
import { isAllowedCommand } from "./commands.js";
import { checkUpdates } from "./updates.js";

const program = new Command()
  .name("whale")
  .description("Set up, update, check and explain the Business Central agent toolset (bc-whale catalog).")
  .version("0.2.7")
  .option("--json", "machine-readable JSON on stdout")
  .option("--catalog <file>", "catalog.json to use (default: bundled)")
  .option("-r, --repo <path>", "AL repository for the 'repo' host (.vscode/mcp.json)");

type Globals = { json?: boolean; catalog?: string; repo?: string };
const globals = () => program.opts<Globals>();
const catalog = (): Catalog => loadCatalog(globals().catalog);
const hostOptions = (): HostOptions => ({ repo: globals().repo });
const available = (tools: Tool[]) => tools.filter((tool) => tool.status !== "planned");

function print(value: unknown, text: () => string) {
  process.stdout.write(globals().json ? JSON.stringify(value, null, 2) + "\n" : text() + "\n");
}

const table = (rows: string[][]) => {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length)));
  return rows.map((row) => row.map((cell, column) => (cell ?? "").padEnd(widths[column])).join("  ").trimEnd()).join("\n");
};

const describeStep = (step: PlanStep | StepResult) => {
  const label = "result" in step ? step.result : step.action;
  return `[${label}] ${step.tool}${step.host ? ` -> ${step.host}` : ""}: ${step.detail}${"output" in step && step.output && step.result === "failed" ? `\n    ${step.output.replace(/\n/g, "\n    ")}` : ""}`;
};

function parseInputs(values: string[] = []): Record<string, string> {
  return Object.fromEntries(values.map((value) => {
    const index = value.indexOf("=");
    if (index <= 0) throw new Error(`Invalid --input ${value}; expected NAME=value`);
    return [value.slice(0, index), value.slice(index + 1)];
  }));
}

program.command("list").description("All catalog tools").action(() => {
  const { tools } = catalog();
  print(tools, () => table([["ID", "KIND", "SECTION", "CATEGORY", "STATUS", "DESCRIPTION"], ...tools.map((t) => [t.id, t.kind, t.section ?? "", t.category, t.status, t.description])]));
});

program.command("explain <id>").description("How a tool is set up, updated, verified and what it covers").action((id: string) => {
  const tool = findTool(catalog(), id);
  print(tool, () => explain(tool));
});

program.command("doctor [ids...]").description("Check local prerequisites; with tool ids, what those tools need").action(async (ids: string[] = []) => {
  if (ids.length) {
    const result = await toolDoctor(selectTools(catalog(), { ids }));
    print(result, () => table([["TOOL", "NEEDS", "FOUND", "HOW TO GET IT"], ...result.map((p) => [p.tool, p.executable, p.found ? "yes" : "no", p.hint ?? ""])]));
    if (result.some((p) => !p.found)) process.exitCode = 1;
    return;
  }
  const result = await doctor();
  print(result, () => table([["TOOL", "FOUND", "VERSION", "NEEDED FOR"], ...result.map((p) => [p.name, p.found ? "yes" : "no", p.version ?? "", p.purpose])]));
});

program.command("status [ids...]").description("Which catalog tools are configured, where").action(async (ids: string[] = []) => {
  const data = catalog();
  const result = await status(ids.length ? selectTools(data, { ids }) : available(data.tools), hostOptions());
  print(result, () => table([["ID", "VIA", "INSTALLED", "HOSTS", "VERSION"], ...result.map((s) => [s.id, s.via, s.via === "unknown" ? "?" : s.installed ? "yes" : "no",
    s.hosts.map((host) => (s.names?.[host] ? `${host} (${s.names[host]})` : host)).join(", "), s.version ?? ""])]));
});

program.command("setup [ids...]")
  .description("Guided setup: choose tools and hosts, review the plan, then apply. With tool ids, set up only those.")
  .addOption(new Option("--profile <profile>", "tool selection by status").choices(PROFILES))
  .option("--tool <id...>", "explicit tools (added to the profile)")
  .addOption(new Option("--host <host...>", "hosts to configure").choices(HOSTS))
  .option("--input <NAME=value...>", "values for tool inputs such as ORGANIZATION")
  .option("-y, --yes", "non-interactive: apply the plan, including copilot plugin commands")
  .option("--launchers", "also put the whale and bc-whale CLIs on PATH (launchers in npm's global folder)")
  .option("--dry-run", "show the plan only")
  .action(async (ids: string[] = [], options: { profile?: Profile; tool?: string[]; host?: HostId[]; input?: string[]; launchers?: boolean; yes?: boolean; dryRun?: boolean }) => {
    const data = catalog();
    const explicit = [...ids, ...(options.tool ?? [])];
    const inputs = parseInputs(options.input);
    let tools: Tool[];
    let hosts: HostId[];
    let launchers = options.launchers ?? false;
    const prompt = options.yes ? undefined : createPrompt();
    try {
      const onlyNamed = explicit.length > 0 && !options.profile;
      if (!prompt) {
        tools = selectTools(data, { profile: options.profile ?? (explicit.length ? undefined : "core"), ids: explicit });
        hosts = options.host ?? ["copilot"];
      } else {
        if (onlyNamed) {
          tools = selectTools(data, { ids: explicit });
        } else {
          const profile = (options.profile ?? (await prompt.select("Profile", PROFILES, "recommended"))) as Profile;
          const defaults = selectTools(data, { profile, ids: explicit }).map((tool) => tool.id);
          tools = selectTools(data, { ids: await prompt.choose("Tools", available(data.tools).map((tool) => tool.id), defaults) });
        }
        const hostChoices = globals().repo ? HOSTS : HOSTS.filter((host) => host !== "repo");
        const needsHosts = tools.some((tool) => tool.mcp);
        hosts = options.host ?? (needsHosts ? ((await prompt.choose("Hosts", hostChoices, ["copilot"])) as HostId[]) : ["copilot"]);
        for (const name of new Set(tools.flatMap((tool) => tool.inputs ?? []))) {
          if (!inputs[name]) inputs[name] = await prompt.ask(`${name} (needed by ${tools.filter((t) => t.inputs?.includes(name)).map((t) => t.id).join(", ")}): `);
        }
        const commands = launcherTools(tools).map((tool) => tool.id);
        if (options.launchers === undefined && commands.length) launchers = await prompt.confirm(`Also put ${commands.join(" and ")} on PATH for your terminal?`);
      }
      const planOptions: PlanOptions = { ...hostOptions(), tools, hosts, inputs, launchers };
      const result = await plan(planOptions);
      if (options.dryRun) return print(result, () => result.steps.map(describeStep).join("\n") + `\nplanHash ${result.planHash}`);
      process.stderr.write(result.steps.map(describeStep).join("\n") + "\n");
      const writes = result.steps.some((step) => step.action === "create" || step.action === "update");
      const commands = result.steps.some((step) => step.action === "run");
      if (!writes && !commands) return print({ steps: result.steps, results: [] }, () => "Nothing to change.");
      if (prompt && writes && !(await prompt.confirm("Write these MCP entries and launchers (existing host files are backed up)?"))) return print({ aborted: true }, () => "Aborted; nothing written.");
      const confirmCommands = !commands || !prompt ? true : await prompt.confirm("Run the install commands listed above?");
      const results = await apply(planOptions, result.planHash, { confirmCommands });
      print(results, () => results.map(describeStep).join("\n") + "\nRestart the agent session, then run each tool's verify step (whale explain <id>).");
      if (results.some((step) => step.result === "failed")) process.exitCode = 1;
    } finally {
      prompt?.close();
    }
  });

program.command("update [ids...]")
  .description("Show upstream releases; with confirmation, run the update commands of installed tools")
  .option("--tool <id...>", "limit to these tools (same as ids)")
  .option("--check", "only report, never run commands")
  .option("--refresh", "ignore the 24 h cache")
  .option("-y, --yes", "run update commands without asking")
  .action(async (ids: string[] = [], options: { tool?: string[]; check?: boolean; refresh?: boolean; yes?: boolean }) => {
    const data = catalog();
    const explicit = [...ids, ...(options.tool ?? [])];
    const tools = explicit.length ? selectTools(data, { ids: explicit }) : available(data.tools);
    const [updates, states] = await Promise.all([checkUpdates(tools, { refresh: options.refresh }), status(tools, hostOptions())]);
    const rows = updates.map((info) => ({ ...info, installed: states.find((s) => s.id === info.id) }));
    if (options.check || globals().json) {
      return print(rows, () => table([["ID", "INSTALLED", "LATEST", "PUBLISHED", "SOURCE"], ...rows.map((r) => [r.id, r.installed?.version ?? (r.installed?.installed ? "yes" : r.installed?.via === "unknown" ? "?" : "no"), r.latest ?? (r.error ? `error: ${r.error}` : ""), r.publishedAt?.slice(0, 10) ?? "", r.package ?? r.source])]));
    }
    process.stderr.write(table([["ID", "INSTALLED", "LATEST", "PUBLISHED"], ...rows.map((r) => [r.id, r.installed?.version ?? (r.installed?.installed ? "yes" : "no"), r.latest ?? "", r.publishedAt?.slice(0, 10) ?? ""])]) + "\n");
    const commands = [...new Set(tools.filter((tool) => states.find((s) => s.id === tool.id)?.installed).flatMap((tool) => tool.update?.commands ?? []))].filter(isAllowedCommand);
    if (!commands.length) return print([], () => "No update commands to run. npx/uvx servers with @latest update on their next start; see `whale explain <id>` for the rest.");
    process.stdout.write(commands.map((command) => `  ${command}`).join("\n") + "\n");
    const prompt = options.yes ? undefined : createPrompt();
    try {
      if (prompt && !(await prompt.confirm("Run these update commands?"))) return;
    } finally {
      prompt?.close();
    }
    for (const command of commands) {
      const [executable, args] = splitCommand(command);
      const outcome = await run(executable, args, { timeoutMs: 300_000 });
      process.stdout.write(`[${outcome.code === 0 ? "applied" : "failed"}] ${command}\n`);
      if (outcome.code !== 0) process.exitCode = 1;
    }
  });

program.parseAsync().catch((error: Error) => {
  process.stderr.write(`whale: ${error.message}\n`);
  process.exitCode = 1;
});
