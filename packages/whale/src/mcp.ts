#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PROFILES, explain, findTool, loadCatalog, selectTools } from "./catalog.js";
import { HOSTS } from "./hosts.js";
import { type PlanOptions, apply, plan } from "./plan.js";
import { doctor, status } from "./status.js";
import { checkUpdates } from "./updates.js";

const server = new McpServer(
  { name: "whale", version: "0.2.0" },
  {
    instructions: [
      "whale manages the Business Central agent toolset described by the bc-whale catalog.",
      "Use whale_list / whale_explain to understand tools, whale_status and whale_doctor to inspect the machine.",
      "To set up tools: call whale_plan, show every step to the user, and only after the user approves call whale_apply with the returned planHash.",
      "whale_apply only merges MCP entries (with backups) and runs reviewed 'copilot plugin' commands; set confirmCommands only when the user approved those commands.",
      "After applying, tell the user to restart the agent session, then run each tool's verify step.",
    ].join("\n"),
  },
);

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: unknown) => ({ isError: true, content: [{ type: "text" as const, text: (error as Error).message }] });
const catalog = () => loadCatalog();
const repo = z.string().optional().describe("Absolute AL repository path; enables the 'repo' host (.vscode/mcp.json)");
const reviewed = new Map<string, PlanOptions>();

server.registerTool("whale_list", {
  description: "List every catalog tool with kind, category, status and description.",
  annotations: { readOnlyHint: true },
}, async () => json(catalog().tools.map(({ id, kind, section, category, status, description }) => ({ id, kind, section, category, status, description }))));

server.registerTool("whale_explain", {
  description: "Explain one tool: purpose, access, auth, setup, update, verify, gaps and docs.",
  inputSchema: { id: z.string() },
  annotations: { readOnlyHint: true },
}, async ({ id }) => {
  try {
    const tool = findTool(catalog(), id);
    return { content: [{ type: "text" as const, text: explain(tool) }] };
  } catch (error) {
    return fail(error);
  }
});

server.registerTool("whale_doctor", {
  description: "Check local prerequisites (node, npx, uvx, copilot, git, docker, az).",
  annotations: { readOnlyHint: true },
}, async () => json(await doctor()));

server.registerTool("whale_status", {
  description: "Which catalog tools are configured as MCP servers or installed as Copilot plugins, and on which hosts.",
  inputSchema: { repo },
  annotations: { readOnlyHint: true },
}, async ({ repo: path }) => {
  try {
    return json(await status(catalog().tools.filter((tool) => tool.status !== "planned"), { repo: path }));
  } catch (error) {
    return fail(error);
  }
});

server.registerTool("whale_plan", {
  description: "Plan a setup without changing anything. Returns steps and a planHash required by whale_apply.",
  inputSchema: {
    profile: z.enum(PROFILES as [string, ...string[]]).optional().describe("core | recommended | full"),
    tools: z.array(z.string()).optional().describe("Explicit tool ids (added to the profile)"),
    hosts: z.array(z.enum(HOSTS as [string, ...string[]])).min(1).describe("copilot | vscode | repo"),
    inputs: z.record(z.string(), z.string()).optional().describe("Tool inputs such as ORGANIZATION"),
    repo,
  },
  annotations: { readOnlyHint: true },
}, async (args) => {
  try {
    if (!args.profile && !args.tools?.length) throw new Error("Choose a profile or tools");
    const options: PlanOptions = {
      tools: selectTools(catalog(), { profile: args.profile as never, ids: args.tools }),
      hosts: args.hosts as never,
      inputs: args.inputs ?? {},
      repo: args.repo,
    };
    const result = await plan(options);
    reviewed.set(result.planHash, options);
    return json(result);
  } catch (error) {
    return fail(error);
  }
});

server.registerTool("whale_apply", {
  description: "Apply a plan previously returned by whale_plan and approved by the user. Fails if the plan changed since.",
  inputSchema: {
    planHash: z.string().describe("planHash returned by whale_plan"),
    confirmCommands: z.boolean().describe("true only if the user approved the listed copilot plugin commands"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
}, async ({ planHash, confirmCommands }) => {
  const options = reviewed.get(planHash);
  if (!options) return fail(new Error("Unknown planHash; call whale_plan first"));
  try {
    const results = await apply(options, planHash, { confirmCommands });
    reviewed.delete(planHash);
    return json({ results, next: "Restart the agent session, then run each tool's verify step (whale_explain)." });
  } catch (error) {
    return fail(error);
  }
});

server.registerTool("whale_updates", {
  description: "Latest upstream releases (GitHub, npm, PyPI) for catalog tools; cached for 24 hours.",
  inputSchema: { ids: z.array(z.string()).optional(), refresh: z.boolean().optional() },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ ids, refresh }) => {
  try {
    const data = catalog();
    const tools = ids?.length ? selectTools(data, { ids }) : data.tools.filter((tool) => tool.status !== "planned");
    return json(await checkUpdates(tools, { refresh }));
  } catch (error) {
    return fail(error);
  }
});

await server.connect(new StdioServerTransport());
