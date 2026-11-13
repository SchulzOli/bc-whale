# Changelog

## 0.2.0

- Call graph: `graph build|query|export` CLI and MCP tools `bc_whale_graph_build`, `bc_whale_graph_query`
  and `bc_whale_graph_export` on top of `altool graph` (cached per project selection, rebuilt on source change).

## 0.1.0

- Initial open-source release of bc-whale (formerly an internal AL dev-loop tool).
- MCP server id `bc_whale`, tools `bc_whale_*`, CLI `bc-whale`, environment variables `BC_WHALE_*`,
  repository configuration in `.bc-whale/` and `bc-whale.json`.
- Distributed as an Agent Plugins 1.0 plugin with a portable bundled runtime, the `al-developer`
  agent and the `bc-whale-bugfix` skill.
