# bc-whale design

Date: 2026-11-13 · Status: proposed (autopilot decisions marked *call*)

## Intent

One open-source home for the agent tools used in Business Central development.
Today each tool (official AL MCP, BC Online MCP, BCQuality, Learn, GitHub, Azure, own
tools) has its own install path, auth model and update cadence; staying current is
manual and the overview lives in people's heads. bc-whale wraps them: a strict
catalog, own tools only where others leave gaps, and a manager that an agent or a
human uses to set up, update and understand everything.

## Goals

- A **strict, machine-readable contract** for every tool (setup, update, verify,
  auth, access, gaps) — [docs/CONTRACT.md](../../CONTRACT.md).
- **Own tools fill gaps.** `bc_whale` (formerly an internal AL dev-loop MCP) is the
  first; it can split into several plugins later.
- A **`whale` manager**: guided CLI setup plus an MCP server with the same
  capabilities, so an agent can manage its own toolset.
- **Stay in the loop:** show what is installed, what is outdated and what changed upstream.
- **Open-source ready** from the first commit: MIT, no company names, no internal
  environments, no secrets; private now, public later.

## Non-goals

- Re-implementing, forking or redistributing third-party tools.
- A background service, MCP gateway or proxy between the agent and other servers.
- Replacing the Copilot clients' native plugin lifecycle (`copilot plugin ...`).
- Managing BC credentials; hosts and existing tools keep owning auth.

## Anti-goals (failure even if it works)

- Overwriting or silently changing a user's MCP host configuration.
- Running destructive or business-data operations as part of setup or a health check.
- A catalog that drifts into marketing: entries without a working verify step.

## Constraints

- Node.js 22+, TypeScript, ESM; one self-contained bundled runtime per own plugin
  (esbuild), so users never run `npm install`.
- Agent Plugins 1.0 manifests; marketplace at `.github/plugin/marketplace.json`.
- Hosts: Copilot CLI (`~/.copilot/mcp-config.json`, root `mcpServers`), VS Code user
  `mcp.json` and repository `.vscode/mcp.json` (root `servers`).
- Windows first-class (BC tooling is Windows-heavy); Linux/macOS for everything that
  does not need Docker Windows containers.

## Approaches considered (manager)

1. **Catalog-driven manager inside this repo** (*chosen*). `whale` reads
   `catalog.json`, plans host config changes, applies them after confirmation and
   delegates plugin installs to `copilot plugin`. One contract, no per-tool code.
2. **Extend `bc_whale`'s existing `mcp register`.** Fastest, but mixes the AL
   life-cycle server with toolset management and makes splitting `bc_whale` harder.
3. **Only documentation + JSON templates.** Lowest effort; fails the goal of an agent
   managing its own setup and of update tracking.

## Decisions

- Repository `SchulzOli/bc-whale`, private until phase 4. *call*
- Names: umbrella and repo **bc-whale**; manager **`whale`** (CLI + MCP server id
  `whale`); own AL tool package **`bc-whale`**, MCP server id **`bc_whale`**, tools
  `bc_whale_*`, env `BC_WHALE_*`, repo config `.bc-whale/` + `bc-whale.json`. *call*
- Catalog contract v2 adds `category`, `status`, `access`, `auth`, `setup`/`mcp`,
  `update`, `verify`, `inputs`, `gaps`; validator rejects unknown fields,
  credentials in MCP definitions and machine-specific paths.
- Setup profiles derive from `status`: `core` ⊂ `recommended` ⊂ `full`
  (adds `optional`); `experimental` is opt-in per tool. *call*
- Manager changes are **plan → confirm → apply**: a plan lists every file edit and
  command; apply requires the plan's hash, writes a timestamped backup next to every
  edited host file and only merges entries (never deletes foreign ones).
- Plugin installs/updates run the catalog's `copilot plugin` commands only after
  explicit confirmation; the MCP `whale_apply` tool requires the hash from
  `whale_plan` so an agent cannot apply an unseen plan.
- Update tracking: GitHub releases for `github.com` sources, npm registry for `npx`
  packages, PyPI for `uvx` packages; results cached in `~/.bc-whale/whale-state.json`.
- AL MCP stays repository-specific; `whale` delegates to `bc-whale mcp register --almcp`.
- Tests: `node:test` like the existing package; host config tests run on temp folders.

## Left to the builder

- Prompt library for the guided CLI (plain `node:readline/promises` preferred to
  keep the runtime dependency-free).
- Exact output formatting of `whale status` / `whale list` tables.
- Cache TTL for upstream checks (suggest 24 h).
