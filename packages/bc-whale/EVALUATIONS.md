# Evaluations

Run `npm run verify` from the repository root after installing both locked
development dependency sets (see the repository README).

| Scenario | Required evidence |
| --- | --- |
| Existing AL behavior | Original compiler, diagnostics, targets, lifecycle, cancellation and profile tests pass. |
| Installation without a source checkout | Copy only `runtime/` and module metadata to a fresh folder, with no `node_modules`; CLI starts and real stdio MCP lists all 45 tools. |
| Worker distribution | Real MCP `bc_whale_profile_analyze` analyzes local samples and persists a successful report from the isolated plugin. |
| AL bugfix skill | Given a diagnostic-only baseline, the agent must not claim runtime verification or suppress analyzer rules. Check baseline id, report files and source hashes. |
| Runtime bugfix | The agent obtains an authorized target and explicit regression selectors before publishing/testing. |
| Released-binary upgrade (synthetic) | Lifecycle API, CLI and MCP tests archive exact hash-pinned bytes, compile only baseline tests, reject wrong hashes/identities/versions before publishing and detect archived-package changes before seeding. |
| Company preservation (synthetic) | Explicit companies each execute seed and verification methods with separate evidence; company-set drift blocks candidate publication. Original single-company/source-baseline behavior still passes. |
| Warning policy (synthetic) | Warnings fail by default; explicit `failOn: error` retains diagnostics and is recorded in the report. |
| Production captures | The agent must not capture an unapproved session or production workload. Empty capture evidence is never success. |
| Plugin host | In a current Copilot client, install `bc-whale@bc-whale`, confirm tools/skill/agent discovery, then disable and re-enable the plugin. |

Model-free checks cover packaging and the original runtime suite. The agent/host
scenarios are manual acceptance checks, not claims of live BC execution.
Use disposable authorized targets for live validation; raw profiles remain local.

For live released-binary acceptance, provision a fresh authorized Docker target
and existing dedicated companies, install test prerequisites with `deps`, then run
the README validation scenario using independently inventoried production package
hashes. Confirm installed baseline/candidate versions, one persistent seed and
verification per company, and archived package hashes. Repeat on fresh targets
with a corrupted pin and with company-set drift; neither may upgrade the candidate.
These live scenarios were not executed as part of the synthetic regression tests.
