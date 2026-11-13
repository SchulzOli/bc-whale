import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findTool, loadCatalog } from "./catalog.js";
import { checkUpdates, stripVersion, upstreamOf } from "./updates.js";

const catalog = loadCatalog();
const tool = (id: string) => findTool(catalog, id);

test("derives the upstream package from npx/uvx arguments or the GitHub source", () => {
  assert.deepEqual(upstreamOf(tool("playwright")), { source: "npm", package: "@playwright/mcp" });
  assert.deepEqual(upstreamOf(tool("al-design-patterns")), { source: "npm", package: "@oliexe12/al-design-patterns" });
  assert.deepEqual(upstreamOf(tool("bc-atlas")), { source: "npm", package: "bc-atlas" });
  assert.deepEqual(upstreamOf(tool("bc-lantern")), { source: "github", package: "SchulzOli/bc-lantern" });
  assert.deepEqual(upstreamOf(tool("markitdown")), { source: "pypi", package: "markitdown-mcp" });
  assert.deepEqual(upstreamOf(tool("bcquality")), { source: "github", package: "microsoft/BCQuality" });
  assert.deepEqual(upstreamOf(tool("altool")), { source: "nuget", package: "Microsoft.Dynamics.BusinessCentral.Development.Tools" });
  assert.deepEqual(upstreamOf(tool("al-objid")), { source: "vscode", package: "vjeko.vjeko-al-objid" });
  assert.deepEqual(upstreamOf(tool("al-objid-mcp")), { source: "npm", package: "@sshadows/objid-mcp" });
  assert.deepEqual(upstreamOf(tool("microsoft-learn")), { source: "none" });
  assert.equal(stripVersion("pkg==1.2"), "pkg");
});

test("missing releases are not errors, results are cached for 24 hours", async () => {
  const directory = mkdtempSync(join(tmpdir(), "whale-updates-"));
  const requests: string[] = [];
  const fake = (async (url: string) => {
    requests.push(url);
    if (url.includes("api.github.com")) return new Response("", { status: 404 });
    return Response.json({ "dist-tags": { latest: "1.2.3" }, modified: "2026-11-01T00:00:00Z" });
  }) as typeof fetch;
  try {
    const stateFile = join(directory, "state.json");
    const tools = [tool("bcquality"), tool("playwright")];
    const now = new Date("2026-11-13T00:00:00Z");
    const first = await checkUpdates(tools, { fetch: fake, now, stateFile });
    assert.equal(first[0].latest, undefined);
    assert.equal(first[0].error, undefined);
    assert.equal(first[1].latest, "1.2.3");
    await checkUpdates(tools, { fetch: fake, now: new Date("2026-11-13T23:00:00Z"), stateFile });
    assert.equal(requests.length, 2);
    await checkUpdates(tools, { fetch: fake, now: new Date("2026-11-14T01:00:00Z"), stateFile });
    assert.equal(requests.length, 4);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("network errors are reported per tool and not cached", async () => {
  const directory = mkdtempSync(join(tmpdir(), "whale-updates-"));
  try {
    const fake = (async () => { throw new Error("offline"); }) as typeof fetch;
    const [result] = await checkUpdates([tool("playwright")], { fetch: fake, stateFile: join(directory, "s.json") });
    assert.equal(result.error, "offline");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("NuGet packages report the newest listed version", async () => {
  const directory = mkdtempSync(join(tmpdir(), "whale-updates-"));
  const requests: string[] = [];
  const fake = (async (url: string) => {
    requests.push(url);
    return Response.json({ versions: ["17.0.34.45391", "30.0.43.45776-beta"] });
  }) as typeof fetch;
  try {
    const [info] = await checkUpdates([tool("altool")], { fetch: fake, stateFile: join(directory, "s.json") });
    assert.equal(info.latest, "30.0.43.45776-beta");
    assert.equal(requests[0], "https://api.nuget.org/v3-flatcontainer/microsoft.dynamics.businesscentral.development.tools/index.json");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});