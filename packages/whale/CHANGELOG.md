# Changelog

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
