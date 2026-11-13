# bc-whale - AL dev life cycle without BcContainerHelper

`bc-whale` is the own Business Central MCP server and CLI of the
[bc-whale toolkit](../../README.md). It fills the gaps the official tools leave open:
multi-app build orchestration, containers and cloud sandboxes without BcContainerHelper,
test execution, diagnostics evidence, bugfix verification and profiling.

Install with Copilot's native plugin manager:

```powershell
copilot plugin marketplace add SchulzOli/bc-whale
copilot plugin install bc-whale@bc-whale
```

In VS Code, add the same repository as a plugin marketplace in Agent Customizations,
then install `bc-whale`. A current client supporting Agent Plugins 1.0 and Node.js 22+
on PATH is required. The checked-in `runtime/` includes the CLI, MCP server, CPU-analysis
worker and runtime dependencies; end users do not need npm or a build.
`src/`, `fixtures/` and the lockfile are maintained here for development.
The plugin contributes the `bc_whale` MCP server, the `al-developer` agent, and the
`bc-whale-bugfix` skill. Restart the session after installation/update. Pass `repo`
explicitly to MCP calls when the host's working directory is not the AL repository.

AL, Docker and cloud prerequisites still apply to the particular operations being
used. The official AL MCP server is separate; use `runtime/cli.js almcp` or
`mcp register --almcp` for symbol navigation. Do not register a second `bc_whale`
instance with `mcp register` when using the plugin.

To regenerate the portable runtime, run `npm run build` at the repository root,
not the TypeScript-only package build. See [evaluations](EVALUATIONS.md) and
[changes](CHANGELOG.md). Third-party integrations are linked in the
[catalog](../../catalog.json), not bundled into this plugin.

`bc-whale` covers the Business Central AL development life cycle for single- and multi-app repositories using only
**altool** (from the AL Language extension, v30+) and the **docker CLI**. It never loads BcContainerHelper.

It ships two entry points that share one core:

| Entry point | Purpose |
| --- | --- |
| `bc-whale` (CLI, `dist/cli.js`) | Terminal / CI usage. Prints JSON to stdout, progress to stderr, exit code 1 on failure. |
| `bc-whale-mcp` (MCP server, `dist/mcp.js`) | Tools for agents (GitHub Copilot in VS Code / Copilot CLI): `bc_whale_build`, `bc_whale_test`, ... |
| `bc-whale almcp` | Starts Microsoft's AL MCP server (`altool launchmcpserver`) for **all** projects of a repo with the newest altool and the shared package cache. |

## Setup

```powershell
cd packages\bc-whale
npm install
npm run build
node dist\cli.js doctor           # checks altool, docker, az, git
npm link                          # optional: puts 'bc-whale' on PATH
```

Register the MCP servers for the agent (Copilot CLI / VS Code agent window):

```powershell
# bc-whale MCP + AL MCP for one repo into ~/.copilot/mcp-config.json
node dist\cli.js mcp register --host copilot --almcp --repo C:\Repos\MyApp
# VS Code user mcp.json, or the repo's .vscode/mcp.json
node dist\cli.js mcp register --host vscode,repo --almcp --repo C:\Repos\MyApp
```

Restart the agent session afterwards. Existing entries with other names are not touched.

The same command can also register Microsoft's hosted data and DevOps servers:

```powershell
node dist\cli.js mcp register --host vscode --repo C:\Repos\MyApp `
  --business-central --bc-tenant <tenant-id> --bc-environment Sandbox --bc-company CRONUS `
  --azure-devops contoso --graph-enterprise
```

Each external server is opt-in. Business Central uses the hosted online MCP endpoint; tenant,
environment, company, and MCP configuration headers are optional. Without them, the signed-in
identity can select available environments/configurations. The built-in BC configuration is
read-only; write and action access depends on the BC administrator's MCP configuration and the
signed-in user's permissions. Azure DevOps uses the remote endpoint for the specified organization
and requires Microsoft Entra authentication plus Azure DevOps permissions. Microsoft Graph
Enterprise is a preview remote server. Authentication is handled by the MCP host; bc-whale does not
store credentials. The command supports `--host copilot,vscode,repo` for these servers as well.

## Concepts

