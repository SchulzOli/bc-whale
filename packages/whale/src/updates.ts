import type { Tool } from "./catalog.js";
import { readState, stateFile, writeState } from "./state.js";

export interface UpdateInfo {
  id: string;
  source: "github" | "npm" | "pypi" | "none";
  package?: string;
  latest?: string;
  publishedAt?: string;
  url?: string;
  error?: string;
}

const DAY = 24 * 60 * 60 * 1000;

/** Strips a trailing version: "@scope/pkg@latest" -> "@scope/pkg", "pkg==1.0" / "pkg@1.0" -> "pkg". */
export function stripVersion(spec: string): string {
  const at = spec.lastIndexOf("@");
  const name = at > 0 ? spec.slice(0, at) : spec;
  return name.split("==")[0];
}

export function upstreamOf(tool: Tool): Pick<UpdateInfo, "source" | "package"> {
  const mcp = tool.mcp;
  if (mcp?.type === "stdio" && (mcp.command === "npx" || mcp.command === "uvx")) {
    const args = mcp.args ?? [];
    const flag = args.find((arg) => arg.startsWith("--package="))?.slice("--package=".length)
      ?? args.find((arg) => arg.startsWith("--from="))?.slice("--from=".length);
    const spec = flag ?? args.find((arg) => !arg.startsWith("-"));
    if (spec) return { source: mcp.command === "npx" ? "npm" : "pypi", package: stripVersion(spec) };
  }
  const repository = tool.source && /^https:\/\/github\.com\/([^/]+\/[^/#?]+)/.exec(tool.source);
  if (repository) return { source: "github", package: repository[1].replace(/\.git$/, "") };
  return { source: "none" };
}

async function lookup(id: string, upstream: Pick<UpdateInfo, "source" | "package">, fetcher: typeof fetch): Promise<UpdateInfo> {
  const base: UpdateInfo = { id, ...upstream };
  try {
    if (upstream.source === "npm") {
      const response = await fetcher(`https://registry.npmjs.org/${upstream.package!.replace("/", "%2F")}`, { headers: { accept: "application/vnd.npm.install-v1+json" } });
      if (!response.ok) return { ...base, error: `npm ${response.status}` };
      const data = (await response.json()) as { "dist-tags"?: { latest?: string }; modified?: string };
      return { ...base, latest: data["dist-tags"]?.latest, publishedAt: data.modified, url: `https://www.npmjs.com/package/${upstream.package}` };
    }
    if (upstream.source === "pypi") {
      const response = await fetcher(`https://pypi.org/pypi/${upstream.package}/json`);
      if (!response.ok) return { ...base, error: `pypi ${response.status}` };
      const data = (await response.json()) as { info?: { version?: string }; urls?: { upload_time_iso_8601?: string }[] };
      return { ...base, latest: data.info?.version, publishedAt: data.urls?.[0]?.upload_time_iso_8601, url: `https://pypi.org/project/${upstream.package}/` };
    }
    if (upstream.source === "github") {
      const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "bc-whale" };
      if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      const response = await fetcher(`https://api.github.com/repos/${upstream.package}/releases/latest`, { headers });
      if (response.status === 404) return { ...base, url: `https://github.com/${upstream.package}` };
      if (!response.ok) return { ...base, error: `github ${response.status}` };
      const data = (await response.json()) as { tag_name?: string; published_at?: string; html_url?: string };
      return { ...base, latest: data.tag_name, publishedAt: data.published_at, url: data.html_url };
    }
    return base;
  } catch (error) {
    return { ...base, error: (error as Error).message };
  }
}

/** Latest upstream release per tool; successful results are cached for 24 hours. */
export async function checkUpdates(tools: Tool[], options: { fetch?: typeof fetch; now?: Date; stateFile?: string; refresh?: boolean } = {}): Promise<UpdateInfo[]> {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? new Date();
  const file = options.stateFile ?? stateFile();
  const state = readState(file);
  state.updates ??= {};
  let changed = false;
  const results = await Promise.all(tools.map(async (tool) => {
    const cached = state.updates![tool.id];
    if (!options.refresh && cached && now.getTime() - Date.parse(cached.checkedAt) < DAY) return cached.info as UpdateInfo;
    const info = await lookup(tool.id, upstreamOf(tool), fetcher);
    if (!info.error) {
      state.updates![tool.id] = { checkedAt: now.toISOString(), info };
      changed = true;
    }
    return info;
  }));
  if (changed) writeState(file, state);
  return results;
}
