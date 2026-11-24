# Changelog

## 0.3.1

- Find Arthurvdv.alcops-managed analyzers in the selected AL extension's `bin`
  and `bin/Analyzers`, including platform-specific compiler layouts.
- Filter container app inventories by exact app ID, name and installation state
  through CLI and MCP. Missing inventory output is an explicit error.
- Document the scoped initialization/publish workflow for existing containers.
  Configured analyzers remain mandatory; no deployment bypass is added.

## 0.3.0

- Upgrade validation accepts hash-pinned released baseline production packages;
  only baseline test fixtures are rebuilt, preserving authentic release bytes.
- Explicit multi-company seed/verify runs detect company-set drift. An optional
  `failOn: error` retains warnings; the default warning gate remains strict.
- CLI/MCP expose the same inputs and retain package/diagnostic/per-company evidence.
  AL developer guidance favors disposable runtime checks before repeated CI runs.
- Existing source-baseline and single-company calls remain supported. No live BC
  upgrade acceptance is implied by synthetic tests. Roll back by reinstalling
  0.2.1; previously generated validation evidence remains local and unchanged.

## 0.2.1

- `mcp register --host copilot` respects `COPILOT_HOME`.

## 0.2.0

- Call graph: `graph build|query|export` CLI and MCP tools `bc_whale_graph_build`, `bc_whale_graph_query`
  and `bc_whale_graph_export` on top of `altool graph` (cached per project selection, rebuilt on source change).

## 0.1.0

- Initial open-source release of bc-whale (formerly an internal AL dev-loop tool).
- MCP server id `bc_whale`, tools `bc_whale_*`, CLI `bc-whale`, environment variables `BC_WHALE_*`,
  repository configuration in `.bc-whale/` and `bc-whale.json`.
- Distributed as an Agent Plugins 1.0 plugin with a portable bundled runtime, the `al-developer`
  agent and the `bc-whale-bugfix` skill.
