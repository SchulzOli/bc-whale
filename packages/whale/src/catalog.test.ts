import assert from "node:assert/strict";
import { test } from "node:test";
import { loadCatalog, pluginName, selectTools } from "./catalog.js";

const catalog = loadCatalog();
const ids = (tools: { id: string }[]) => tools.map((tool) => tool.id);

test("profiles select by status and include lower tiers", () => {
  assert.deepEqual(ids(selectTools(catalog, { profile: "core" })), ["whale", "bc-whale", "al-mcp", "microsoft-learn"]);
  const recommended = ids(selectTools(catalog, { profile: "recommended" }));
  for (const id of ["whale", "bc-whale", "bcquality", "al-design-patterns", "github"]) assert.ok(recommended.includes(id), id);
  assert.ok(!recommended.includes("markitdown"));
  const full = ids(selectTools(catalog, { profile: "full" }));
  assert.ok(full.includes("markitdown") && !full.includes("microsoft-graph-enterprise"));
});

test("explicit ids add experimental tools, reject unknown and planned ones", () => {
  assert.deepEqual(ids(selectTools(catalog, { ids: ["microsoft-graph-enterprise"] })), ["microsoft-graph-enterprise"]);
  assert.throws(() => selectTools(catalog, { ids: ["graph"] }), /Unknown tool: graph/);
  const planned = { ...catalog, tools: [{ ...catalog.tools[0], status: "planned" as const }] };
  assert.throws(() => selectTools(planned, { ids: [catalog.tools[0].id] }), /planned/);
});

test("plugin names come from the install command", () => {
  const byId = (id: string) => catalog.tools.find((tool) => tool.id === id)!;
  assert.equal(pluginName(byId("bcquality")), "bcquality");
  assert.equal(pluginName(byId("superpowers")), "superpowers");
  assert.equal(pluginName(byId("whale")), "whale");
  assert.equal(pluginName(byId("microsoft-learn")), undefined);
});