- **Repository model.** Projects are found via AL-Go settings (`.github/AL-Go-Settings.json` + `.AL-Go/settings.json`
  `appFolders`/`testFolders`), then a `*.code-workspace`, then a folder scan. Dependencies between in-repo apps define
  the build order (topological levels). Projects can be selected by app name, folder, app id or wildcard (`-p "My App*"`).
- **Work folder `<repo>/.bc-whale/`** (git-ignored automatically):
  `packages/` shared symbol cache, `out/` built apps, `logs/<run>/` compiler logs, `testresults/`, `deps/` extra runtime apps to publish.
- **Symbols** come from the global Microsoft/AppSource NuGet feeds (`altool downloadsymbols --globalsourcesonly`), so no
  server is needed. In-repo dependencies are removed from the cache, so sibling apps are always compiled from source.
  `--from-target` downloads from a server instead (for PTE dependencies that only exist there).
- **Build** uses `altool workspace compile` over the selected projects with `out;packages` as package cache. It returns
  structured diagnostics (file, line, column, rule, message, help link) and applies `failOn`.
- **Targets** are deployment destinations: `docker` (local container), `cloud` (BC online environment) or `onprem`.
  User targets live in `~/.bc-whale/config.json`, repo targets in `<repo>/bc-whale.json`.
- **Secrets** (container passwords) are stored with Windows DPAPI under `~/.bc-whale/containers/<name>/`. Passwords for
  on-prem targets come from an env variable (`passwordEnv`). Cloud uses altool's token cache (`bc-whale auth login`).

## Configuration

Effective configuration = AL-Go settings < project `.vscode/settings.json` (`al.codeAnalyzers`, `al.ruleSetPath`)
< `~/.bc-whale/config.json` < `<repo>/bc-whale.json`.

```jsonc
// <repo>/bc-whale.json (all keys optional)
{
  "analyzers": ["CodeCop", "UICop", "AppSourceCop"],
  "ruleset": ".codeAnalysis/app.ruleset.json",
  "customAnalyzers": [".alcops/ALCops.LinterCop.dll"],
  "failOn": "warning",            // none | error | warning
  "country": "w1",                // symbol country
  "nugetFeeds": [],               // extra NuGet feeds for symbols
  "defaultTarget": "dev",
  "targets": {
    "dev":    { "type": "docker", "container": "bc-whaletest" },
    "sbx":    { "type": "cloud", "environmentName": "Sandbox01", "tenant": "contoso.onmicrosoft.com" },
    "server": { "type": "onprem", "server": "http://bcserver", "serverInstance": "BC", "authentication": "UserPassword", "username": "dev", "passwordEnv": "BC_DEV_PW" }
  }
}
```

AL-Go defaults are respected: `enableCodeCop`, `enableUICop`, `enableAppSourceCop` (on by default for `AppSource App`),
`enablePerTenantExtensionCop` (on by default for `PTE`), `rulesetFile`, `customCodeCops`, `failOn`, `country`.
Every configured custom analyzer must resolve: missing analyzers now fail build/check instead of being skipped.
Use `bc-whale analyzers status` / `bc_whale_analyzers` to see exact paths and hashes.
`${analyzerFolder}` (case-insensitive) resolves against the selected altool folder; repo-provisioned analyzers
in `.bc-whale/analyzers` and same-name assemblies in that compiler folder are fallback locations.
Provision the installed/trusted local ALCops suite with `bc-whale analyzers prepare --source <folder>`.
All ALCops companion DLLs are copied together and a SHA256 manifest records their source. No automatic download
or installation into the VS Code extension takes place. DLL availability is not proof of compatibility:
the compiler must run successfully. Analyzer hashes invalidate successful incremental checks.

## Commands

