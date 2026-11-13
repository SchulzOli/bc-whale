# bc-whale <img width="50" height="50" alt="bc-whale-icon" src="https://github.com/user-attachments/assets/0f522095-dfe7-4583-b19f-0bf4976f6701" />

**Business Central Agentic Engineering Tools** — one place to set up, update and
understand the agent tools you use for Business Central development.

The agentic BC ecosystem moves fast: official Microsoft MCP servers, community
plugins, skills and marketplaces each have their own install path, auth model and
update cadence. bc-whale is the wrapper around all of it:

- a **strict catalog** of every tool, with setup, update, verification, auth and
  access declared the same way for each one;
- **own tools** that fill the gaps the others leave open, starting with the
  `bc_whale` MCP server for the AL development life cycle;
- the **`whale` manager** (guided CLI + MCP server) so an agent or a human can
  install, update, check and explain the whole toolset from one entry point.

> Status: early (0.x). See the [roadmap](docs/ROADMAP.md).

## Two kinds of tools

| Kind | What we ship | Rule |
| --- | --- | --- |
| **Own** (`internal-plugin`) | Code in [`packages/`](packages/) | Wrap and fill gaps; never re-implement what an upstream tool already does well. |
| **Third-party** (`external-*`) | A catalog entry only | Link, never copy, fork or rebrand. Setup/update/verify follow the publisher. |

The full contract is in [docs/CONTRACT.md](docs/CONTRACT.md); the machine-readable
list is [catalog.json](catalog.json) (schema: [catalog.schema.json](catalog.schema.json)).

## The toolset

| Tool | Kind | Category | Status | What it is for |
| --- | --- | --- | --- | --- |
| [`whale`](packages/whale/README.md) | own | management | core | Guided setup, update and overview of everything below |
| [`bc-whale`](packages/bc-whale/README.md) | own | AL lifecycle | core | Symbols, multi-app build, publish, test, cross-app call graph, containers, cloud sandboxes, diagnostics evidence, profiling |
| [ALTool](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-al-tool) | CLI | AL lifecycle | core | Compiler, workspace build, test runner, call graph; base of the AL MCP and bc-whale |
| [AL MCP](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/al-agent-tools/al-mcp-server) | MCP | AL lifecycle | core | Official symbol search, relations, diagnostics, compile |
| [AL Object ID Ninja](https://alid.ninja/) | VS Code extension | AL lifecycle | recommended | Collision-free object IDs for teams |
| [AL Object ID Ninja MCP](https://alguidelines.dev/docs/agentic-coding/communityresources/tools/al-objid-mcp-server/) | MCP | AL lifecycle | experimental | Agents allocate object IDs (upstream archived) |
| [Microsoft Learn](https://learn.microsoft.com/en-us/training/support/mcp) | MCP | knowledge | core | Official docs and code samples |
| [BCQuality](https://github.com/microsoft/BCQuality) | plugin | quality | recommended | BC quality rules, AL code review, knowledge skills |
| [GitHub](https://github.com/github/github-mcp-server) | MCP | devops | recommended | Repos, PRs, issues, AL-Go Actions |
| [Business Central](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/ai/use-mcp-server-in-vscode) | MCP | BC data | optional | BC Online business data and API actions |
| [Azure DevOps](https://github.com/microsoft/azure-devops-mcp) | MCP | devops | optional | Boards, repos, pipelines, test plans |
| [Azure MCP](https://github.com/microsoft/mcp) | MCP | azure | optional | App Insights (BC telemetry), Key Vault, storage |
| [Azure Skills](https://github.com/microsoft/azure-skills) | plugin | azure | optional | Azure agent skills |
| [Playwright](https://github.com/microsoft/playwright-mcp) | MCP | testing | optional | BC web client UI automation |
| [MarkItDown](https://github.com/microsoft/markitdown) | MCP | knowledge | optional | Specs and Office docs to Markdown |
| [Awesome Copilot](https://github.com/github/awesome-copilot) | marketplace | workflow | optional | Community plugins — pick individually |
| [Superpowers](https://github.com/obra/superpowers) | plugin | workflow | optional | Brainstorm, plan, TDD, debug, review workflows |
| [Graph Enterprise](https://learn.microsoft.com/en-us/graph/mcp-server/overview) | MCP | azure | experimental | Read-only directory queries (preview) |

### oli-tech

Tools by the bc-whale author, maintained in their own repositories and wired in like
any other third-party tool (`"section": "oli-tech"` in the catalog).

| Tool | Kind | Category | Status | What it is for |
| --- | --- | --- | --- | --- |
| [BC Atlas](https://github.com/SchulzOli/BC-Atlas) | MCP + CLI + VS Code | quality | recommended | Architecture diagrams, dependency views, health checks and docs from AL source |
| [AL Design Patterns](https://github.com/SchulzOli/ALDesignPatterns) | MCP + CLI | knowledge | recommended | Search, compare and recommend AL design patterns |
| [BC Lantern](https://github.com/SchulzOli/bc-lantern) | CLI | devops | optional | Collect app.json manifests across GitHub and report object-range usage and conflicts |

## Quick start

Requires a Copilot client with Agent Plugins 1.0 support and Node.js 22+.

```powershell
copilot plugin marketplace add SchulzOli/bc-whale
copilot plugin install whale@bc-whale
```

Copilot plugins register MCP servers but do not put commands on PATH. To use the CLIs
in a terminal, let whale add launchers (they follow plugin updates):

```powershell
node "$env:USERPROFILE\.copilot\installed-plugins\bc-whale\whale\runtime\cli.js" setup --tool whale bc-whale --launchers
```

Then ask your agent to "set up the full Business Central toolset with whale",
or use the CLI:

```powershell
whale doctor                    # prerequisites
whale setup                     # guided: profile, tools, hosts, plan, confirm
whale setup bc-lantern          # only this tool; skipped when already installed
whale status                    # what is configured where
whale update --check            # latest upstream releases
```

## Setup smoke

The [Setup smoke](.github/workflows/smoke.yml) workflow runs nightly, on every push and pull request,
on Windows and Linux. It does what a new customer does: on a fresh profile it installs the **full**
profile with `whale setup`, then checks that every tool reports as installed, every MCP server starts
(including those inside the installed plugins and the AL MCP), and every update source and upstream
repository answers. VS Code extensions are skipped on hosted runners. Run it locally as a plan only:

```powershell
node scripts/smoke.mjs --allow-blocked copilot,code
```

`--install` really installs, into a temporary profile with `COPILOT_HOME` pointing there.

## Develop

```powershell
npm ci --ignore-scripts
npm --prefix packages/bc-whale ci --ignore-scripts
npm --prefix packages/whale ci --ignore-scripts
npm run verify
```

`build` regenerates the committed, self-contained `runtime/` folders of both packages;
`validate` enforces the catalog contract; `test` checks the contract and launches
the packaged MCP/CLI without `node_modules`. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Third-party tools listed in the catalog are owned and licensed by
their publishers; bc-whale only links to them.
