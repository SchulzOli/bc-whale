# Tool contract (v2)

Every tool in [catalog.json](../catalog.json) is described the same way, so the
`whale` manager (and any agent) can set it up, update it, check it and explain it
without tool-specific code. `npm run validate` enforces this contract;
[catalog.schema.json](../catalog.schema.json) gives editors completion.

## Fields

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | always | Stable kebab-case identity. Never reuse a removed id. |
| `kind` | always | `internal-plugin` (our code) or `external-plugin`, `external-marketplace`, `external-mcp`. |
| `category` | always | `management`, `al-lifecycle`, `bc-data`, `quality`, `knowledge`, `devops`, `azure`, `testing`, `workflow`. |
| `status` | always | `core`, `recommended`, `optional`, `experimental`, `planned`. Drives setup profiles. |
| `owner` | always | Accountable publisher or maintainer, never a credential. |
| `description` | always | One sentence: what an agent uses it for. |
| `documentation` | always | HTTPS link or repository-relative path. |
| `access` | always | Worst case: `read-only`, `read-write`, `destructive`. |
| `auth` | always | `none`, `host-oauth`, `host-credentials`, `api-key-env`, `azure-cli`. |
| `source` | external | HTTPS upstream (repository or product page). |
| `path` | own, not planned | Repository-relative package folder. |
| `setup` | unless `mcp` | `method` (`copilot-plugin`, `mcp-local`, `manual`) plus `commands` or `note`. Commands must be `copilot plugin ...`; `whale` runs them. |
| `mcp` | unless `setup` | Host-neutral MCP definition: `stdio` (`command`, `args`) or `http` (`url`, HTTPS). |
| `inputs` | when used | `UPPER_CASE` placeholders referenced as `{{NAME}}` in `mcp`. |
| `update` | not planned | `commands` or `description` of how the tool is updated. |
| `verify` | not planned | A read-only check that proves the tool works. |
| `prerequisites` | optional | Runtimes or tools that must exist first. |
| `gaps` | optional | What the tool does not cover and which tool fills it. |

Unknown fields are rejected. `planned` entries only need the always-required fields.

## Rules for third-party tools

1. **Link, do not copy.** No vendored code, forks or rebranded wrappers. If the
   publisher ships a plugin, reference it instead of an MCP definition.
2. **No secrets.** `mcp` must not contain headers, tokens or keys. Use host OAuth or
   documented environment variables.
3. **Portable.** No absolute or machine-specific paths. Repository-specific servers
   (such as the AL MCP) use `setup.method: mcp-local` with a note.
4. **Verify is read-only.** Never mutate business data, create environments or
   publish apps as a health check.
5. **Declare the worst case** in `access`, and record overlaps in `gaps`.

## Rules for own tools

1. Live in `packages/<id>/` with `plugin.json` (Agent Plugins 1.0, SemVer, author),
   `README.md`, `CHANGELOG.md` and `EVALUATIONS.md` with a repeatable smoke test.
2. Ship at least one capability: `mcp.json` at the package root and/or
   `skills/<name>/SKILL.md` (name matches the folder). Copilot agents go in
   `com.github.copilot/agents/*.agent.md`.
3. Reference packaged files through `${PLUGIN_ROOT}`; ship a self-contained runtime
   so users never run `npm install`.
4. **Fill gaps, do not duplicate.** Before adding a capability, check whether a
   catalog tool already covers it and record the gap you fill.
5. Bump `plugin.json`, `package.json` and `.github/plugin/marketplace.json`
   versions together; document breaking changes and rollback in the changelog.

## Adding a tool

1. Add the entry to `catalog.json` and a row to the README table.
2. Run `npm run verify`.
3. Open a pull request. Review checks ownership, access, auth, setup and the verify step.
