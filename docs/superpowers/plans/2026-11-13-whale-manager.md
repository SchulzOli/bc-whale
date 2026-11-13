# whale manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** A guided CLI and MCP server, `whale`, that lists, checks, sets up, updates and explains every tool in `catalog.json`.

**Architecture:** New package `packages/whale` (TypeScript, ESM). A pure core (catalog → status → plan → apply) is shared by a CLI and an MCP server, mirroring `packages/bc-whale` (`api.ts` core, `cli.ts`, `mcp.ts`). Host adapters merge entries into MCP config files; plugin installs delegate to `copilot plugin`.

**Tech Stack:** Node.js 22+, TypeScript, `@modelcontextprotocol/sdk`, `zod`, `commander`, `jsonc-parser`, `node:test`, esbuild bundle via `scripts/build.mjs`.

**Status:** implemented in 0.2.0 (`217b9b3`); evaluation run on an isolated home on 2026-11-13.

**Spec:** [docs/superpowers/specs/2026-11-13-bc-whale-design.md](../specs/2026-11-13-bc-whale-design.md)

## Global Constraints

- Node.js `>=22`; ESM; no install-time scripts; bundled `runtime/` committed like `packages/bc-whale`.
- MCP server id `whale`; MCP tool names `whale_*`; CLI binary `whale`; state file `~/.bc-whale/whale-state.json` (override with env `BC_WHALE_HOME`).
- Host files: Copilot CLI `~/.copilot/mcp-config.json` root `mcpServers` (entry `{ type: "local"|"http", ... , tools: ["*"] }`); VS Code user `mcp.json` and repo `.vscode/mcp.json` root `servers` (entry `{ type: "stdio"|"http", ... }`).
- Never delete or rewrite foreign entries; JSONC comments preserved (`jsonc-parser` edits); backup `<file>.whale-<yyyyMMddHHmmss>.bak` before each write.
- `apply` requires the `planHash` (sha256 of the canonical plan JSON) returned by `plan`.
- Profiles: `core` = status core; `recommended` = core + recommended; `full` = + optional. `experimental` and `planned` only by explicit id.
- No secrets written anywhere; `inputs` values are plain non-secret identifiers (e.g. organization).

## Review Focus

- Host file missing or empty → created with the right root key, no backup needed.
- Host file with comments/trailing commas (JSONC) → edit preserves them.
- Entry already present with different content → plan shows `update`, not a duplicate; identical → `unchanged`.
- Missing `inputs` value in non-interactive mode → plan fails with the input name, nothing written.
- `copilot` CLI not on PATH → plugin steps reported `blocked` with reason; MCP steps still apply.

---

### Task 1: Package scaffold and catalog loader

**Files:**
- Create: `packages/whale/{package.json,tsconfig.json,plugin.json,mcp.json,README.md,CHANGELOG.md,EVALUATIONS.md}`
- Create: `packages/whale/src/catalog.ts`, `packages/whale/src/catalog.test.ts`
- Modify: `scripts/build.mjs` (build every non-planned internal package), `catalog.json` (`whale`: status `experimental`, `path`, `setup`, `update`, `verify`), `.github/plugin/marketplace.json`, CI cache paths

**Interfaces:**
- Produces: `type Tool` (mirrors `catalog.schema.json`), `loadCatalog(file?: string): Catalog`, `selectTools(catalog, { profile?: "core"|"recommended"|"full", ids?: string[] }): Tool[]` — throws `Unknown tool: <id>`.

- [x] **Step 1:** Test `selectTools` — `core` returns exactly `["bc-whale","al-mcp","microsoft-learn"]` from the real catalog; `recommended` adds `bcquality`,`al-design-patterns`,`github`; ids `["graph"]` throws `Unknown tool: graph`; `planned` never selected by profile.
- [x] **Step 2:** Run `npm --prefix packages/whale test` → FAIL.
- [x] **Step 3:** Implement; `loadCatalog` defaults to the catalog copied into `runtime/` at build time (build script copies `catalog.json`).
- [x] **Step 4:** Run tests → PASS; `npm run verify` at root → PASS.
- [x] **Step 5:** Commit `feat(whale): scaffold package and catalog loader`.

