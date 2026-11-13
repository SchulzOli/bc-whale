# bc-whale 🐋

**Business Central Agentic Engineering Tools** — one place to set up, update and
understand the agent tools you use for Business Central development.

The agentic BC ecosystem moves fast: official Microsoft MCP servers, community
plugins, skills and marketplaces each have their own install path, auth model and
update cadence. bc-whale is the wrapper around all of it:

- a **strict catalog** of every tool, with setup, update, verification, auth and
  access declared the same way for each one;
- **own tools** that fill the gaps the others leave open, starting with the
  `bc_whale` MCP server for the AL development life cycle;
- a planned **`whale` manager** (guided CLI + MCP server) so an agent or a human can
  install, update, check and explain the whole toolset from one entry point.

> Status: early. The catalog and `bc_whale` work today; the `whale` manager is
> planned — see the [roadmap](docs/ROADMAP.md).

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
| `whale` | own | management | planned | Guided setup, update and overview of everything below |
| [`bc-whale`](packages/bc-whale/README.md) | own | AL lifecycle | core | Symbols, multi-app build, publish, test, containers, cloud sandboxes, diagnostics evidence, profiling |
| [AL MCP](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/al-agent-tools/al-mcp-server) | MCP | AL lifecycle | core | Official symbol search, relations, diagnostics, compile |
| [Microsoft Learn](https://learn.microsoft.com/en-us/training/support/mcp) | MCP | knowledge | core | Official docs and code samples |
| [BCQuality](https://github.com/microsoft/BCQuality) | plugin | quality | recommended | BC quality rules, AL code review, knowledge skills |
| [AL Design Patterns](https://github.com/SchulzOli/ALDesignPatterns) | MCP | knowledge | recommended | Search, compare and recommend AL design patterns |
| [GitHub](https://github.com/github/github-mcp-server) | MCP | devops | recommended | Repos, PRs, issues, AL-Go Actions |
| [Business Central](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/ai/use-mcp-server-in-vscode) | MCP | BC data | optional | BC Online business data and API actions |
| [Azure DevOps](https://github.com/microsoft/azure-devops-mcp) | MCP | devops | optional | Boards, repos, pipelines, test plans |
| [Azure MCP](https://github.com/microsoft/mcp) | MCP | azure | optional | App Insights (BC telemetry), Key Vault, storage |
| [Azure Skills](https://github.com/microsoft/azure-skills) | plugin | azure | optional | Azure agent skills |
| [Playwright](https://github.com/microsoft/playwright-mcp) | MCP | testing | optional | BC web client UI automation |
| [Context7](https://github.com/upstash/context7) | MCP | knowledge | optional | Library docs for non-AL tooling |
| [codebase-memory](https://github.com/DeusData/codebase-memory-mcp) | MCP | knowledge | optional | Code knowledge graph |
| [MarkItDown](https://github.com/microsoft/markitdown) | MCP | knowledge | optional | Specs and Office docs to Markdown |
| [Awesome Copilot](https://github.com/github/awesome-copilot) | marketplace | workflow | optional | Community plugins — pick individually |
| [Superpowers](https://github.com/obra/superpowers) | plugin | workflow | optional | Brainstorm, plan, TDD, debug, review workflows |
| [Graph Enterprise](https://learn.microsoft.com/en-us/graph/mcp-server/overview) | MCP | azure | experimental | Read-only directory queries (preview) |

## Quick start (today)

Requires a Copilot client with Agent Plugins 1.0 support and Node.js 22+.

```powershell
copilot plugin marketplace add SchulzOli/bc-whale
copilot plugin install bc-whale@bc-whale
```

For third-party tools, follow the `setup` / `mcp` block of their entry in
[catalog.json](catalog.json) until `whale setup` automates it.

## Develop

```powershell
npm ci --ignore-scripts
npm --prefix packages/bc-whale ci --ignore-scripts
npm run verify
```

`build` regenerates the committed, self-contained `packages/bc-whale/runtime/`;
`validate` enforces the catalog contract; `test` checks the contract and launches
the packaged MCP/CLI without `node_modules`. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Third-party tools listed in the catalog are owned and licensed by
their publishers; bc-whale only links to them.
