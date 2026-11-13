# whale

The manager of the [bc-whale toolkit](../../README.md): one guided CLI and one MCP
server to set up, update, check and explain every tool in the
[catalog](../../catalog.json).

```powershell
copilot plugin marketplace add SchulzOli/bc-whale
copilot plugin install whale@bc-whale
```

The plugin contributes the `whale` MCP server. The same runtime is a CLI:
`node <plugin>/runtime/cli.js` (or `whale` after `npm link` in a checkout).

## CLI

| Command | What it does |
| --- | --- |
| `whale list` | All catalog tools with kind, category and status |
| `whale explain <id>` | Purpose, access, auth, setup, update, verify, gaps, docs |
| `whale doctor` | Prerequisites: node, npx, uvx, copilot, git, docker, az |
| `whale status` | Which tools are configured, on which hosts, under which name |
| `whale setup` | Guided: profile → tools → hosts → inputs → plan → confirm → apply |
| `whale update` | Latest upstream releases; runs plugin update commands after confirmation |

Global options: `--json` (machine-readable stdout), `-r <repo>` (enables the `repo`
host), `--catalog <file>`.

Non-interactive setup:

```powershell
whale setup --profile recommended --host copilot vscode --yes
whale setup --tool azure-devops --input ORGANIZATION=contoso --host vscode --yes
whale setup --profile full --host copilot --dry-run
```

Profiles: `core` (status core), `recommended` (+ recommended), `full` (+ optional).
Experimental tools are added only with `--tool`.

## MCP tools

`whale_list`, `whale_explain`, `whale_doctor`, `whale_status`, `whale_updates` are
read-only. `whale_plan` returns steps and a `planHash`; `whale_apply` needs that hash
and refuses plans it did not issue or that changed since. Agents must show the plan
and get approval first; `confirmCommands` covers the `copilot plugin` commands.

## Safety

- Hosts: Copilot CLI `~/.copilot/mcp-config.json` (`mcpServers`), VS Code user
  `mcp.json` and repository `.vscode/mcp.json` (`servers`).
- Only the named entry is added, or its server fields (`type`, `command`, `args`, `url`)
  updated; its `env`, `headers`, `tools` and other entries and JSONC comments stay.
  Each changed file is copied once per run to `<file>.whale-<timestamp>.bak` (never overwritten).
- Tools already configured under another name (same URL or command) are left alone.
- Only `copilot plugin ...` commands from the catalog run; the validator enforces it.
- No credentials are written. Inputs are plain identifiers such as an organization.
- Update checks query GitHub releases, npm and PyPI; results are cached for 24 hours
  in `~/.bc-whale/whale-state.json` (`BC_WHALE_HOME` overrides the folder). Set
  `GITHUB_TOKEN` to avoid GitHub rate limits.

The AL MCP server is repository-specific and stays a manual step
(`bc-whale mcp register --almcp --repo <path>`).

## Develop

```powershell
npm ci --ignore-scripts
npm test
```

Regenerate the bundled `runtime/` (including the catalog copy) with `npm run build`
at the repository root.