### Task 2: Host adapters

**Files:** Create `packages/whale/src/hosts.ts`, `hosts.test.ts`

**Interfaces:**
- Produces: `type HostId = "copilot"|"vscode"|"repo"`; `hostFile(host: HostId, opts: { home?: string; repo?: string }): string`; `renderEntry(host, tool: Tool, inputs: Record<string,string>): object` (substitutes `{{NAME}}`, throws `Missing input <NAME> for <id>`); `readEntries(file): Record<string, object>`; `mergeEntry(file, host, name, entry): "created"|"updated"|"unchanged"` (writes backup when the file existed and content changes).

- [x] **Step 1:** Tests on a temp dir: copilot render of `microsoft-learn` → `{ type: "http", url: "https://learn.microsoft.com/api/mcp", tools: ["*"] }`; vscode render of `playwright` → `{ type: "stdio", command: "npx", args: ["@playwright/mcp@latest"] }`; JSONC file with a comment keeps the comment after merge; second identical merge returns `unchanged` and writes no backup; foreign entry `other` survives.
- [x] **Step 2:** Run → FAIL. **Step 3:** Implement with `jsonc-parser` `modify`/`applyEdits`. **Step 4:** Run → PASS.
- [x] **Step 5:** Commit `feat(whale): host config adapters`.

### Task 3: Doctor and status

**Files:** Create `packages/whale/src/status.ts`, `status.test.ts`, `exec.ts` (spawn helper with timeout, injectable for tests)

**Interfaces:**
- Produces: `doctor(): Promise<Prerequisite[]>` (`node`, `npx`, `uvx`, `copilot`, `al`/altool, `docker`, `az` → `{ name, found, version? }`); `status(opts): Promise<ToolStatus[]>` with `ToolStatus = { id, installed: boolean, hosts: HostId[], via: "mcp"|"plugin"|"unknown" }`. Plugins detected by parsing `copilot plugin list`; MCP entries matched by catalog id or identical command/url.

- [x] **Step 1:** Tests with a fake exec: `copilot` missing → plugins report `via: "unknown"`; a copilot config containing `microsoftdocs/mcp` with the Learn URL marks `microsoft-learn` installed on `copilot` (match by URL, not name).
- [x] **Step 2–4:** FAIL → implement → PASS.
- [x] **Step 5:** Commit `feat(whale): doctor and status`.

### Task 4: Plan and apply

**Files:** Create `packages/whale/src/plan.ts`, `plan.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `type Step = { tool: string; kind: "mcp"|"command"|"manual"; host?: HostId; file?: string; action: "create"|"update"|"unchanged"|"run"|"blocked"|"manual"; detail: string }`; `plan(opts: { tools: Tool[]; hosts: HostId[]; inputs: Record<string,string>; home?; repo? }): Promise<{ steps: Step[]; planHash: string }>`; `apply(plan, planHash, { confirmCommands: boolean }): Promise<StepResult[]>` — throws `Plan changed; re-run plan` on hash mismatch.

- [x] **Step 1:** Tests: `al-mcp` yields `manual` with the `bc-whale mcp register --almcp` note; `bcquality` yields `run` steps from `setup.commands`, `blocked` when `copilot` is missing; apply with a wrong hash throws and writes nothing; `confirmCommands: false` skips `run` steps but applies MCP merges.
- [x] **Step 2–4:** FAIL → implement (hash over steps with sorted keys) → PASS.
- [x] **Step 5:** Commit `feat(whale): plan and apply`.

### Task 5: Update tracking

**Files:** Create `packages/whale/src/updates.ts`, `updates.test.ts`, `state.ts`

**Interfaces:**
- Produces: `checkUpdates(tools, { fetch?: typeof fetch; now?: Date }): Promise<UpdateInfo[]>` with `UpdateInfo = { id, source: "github"|"npm"|"pypi"|"none", latest?: string, publishedAt?: string, url?: string }`. GitHub: `GET https://api.github.com/repos/<owner>/<repo>/releases/latest` (uses `GITHUB_TOKEN` env when set); npm: `https://registry.npmjs.org/<pkg>/latest`; PyPI: `https://pypi.org/pypi/<pkg>/json`. Cache in state for 24 h.
- [x] **Step 1:** Tests with stubbed fetch: npm package parsed from `args` (`@playwright/mcp@latest` → `@playwright/mcp`); 404 on releases → `source: "github"` without `latest`, no throw; cached result within 24 h makes no request.
- [x] **Step 2–4:** FAIL → implement → PASS.
- [x] **Step 5:** Commit `feat(whale): upstream update tracking`.

