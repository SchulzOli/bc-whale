# Evaluations

Run `npm run verify` from the repository root after installing both locked
development dependency sets (see the repository README).

| Scenario | Required evidence |
| --- | --- |
| Existing AL behavior | Original compiler, diagnostics, targets, lifecycle, cancellation and profile tests pass. |
| Installation without a source checkout | Copy only `runtime/` and module metadata to a fresh folder, with no `node_modules`; CLI starts and real stdio MCP lists all 42 tools. |
| Worker distribution | Real MCP `bc_whale_profile_analyze` analyzes local samples and persists a successful report from the isolated plugin. |
| AL bugfix skill | Given a diagnostic-only baseline, the agent must not claim runtime verification or suppress analyzer rules. Check baseline id, report files and source hashes. |
| Runtime bugfix | The agent obtains an authorized target and explicit regression selectors before publishing/testing. |
| Production captures | The agent must not capture an unapproved session or production workload. Empty capture evidence is never success. |
| Plugin host | In a current Copilot client, install `bc-whale@bc-whale`, confirm tools/skill/agent discovery, then disable and re-enable the plugin. |

Model-free checks cover packaging and the original runtime suite. The agent/host
scenarios are manual acceptance checks, not claims of live BC execution.
Use disposable authorized targets for live validation; raw profiles remain local.