```text
bc-whale doctor | info | map
bc-whale symbols  [-p ...] [--from-target] [--force] [--copy-to-projects]
bc-whale build    [-p ...] [--no-deps] [--analyzers CodeCop,UICop] [--fail-on warning] [--info]
bc-whale check    [-p ...] [--force] [--fail-on warning]
bc-whale watch    [-p ...] [--debounce-ms 300]
bc-whale diagnostics [--run-id ...] [--severity Error|Warning|Info|Hidden] [--offset 0] [--limit 100]
bc-whale publish  [-p ...] [-t target] [--no-tests] [--with-deps] [--schema-update-mode ForceSync]
bc-whale test     [-p ...] [-t target] [-c 50100,"My Test*"] [-m "Test*"] [--coverage line]
bc-whale cycle    [-p ...] [-t target] [--steps build,publish,test]
bc-whale validate --baseline-repo <path> -p <app,test> -t <target> --company <name> --seed-codeunits <ids> --seed-methods <names> --verify-codeunits <ids> --verify-methods <names> --authorized-disposable-target
bc-whale deps     [-t target] [--toolkit] [--apps "Name",...]
bc-whale version  [-p ...] --bump minor | --set 29.1.0.0 | --application 30.0.0.0 [--dry-run]
bc-whale launch   [-t target]                          # writes 'bc-whale: <target>' into .vscode/launch.json
bc-whale target   add|list|remove|check
bc-whale container create|list|start|stop|restart|remove|wait|logs|apps|install-apps|license|credential|artifact
bc-whale cloud    list|create|copy|delete|operations|apps|install
bc-whale auth     login|logout [--tenant] [--device-code]
bc-whale mcp      register|serve
bc-whale almcp                                         # AL MCP server (stdio) for the repo
bc-whale analyzers status | prepare --source <folder>
bc-whale fix start --issue <symptom> -p <apps> [-t target] [--codeunits ...] [--methods ...]
bc-whale fix verify <baseline-id>
bc-whale debug register --target <name> [--host copilot,repo] [--api-port 7047]
bc-whale debug proxy --kind profile|snapshot --target <name> [--api-port 7047]
bc-whale profile schedule --target <name> --session-id <NST-id> --authorized-session [--api-port 7048]
bc-whale profile collect <capture-id> [--timeout-ms 180000]
bc-whale profile analyze <local.zip|local.alcpuprofile> [--top 10] [--report-file <path>]
bc-whale altool -- <raw altool args>                   # escape hatch
```