### Task 6: CLI with guided setup

**Files:** Create `packages/whale/src/cli.ts`, `cli.test.ts`, `prompt.ts`

**Interfaces:** Commands `list [--json]`, `doctor`, `status`, `explain <id>` (description, access, auth, setup, verify, gaps, docs), `setup [--profile p] [--tool id...] [--host h...] [--input K=V...] [--yes] [--dry-run]`, `update [--check]`. Without `--yes`, `setup` asks profile → tools (pre-selected by profile) → hosts → missing inputs → shows the plan → confirms MCP writes → confirms commands separately. JSON to stdout with `--json`, prompts on stderr.

- [x] **Step 1:** Tests spawn the built CLI: `setup --profile core --host vscode --yes --dry-run` prints steps and writes nothing; `setup --tool azure-devops --host vscode --yes` without `--input ORGANIZATION=x` exits 1 with `Missing input ORGANIZATION`.
- [x] **Step 2–4:** FAIL → implement (`prompt.ts` on `node:readline/promises`) → PASS.
- [x] **Step 5:** Commit `feat(whale): guided CLI`.

### Task 7: MCP server

**Files:** Create `packages/whale/src/mcp.ts`, `mcp.test.ts`

**Interfaces:** Tools `whale_list`, `whale_explain {id}`, `whale_doctor`, `whale_status`, `whale_plan {profile?, tools?, hosts, inputs?}`, `whale_apply {planHash, confirmCommands}` (re-plans with stored arguments, rejects mismatches), `whale_updates {ids?}`. All read-only except `whale_apply` (annotated `destructiveHint: false`, `idempotentHint: true`).

- [x] **Step 1:** Test via SDK stdio client against `runtime/mcp.js`: lists 7 tools; `whale_apply` with a random hash returns an error and writes nothing.
- [x] **Step 2–4:** FAIL → implement → PASS.
- [x] **Step 5:** Commit `feat(whale): MCP server`.

### Task 8: Package, document, release 0.2.0

**Files:** Modify root `README.md` (quick start via `whale setup`), `docs/ROADMAP.md`, `catalog.json` (`whale` status `core`), versions in `packages/whale/{package.json,plugin.json}` and marketplace; extend `tests/catalog.test.mjs` packaged-runtime test to launch `packages/whale/runtime/mcp.js` without `node_modules`.

- [x] **Step 1:** Packaged-runtime test fails before build; `npm run verify` → PASS after.
- [x] **Step 2:** Manual evaluation in `packages/whale/EVALUATIONS.md`: fresh profile on a temp `HOME`, `whale setup --profile recommended`, restart host, every selected tool's `verify` passes.
- [x] **Step 3:** Commit `feat(whale): release 0.2.0`.

## Implementation notes

Changes beyond the plan, decided during implementation and review:

- Updating an existing entry changes only whale-owned fields (`type`, `command`, `args`, `url`); `env`, `headers`, `tools` stay. Entries equivalent to the catalog server (same URL or command, `{{INPUT}}` as wildcard) are `unchanged` under any name.
- One backup per file per run, never overwritten (`COPYFILE_EXCL`, counter suffix).
- Shared `copilot plugin` commands (e.g. the marketplace add for `whale` and `bc-whale`) run once; a failed command skips later commands of the same tool.
- The validator restricts catalog `setup`/`update` commands to `copilot plugin ...`, because `whale` executes them.
- `external-cli` tools (e.g. BC Lantern) produce `manual` steps with their install note.