# Security policy

Please report vulnerabilities privately through
[GitHub security advisories](https://github.com/SchulzOli/bc-whale/security/advisories/new)
rather than public issues.

bc-whale can publish apps, create and delete containers and cloud sandboxes, and write
MCP host configuration. Treat it like any tool with deployment rights:

- It never stores passwords in files; container credentials use Windows DPAPI and
  on-prem passwords come from environment variables.
- Catalog entries must not contain credentials; `npm run validate` rejects MCP headers.
- Vulnerabilities in third-party tools belong to their publishers; links are in
  [catalog.json](catalog.json).