`bc-whale mcp register` registers only `bc-whale` by default. Optional switches are `--almcp`,
`--business-central` (with optional `--bc-tenant`, `--bc-environment`, `--bc-company`,
`--bc-configuration`), `--azure-devops <organization>`, and `--graph-enterprise`.
The AL MCP is local/stdio; the other three are official remote HTTP servers.
See Microsoft's docs for [Business Central MCP](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/ai/mcp-overview),
[Azure DevOps MCP](https://learn.microsoft.com/en-us/azure/devops/mcp-server/mcp-server-overview?view=azure-devops),
and [Microsoft Graph MCP for Enterprise](https://learn.microsoft.com/en-us/graph/mcp-server/overview).

Global options: `-r, --repo <path>` (default: current directory), `-q, --quiet`.

### Source-backed bugfix loop

1. Use `bc-whale check` / `bc_whale_check` after each edit. Content hashes identify changed apps and their
   transitive dependents; their dependencies are compiled fresh by altool's parallel workspace compiler.
   An unchanged **successful** check is reused only while sources, configuration, analyzers, altool identity,
   symbol packages, shared repository resources and output packages still match. `--force` bypasses reuse. This is project-level selection,
   not compiler-level incremental compilation. Hashing intentionally costs a little time to avoid stale builds.
2. Errors, warnings, infos and hidden diagnostics are archived in `.bc-whale/logs/<runId>/diagnostics.json`,
   alongside raw diagnostic logs and `process.log`. Info is included by default (`build --no-info` hides it only
   from the response). Source-suppressed diagnostics stay in the raw compiler logs but are excluded from the
   actionable list. Responses expose `totalDiagnostics`, `omittedDiagnostics`, `complete`, `exitCode`,
   `timedOut`, `command` and `reportFile`; missing/malformed diagnostic logs fail the build.
3. Read `bc-whale diagnostics` / `bc_whale_diagnostics` with `runId` and follow `nextOffset` to fetch **all** entries
   without recompilation. `severity` and `project` narrow the list. The MCP preview contains at most 50 diagnostics;
   oversized responses return an explicit error with the archive location rather than broken, truncated JSON.
4. Every diagnostic has a stable ID, exact file/line/column, compiler-provided `helpLink` when available,
   and a five-line source excerpt with its file URI and SHA256 when the source is inside the repo.
   This excerpt is a working-tree snapshot; `commit` identifies HEAD, not necessarily those uncommitted bytes.
   Verify the current source before editing. Use AL MCP symbol search/relations to substantiate cross-app fixes
   and Microsoft Learn for the rule semantics; do not invent documentation links or symbol relationships.
5. Compare `diagnosticChanges` (added/resolved IDs, unchanged count) only for consecutive **complete builds of
   the same project selection**. A moved diagnostic gets a new ID. "Resolved" means no longer reported, not
   proof that behavior is correct. Fix errors first, rerun analyzers, then address warnings and infos deliberately
   rather than suppressing rules to turn the build green.
6. Run `bc-whale cycle --incremental -t <target>` for build/check -> publish -> tests. **Publish and tests still run**
   even when compilation is reused. Empty test selection, failed discovery, unknown outcomes, missing output,
   all-skipped tests and incomplete outcome counts fail instead of looking successful.

`build`, `check`, `publish`, `test` and `cycle` accept `--timeout-ms` (default 600000 per process).
Nonzero compiler exits always fail, including with `failOn: none`. Warning failures obey `failOn`.
Concurrent builds are rejected by `.bc-whale/build.lock` to prevent deleting another build's outputs. After a crash,
remove this exact lock only after verifying its recorded PID is no longer running.

`bc-whale watch` performs one initial check, then debounces source edits and queues at most one check while a
previous check is running. Generated output/cache folders do not trigger loops. It emits one JSON line per
check (including explicit errors) and stops with Ctrl+C. It never publishes, executes tests or changes code
automatically. Prefer bounded `bc_whale_check` calls in MCP; keep watch in a dedicated terminal.
Symbolic-link input trees require a full `build` instead of incremental checks.
Untracked external resources outside the repository/configured analyzer/ruleset paths require `check --force`.

Sources: [Microsoft: code analysis](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-using-code-analysis-tool)
and [rulesets](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-rule-set-syntax-for-code-analysis-tools).
Exact installed compiler arguments can be inspected with `bc-whale altool -- workspace compile --help`.

### Automated, evidence-backed bugfix sessions

Run the [bc-whale-bugfix skill](skills/bc-whale-bugfix/SKILL.md) with the repo, symptom and affected apps.
The agent reproduces a failure with `bc_whale_fix_start`, corrects the code using AL MCP definitions/callers,
and closes with `bc_whale_fix_verify`. This is an agent workflow, not deterministic automatic code rewriting.
Baseline and verification reports are stored in `.bc-whale/fixes`; source/configuration fingerprints prevent
unchanged code or shared ruleset changes from being reported as a fix. Verification always compiles fresh.
Compiler/resolved analyzer bytes and provisioned companion assemblies are fingerprinted too; changing them
requires a new baseline. Analyzer execution exceptions (`AD0001`) fail the build even with `failOn: none`.
The workflow uses `failOn: warning`: existing warnings must be understood before recording the intended baseline.
If a target is provided, baseline/verification publish and run the selected test scenario. Prepare the
authorized target/dependencies first. Failed/empty discovery is not a runtime reproduction.
Runtime sessions require a test app in the selected scope; they never fall back to unrelated repository tests.
Without a target, verification is **diagnostics-only** and cannot prove runtime behavior.
Retain the original regression test and report the exact sources, test names/counts and report paths.

### Bounded test execution and cancellation

`bc-whale test` / `bc_whale_test` now require a **fresh successful compile** of the
selected test apps and their in-repo dependencies before resolving the target
or starting discovery. Compiler errors return `phase: build`, structured
diagnostics and the build report; no tests are started. This preflight uses
`failOn: error` so warnings remain visible but do not prevent runtime tests.
It does not download symbols implicitly: run `symbols` separately when needed.

Compilation **does not publish**. Tests still execute the version installed on
the server. For source corrections use `cycle --steps build,publish,test`.
The explicit test preflight also runs when tests are reached through cycle or
bugfix verification; the strict upgrade validator separately prepares both
versions and tests its archived package set.

For `test`, `timeoutMs` / `--timeout-ms` is **one total deadline** (default
600000 ms) covering preflight compilation, discovery and all selected test apps,
not ten minutes renewed per subprocess. A timeout or first discovery/execution
failure stops later apps. Results identify the last phase, completed project
results, `notRunProjects`, and `timedOut` / `cancelled` when applicable.
For other commands, existing per-process timeout semantics remain unchanged.

MCP cancellation is forwarded to the running test/build altool process.
CLI `test` handles Ctrl+C/SIGTERM through the same cancellation path.
On Windows, termination targets the specific owned process tree; on Unix,
it targets the subprocess group. Cleanup may take up to five additional
seconds; a termination failure is an explicit error, not success.
The MCP server can remain running; restart it once after updating this code.

**Local termination does not guarantee cancellation of the BC server session.**
Interrupted execution returns a server-state warning. Inspect that session
before retrying; the tool never kills unrelated sessions, restarts BC or
automatically retries a potentially still-running test.

Regression checks use isolated synthetic altool processes, including compile
errors, successful execution, hanging discovery, a shared multi-app deadline,
inherited child pipes, and a real MCP cancellation notification. They do not
claim that an arbitrary hung BC server session can be cancelled remotely.

### Unified upgrade and data validation

`bc-whale validate` / `bc_whale_validate` exercise **baseline -> persistent seed ->
candidate upgrade -> data assertions**, using the same lifecycle core. This is
an explicitly authorized disposable-target scenario, not production deployment.
It requires separate baseline/candidate repository roots, explicit production
and test apps, a dedicated existing company, exact seed/verification codeunit
and method selectors, and `authorizedDisposableTarget: true`.

The workflow freshly downloads symbols and compiles both versions with
`failOn: warning`, verifies that **every selected app** retains its identity and
increases its version, resolves every test selector before publishing, and
checks source/configuration/compiler/analyzer/package hashes before execution.
Selected in-repo dependencies are included and must increase versions too.
Packages are copied into the run archive and used for publish and test discovery,
not silently replaced by subsequent normal builds.

Baseline and candidate targets are never merged: only the candidate's explicitly
named target is used throughout. A target-wide cross-repository lock prevents
overlapping validation runs; inspect an interrupted run before removing a stale
lock. Existing installed fixture app IDs block a run rather than causing a
downgrade. The workflow never uninstalls, cleans up data, installs dependencies,
creates environments, or uses ForceSync/Recreate/automatic rollback.

Reports, archived packages, hashes and raw test results are kept in
`.bc-whale/validation/<id>/`. Stages are `running`, `passed`, `failed`, `blocked`,
or `not-run`; all seed/verification methods must pass without skipped tests.
Completed evidence survives later failures. After a timeout, inspect the target
before retrying: a local failure does not prove that the server reverted changes.

**Current target support:** read-only installed-version confirmation is
implemented for Docker's default tenant using Microsoft's server management
cmdlets inside the container. Generic on-prem and SaaS targets return **blocked
before building or publishing**, because the corresponding installed-state
adapter is not implemented. No SaaS Admin API is called. This limitation belongs
to the new strict upgrade validation, not ordinary `publish` / `test`.

Snapshot and profiling remain separate, explicitly authorized official proxy
operations. Their status in an upgrade report is `not-run`; a passing upgrade
report is **not** a full lifecycle/capture or performance certification.

#### Reusable synthetic scenario

The [upgrade fixture](fixtures/upgrade/) contains baseline `1.0.0.0` and candidate
`1.1.0.0`, each with one production app and one test app. Copy both folders
**outside a shared Git repository** into separate roots, for example
`C:\BcWhaleValidation\baseline` and `C:\BcWhaleValidation\candidate`. AL-Go settings
select the App/Test folders. Do not run these nested templates in this tool's
Git root: repository discovery would select the enclosing checkout.

The baseline test commits two deterministic rows. The candidate upgrade
codeunit transforms their values and sets a per-row marker. Verification does
not seed or repair data and must fail if rows vanished or upgrade code did not
run. The synthetic table is deliberately public as the separate test app's
contract; no blanket `internalsVisibleTo` exposure or analyzer suppression is
needed. Headless fixture tables have no UI lookup/drilldown pages.

Provision a **fresh, explicitly authorized disposable container**, its test
runner prerequisites and a dedicated company separately. Register it in the
candidate repository (not as a user default), then run:

```powershell
bc-whale -r C:\BcWhaleValidation\candidate target add upgrade-test --docker <your-disposable-container> --scope repo
bc-whale -r C:\BcWhaleValidation\candidate validate `
  --baseline-repo C:\BcWhaleValidation\baseline `
  -p BcWhaleUpgradeProbe,BcWhaleUpgradeProbeTests -t upgrade-test `
  --company BcWhaleValidation `
  --seed-codeunits 50210 --seed-methods SeedPersistentRows `
  --verify-codeunits 50210 --verify-methods VerifyPreservedData `
  --authorized-disposable-target
```

The runner must permit the seed test's `TransactionModel::AutoCommit` and
explicit `Commit`; runners that force rollback cannot prove persistence across
publishes. The candidate verification detects this instead of reporting success.
The fixture intentionally disables test permission simulation; it is not an
authorization/least-privilege test and never belongs in a customer company.

Validation on 2026-11-06: all four fixture projects compiled with CodeCop, UICop
and PTECop, zero errors/warnings; actual `listtests` found the seed and verification
methods. **Live upgrade, failure recovery and persistence have not yet been
validated on a disposable target.** Existing shared containers were not changed.
Generic on-prem/SaaS installed-version inspection and successful CPU captures
remain open, not implicitly covered by the fixture compilation.

### Debugging and profiling through official AL tools

#### First-class profiling CLI and MCP tools

No temporary capture/analysis script or separate proxy registration is required:

```powershell
# Explicitly authorize the actual NST session from Help & Support.
# SaaS targets use cached AL authentication. Containers/on-prem use the configured credentials.
bc-whale -r C:\Repos\MyApp profile schedule -t sbx --session-id 12345 --authorized-session `
  --duration-seconds 120 --sampling-interval-ms 50 --profile-creation-threshold-ms 1
# For a container/on-prem target, add --api-port with its API/OData port (e.g. 7048).

# Reproduce the slow activity in that client session during the returned capture window.
# Show the returned official nextStep to the user verbatim; do not immediately stop an unused schedule.
bc-whale -r C:\Repos\MyApp profile collect <id-returned-by-schedule>

# Existing captures need no repository, credentials, BC connection or altool.
bc-whale profile analyze C:\Profiles\capture.zip --top 10
```

The corresponding agent tools are `bc_whale_profile_schedule`, `bc_whale_profile_collect`,
and `bc_whale_profile_analyze`. Rebuild bc-whale and restart its MCP server in VS Code to
discover the new tools; existing registered `bc-whale` entries remain valid.

- `schedule` requires an explicit target, positive NST `sessionId` and
  `authorizedSession: true` (`--authorized-session`). It does not publish apps or execute workloads.
  Defaults: 300-second window (maximum 3600), 100 ms sampling (50/100/150 supported),
  200 ms activity threshold. Cloud production additionally needs `allowProduction: true`
  (`--allow-production`) on **both** schedule and collect. On-prem authorization is the caller's responsibility.
- Capture metadata is persisted under `.bc-whale/profiles/captures/<id>/capture.json`.
  Collection reuses the recorded target, API port, NST session and official schedule id.
  A changed target identity is rejected; no credentials/tokens are stored in capture metadata.
  `collect` stops the schedule immediately when explicitly invoked; call after the workload/window,
  or when early collection is intended.
- Empty results retry **only the same disabled schedule**, every 10 seconds, for up to
  180 seconds by default. They never trigger another workload or schedule. An exhausted
  deadline returns `succeeded: false`, `timedOut: true` and a recollectable capture id.
  Permission, transport, malformed-response and mismatched-identity errors are not retried.
- `--timeout-ms` / `timeoutMs` covers target/tool preparation, proxy initialization and all
  retries/analysis under one deadline; defaults are 60000 for schedule/analyze and 180000
  for collect, maximum 3600000. CLI Ctrl+C and MCP cancellation stop local work. Process
  cleanup is bounded (up to 6 seconds extra); no shared BC session is terminated.
  Cancellation during scheduling can leave an unknown remote schedule armed until its window ends.
  Capture metadata is retained for inspection; never silently reschedule an uncertain operation.
- Collection copies the ZIP out of the proxy's expiring cache before shutdown, saves
  collection metadata, and analyzes the actual profiles. Each collection has its own
  `collections/<run-id>` evidence folder; recollection never overwrites an earlier ZIP/report.
  A positive server count alone
  is insufficient: the ZIP must contain the same number of CPU profiles and nonempty samples.
  Collection has a per-capture lock; after a crash, remove a stale `collect.lock` only
  after confirming no collector is running.
- Analysis writes `<input>.analysis.json` by default, with SHA256, per-activity self/inclusive
  hotspots, SQL/HTTP overview metrics, optional **session-level** memory and readable summary.
  It excludes idle samples, labels SQL frames separately, does not double-count recursive
  identical frames in inclusive time, and warns about sparse sampling (<100 samples).
  Inclusive timings overlap; they are not wall-clock timings. Missing memory stays unavailable.
  Empty sample arrays are explicitly unsuccessful capture evidence.
- ZIP entries are analyzed in memory, never extracted as filesystem paths. Limits:
  64 MiB input/individual entry, 128 MiB expanded selected entries, 1000 CPU profiles,
  200000 nodes and 2000000 samples per profile, 512 call-tree levels; top 1..50 hotspots.
  Analysis runs in a cancellable worker, including for MCP, so parsing does not block the server.
  Raw profiles and reports can contain sensitive SQL/object/business data: keep them local.

Implementation validation (2026-11-06): 73 automated tests pass, including real stdio CLI/MCP
integration against a deterministic proxy, same-schedule retries, cancellation, initialization/
target-inspection hangs, worker cancellation and evidence preservation. The local analyzer
reproduces the previously captured real SaaS/container timings and optional container memory.
A fresh SaaS CLI schedule and synthetic workload succeeded, but collection/recollection of that
same schedule remained empty through bounded waits and correctly returned an explicit timeout.
**A fresh nonempty capture through the new wrapper is therefore not yet claimed.** Earlier
nonempty official-proxy captures are documented below; no benchmark improvement is claimed.

#### Direct official proxy registration

`bc-whale launch -t <target>` already generates standard VS Code AL debug configurations with break-on-error and SQL
diagnostics. For agentic session captures, `bc-whale debug register` / `bc_whale_debug_register` adds **two** MCP entries:
`bc-whale-profile-<repo>-<target>` and `bc-whale-snapshot-<repo>-<target>`.
Their stdio processes run the installed altool's `launchprofilingmcpproxy` and `launchsnapshotmcpproxy`.
Credentials are resolved at server startup and never written into MCP registration.
The wrapper validates command availability; restart registered servers before use.

- Profiling tools: `schedule_profiling`, `stop_schedule_and_get_profiles`, `get_profile_for_activity`,
  `analyze_profiles_in_folder`. Profiles are kept under `.bc-whale/profiles`; scheduled artifacts use the
  official proxy's default one-day retention, while its `user` folder is not auto-purged.
- Snapshot tools: `initialize_snapshot_debugging`, `get_snapshot_status`, `stop_snapshot_debugging`, `run_tests`.
  Capturing execution is distinct from standard breakpoints; use exact session ids and discover schemas first.
  Snapshot-scoped `run_tests` creates a **WebClient** session: initialize with `clientType: WebClient`.
  A WebServiceClient context is rejected for this operation. Always stop the context, including after failed tests.
- Arm profiling **before** starting the activity on a persistent session. An ephemeral `runtests` session or
  arming halfway through an activity may produce no profiles. Require `capturedActivityCount > 0` and actual
  artifacts; registration, scheduling and a zero-activity collection are not successful capture evidence.
- A first collection can be empty even after a verified workload: completed profiles may only become available
  later. Keep the original schedule/session ids, allow server-side finalization/background processing, and collect
  that same disabled schedule again. Do not automatically rerun a workload or arm another schedule just because
  the first response is empty. Report capture as pending/unverified until a nonempty artifact is available;
  investigate the target if it remains empty after a bounded wait.
- Analyze both the activity overview and the CPU samples. Exclude `IdleTime` from AL hotspot rankings, and keep
  sampled self/inclusive time separate from activity wall-clock duration. Sparse samples are capture evidence,
  not a reliable benchmark. Embedded memory estimates describe the profiled session, not the whole server process.
- On-prem proxies share the **API/OData MCP port**, not development port 7049. Supply `--api-port` where required.
- BC 2026 release wave 2+ server capabilities and appropriate permissions are required. Tool discovery alone
  does not verify a live capture. No production capture is started automatically; registration of a
  production cloud target additionally requires `--allow-production`. Obtain session authorization before any capture.
- Profiles and especially snapshots may contain sensitive business data. Keep artifacts local, stop captures you
  started, and do not upload them to third-party services. Compare before/after using the same regression workload.

Source: [Microsoft ALTool: profiling and snapshot MCP proxies](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-al-tool).

### Validation status

Runtime behavior was validated manually on isolated BC 28/29 containers (NavUserPassword and Windows
authentication) and on a BC 29 SaaS sandbox for the profiling path, using the synthetic fixtures in
`fixtures/`. Cloud build/publish/test through the Admin API, the SaaS test toolkit and upgrade lifecycle
are not yet validated. Re-run [EVALUATIONS.md](EVALUATIONS.md) against your own disposable targets.


### Typical inner loop

```powershell
bc-whale -r C:\Repos\MyApp symbols
bc-whale -r C:\Repos\MyApp build
bc-whale -r C:\Repos\MyApp container create bc-whale29 -a sandbox/29/w1 --default
bc-whale -r C:\Repos\MyApp deps --toolkit
bc-whale -r C:\Repos\MyApp cycle -p "My App"
```

## Local containers without BcContainerHelper

`bc-whale container create` runs the generic image (`mcr.microsoft.com/businesscentral:ltsc2025/ltsc2022`, matched to the
host OS) directly with `docker run`:

- the artifact (`sandbox/29/de`, `onprem/latest/w1`, `29.0.54011.55816/de`, AL-Go `/*/latest` style or a full URL) is
  resolved through the public artifact index and downloaded/extracted on the host into `C:\bcartifacts.cache` (shared);
- the admin password is passed as `securePassword` + one-time AES key file (deleted by the image after use), so it is
  never visible in `docker inspect`;
- the container gets NavUserPassword auth, http (no SSL), the dev endpoint, and is registered as a docker target.

Microsoft apps that ship with the artifact (test toolkit, other dependencies) are installed with
`bc-whale container install-apps <name> --toolkit` or `bc-whale deps`, using the management cmdlets inside the container.

Existing containers created by BcContainerHelper also work as targets. For Windows auth nothing is needed; for
NavUserPassword store the credential once: `bc-whale container credential <name> --user admin`.

## BcContainerHelper mapping

| BcContainerHelper | bc-whale |
| --- | --- |
| `New-BcContainer` | `bc-whale container create` |
| `Get-BcArtifactUrl` | `bc-whale container artifact` |
| `Start/Stop/Restart/Remove-BcContainer` | `bc-whale container start/stop/restart/remove` |
| `Compile-AppInBcContainer`, `Run-AlPipeline` (compile) | `bc-whale build` (altool workspace compile, no container needed) |
| symbol download from container | `bc-whale symbols` (global feeds) / `--from-target` |
| `Publish-BcContainerApp` | `bc-whale publish` |
| `Import-TestToolkitToBcContainer` | `bc-whale deps --toolkit` / `container install-apps --toolkit` |
| `Run-TestsInBcContainer` | `bc-whale test` |
| `Import-BcContainerLicense` | `bc-whale container license` |
| `New-BcEnvironment`, `Get-BcEnvironments`, ... | `bc-whale cloud ...` |
| `Run-AlPipeline` (local) | `bc-whale cycle` |

Not covered (out of scope for altool): database backup/restore, configuration packages, user management in containers.

## Development

```powershell
npm run build      # tsc
npm test           # build + node:test unit tests
```

Source layout: `src/repo.ts` (repo model), `config.ts`, `symbols.ts`, `build.ts`, `deploy.ts` (publish + tests),
`docker.ts`, `targets.ts`, `cloud.ts`, `workspace.ts` (versions, launch.json), `api.ts` (service layer),
`cli.ts`, `mcp.ts`.