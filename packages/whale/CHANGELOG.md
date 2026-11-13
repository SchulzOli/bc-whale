# Changelog

## 0.2.8

- Respects `COPILOT_HOME` for the Copilot CLI host file and launcher targets.
- BCQuality installs through its marketplace (`bcquality@bcquality`); direct repository installs are deprecated.

## 0.2.7

- Catalog: AL Object ID Ninja (VS Code extension) and AL Object ID Ninja MCP.
- VS Code extensions: kind `external-extension`, install with `code --install-extension`, detection and version
  from `code --list-extensions`, update tracking from the VS Code Marketplace.

## 0.2.6

- `setup`, `update`, `doctor` and `status` take tool ids: `whale setup bc-lantern` sets up only that tool.
- New setup method `command`: package-manager installs (`pipx`, `dotnet tool`, `npm --global`), skipped when
  the tool is detected and blocked with a hint when the package manager is missing. ALTool and BC Lantern use it.
- `whale update` also runs update commands of installed command-line tools.
- `whale_doctor` and `whale_status` accept `ids`.

## 0.2.5

- `status` shows CLI versions without build metadata (`17.0.34.45391` instead of `17.0.34.45391+89dd…`).

## 0.2.4

- Catalog: ALTool as a core command-line tool (`al --version`); update tracking for NuGet packages.

## 0.2.3

- `status` no longer reports `?` for repository-specific MCP servers (AL MCP), command-line tools
  (BC Lantern) and marketplaces (Awesome Copilot): new catalog field `detect` and marketplace detection.

## 0.2.2

- `setup --launchers` (guided question, `launchers` in `whale_plan`) puts the `whale` and `bc-whale`
  CLIs on PATH via launchers in npm's global folder; foreign files are never overwritten.

## 0.2.1

- Bundled catalog: oli-tech section (BC Atlas, AL Design Patterns, BC Lantern) and `external-cli` kind;
  Context7 and codebase-memory removed.
- `list`, `explain` and `whale_list` show the section.

## 0.2.0

- First release of the `whale` manager: CLI and MCP server (`whale_*` tools).
- `list`, `explain`, `doctor`, `status`, guided `setup` (plan → confirm → apply with
  backups) and `update` (GitHub/npm/PyPI release tracking, 24 h cache).
- Bundled runtime with a copy of the catalog.
