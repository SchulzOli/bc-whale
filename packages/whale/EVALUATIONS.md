# Evaluations

Automated: `npm run verify` at the repository root runs the unit tests, the CLI and
MCP tests against isolated home folders, and the packaged-runtime test.

| Scenario | Required evidence |
| --- | --- |
| Fresh machine profile | With a temporary `HOME`/`USERPROFILE`/`APPDATA`, `whale setup --profile recommended --host copilot vscode --yes` creates both host files; a second run reports only `unchanged`. |
| Existing configuration | On a copy of a real `mcp-config.json`, `whale setup --dry-run` reports tools configured under other names as `unchanged` and adds no duplicates. |
| Agent flow | In a Copilot session with the plugin, the agent calls `whale_plan`, shows the steps, and calls `whale_apply` only after approval. |
| Verify | After restarting the session, every selected tool's `verify` step (`whale explain <id>`) succeeds. |
| Update | `whale update --check` lists latest releases; offline, it reports per-tool errors without failing. |
